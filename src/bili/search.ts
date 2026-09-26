/**
 * 视频 / UP 主搜索。
 *
 * 两个接口共用 /x/web-interface/wbi/search/type，仅 search_type 不同：
 *   video     -> 视频搜索
 *   bili_user -> UP 主搜索
 * 都需要 WBI 签名；wbiGet 内部已做「签名失效 -> 刷新密钥重试」。
 */

import type { Env, Paged, VideoBrief } from '../types';
import { wbiGet } from '../lib/wbi';
import {
  normalizeUrl,
  parseDurationText,
  spaceUrl,
  stripHtml,
  toInt,
  videoUrl,
} from '../lib/parse';
import { badRequest, biliCodeToStatus, BiliError } from '../lib/errors';

export interface SearchOptions {
  /** 页码，默认 1 */
  page?: number;
  /** 每页条数，默认 20 */
  pageSize?: number;
  /** 排序：'totalrank'(综合，默认) | 'click'(播放) | 'pubdate'(最新) | 'danmaku' | 'stow' */
  order?: string;
}

/** UP 主搜索结果（本模块自有类型） */
export interface SearchedUser {
  mid: number;
  name: string;
  face: string;
  sign: string;
  fans: number;
  videos: number;
  level: number;
  url: string;
}

/* ------------------------------------------------------------------ *
 * 上游原始结构
 * ------------------------------------------------------------------ */

interface RawVideoSearchItem {
  bvid?: string;
  bv_id?: string;
  aid?: number;
  title?: string;
  pic?: string;
  /** 注意：搜索接口返回的时长是 "12:34" 这类字符串，不是秒数 */
  duration?: string | number;
  play?: number;
  video_review?: number;
  author?: string;
  mid?: number;
  pubdate?: number;
}

interface RawUserSearchItem {
  mid?: number;
  uname?: string;
  upic?: string;
  usign?: string;
  fans?: number;
  videos?: number;
  level?: number;
  is_up?: number;
}

interface RawSearchResult<T> {
  /** 上游实际字段名是单数 result（历史遗留），这里同时兼容复数与 list */
  result?: Array<T | null> | null;
  results?: Array<T | null> | null;
  list?: Array<T | null> | null;
  /** 总条数：通常在这里 */
  numResults?: number;
  /** 总页数：备用 */
  numPages?: number;
  /** 某些代理层会把页信息 / 总数塞进 page 字段 */
  page?: unknown;
  total?: number;
  /**
   * 风控验证凭证。出现它说明 B 站拒绝了本次搜索并要求风控校验
   * （UP 主搜索在未登录时高概率命中），此时响应里没有 result 字段。
   */
  v_voucher?: string;
  /** 部分风控应答里的提示文案 */
  gaia_msg?: string;
}

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

const SEARCH_PATH = '/x/web-interface/wbi/search/type';
const SEARCH_REFERER = 'https://search.bilibili.com/';
/** 综合排序 */
const DEFAULT_ORDER = 'totalrank';

/**
 * 识别并拦截风控应答。
 *
 * 为什么必须显式报错：B 站在风控时会返回 `code=0` 但 data 里只有 `v_voucher`，
 * 没有任何 result 字段。若直接按「空结果」处理，调用方会拿到一个**看起来成功
 * 的空列表**——这是最坏的一种结果（静默给出错误答案）。所以这里直接把
 * 它转成一个明确的 BiliError。
 *
 * 判定条件：既没有结果数组，也没有 numResults（真正的「无匹配」会返回
 * `result: []` 且 numResults=0，不会走到这里）。
 */
function assertNotRiskControlled(
  data: RawSearchResult<unknown> | null | undefined,
  label: string,
): void {
  const hasArray =
    Array.isArray(data?.result) || Array.isArray(data?.results) || Array.isArray(data?.list);
  const hasTotal = typeof data?.numResults === 'number' || typeof data?.total === 'number';
  if (hasArray || hasTotal) return;

  const voucher = typeof data?.v_voucher === 'string' && data.v_voucher.length > 0;
  if (voucher) {
    throw new BiliError(
      `B 站要求风控验证（${label}响应仅含 v_voucher，未返回结果集）。未登录状态下搜索接口容易被拦截，请在服务端配置 BILI_COOKIE（登录态 Cookie）后重试。`,
      { code: -412, status: biliCodeToStatus(-412), detail: { v_voucher: true } },
    );
  }

  throw new BiliError(
    `搜索接口返回了不含结果集的异常响应，疑似被 B 站风控拦截（${label}）。请稍后重试，或在服务端配置 BILI_COOKIE。`,
    { code: -412, status: biliCodeToStatus(-412) },
  );
}

// 时长解析统一走 src/lib/parse.ts 的 parseDurationText（搜索接口的 duration 是 "MM:SS" 文本）

/**
 * 取搜索总条数。
 * 优先 numResults，其次 total，最后尝试 data.page.{total,count,numResults}；
 * 全部拿不到时退回当前页条数。
 */
function pickTotal(envelope: RawSearchResult<unknown> | null | undefined, fallback: number): number {
  if (!envelope) return fallback;
  if (typeof envelope.numResults === 'number') return toInt(envelope.numResults);
  if (typeof envelope.total === 'number') return toInt(envelope.total);

  const pageField = envelope.page;
  if (typeof pageField === 'object' && pageField !== null) {
    const nested = pageField as Record<string, unknown>;
    const candidate = nested.total ?? nested.count ?? nested.numResults;
    if (typeof candidate === 'number') return toInt(candidate);
  }
  return fallback;
}

/** 组装搜索接口的公共查询参数 */
function buildSearchParams(
  searchType: 'video' | 'bili_user',
  keyword: string,
  page: number,
  pageSize: number,
  order: string,
): Record<string, string | number> {
  return {
    search_type: searchType,
    keyword,
    page,
    // 注意：该接口每页参数名是 page_size，不是 ps
    page_size: pageSize,
    order,
    platform: 'pc',
    single_column: 0,
    web_location: 1430654,
  };
}

/** 统一解析分页返回 */
function toPaged<T>(items: T[], total: number, page: number, pageSize: number): Paged<T> {
  const pageCount = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  return {
    items,
    total,
    page,
    pageSize,
    pageCount,
    hasMore: page * pageSize < total,
  };
}

/* ------------------------------------------------------------------ *
 * 视频搜索
 * ------------------------------------------------------------------ */

export async function searchVideos(
  env: Env,
  keyword: string,
  opts: SearchOptions = {},
): Promise<Paged<VideoBrief>> {
  const text = (keyword ?? '').trim();
  if (!text) throw badRequest('搜索关键词不能为空');

  const page = Math.max(1, toInt(opts.page ?? 1, 1));
  const pageSize = Math.max(1, toInt(opts.pageSize ?? 20, 20));
  const order = opts.order?.trim() || DEFAULT_ORDER;

  const data = await wbiGet<RawSearchResult<RawVideoSearchItem>>(
    env,
    SEARCH_PATH,
    buildSearchParams('video', text, page, pageSize, order),
    { referer: SEARCH_REFERER },
  );

  // 先拦截风控应答（只有 v_voucher、没有结果集），避免返回「伪成功空列表」
  assertNotRiskControlled(data, '视频搜索');

  // 上游字段名是单数 result（实测确认），兼容复数与 list 以防上游调整
  const raw = (data?.result ?? data?.results ?? data?.list ?? []).filter(
    (item): item is RawVideoSearchItem => item !== null && item !== undefined,
  );

  const items: VideoBrief[] = raw.map((item) => {
    const bvid = item.bvid ?? item.bv_id ?? '';
    return {
      bvid,
      aid: toInt(item.aid),
      // 标题带 <em class="keyword"> 高亮标签，必须清理
      title: stripHtml(item.title),
      // 搜索结果的 pic 常以 // 开头，必须补全协议
      cover: normalizeUrl(item.pic),
      duration: parseDurationText(item.duration),
      play: toInt(item.play),
      danmaku: toInt(item.video_review),
      ownerName: item.author ?? '',
      ownerMid: toInt(item.mid),
      pubdate: toInt(item.pubdate),
      url: videoUrl(bvid),
    };
  });

  const total = pickTotal(data, items.length);
  return toPaged(items, total, page, pageSize);
}

/* ------------------------------------------------------------------ *
 * UP 主搜索
 * ------------------------------------------------------------------ */

export async function searchUsers(
  env: Env,
  keyword: string,
  opts: SearchOptions = {},
): Promise<Paged<SearchedUser>> {
  const text = (keyword ?? '').trim();
  if (!text) throw badRequest('搜索关键词不能为空');

  const page = Math.max(1, toInt(opts.page ?? 1, 1));
  const pageSize = Math.max(1, toInt(opts.pageSize ?? 20, 20));
  const order = opts.order?.trim() || DEFAULT_ORDER;

  const data = await wbiGet<RawSearchResult<RawUserSearchItem>>(
    env,
    SEARCH_PATH,
    buildSearchParams('bili_user', text, page, pageSize, order),
    { referer: SEARCH_REFERER },
  );

  // UP 主搜索在未登录状态下很容易被要求风控验证，这里同样显式拦截
  assertNotRiskControlled(data, 'UP 主搜索');

  const raw = (data?.result ?? data?.results ?? data?.list ?? []).filter(
    (item): item is RawUserSearchItem => item !== null && item !== undefined,
  );

  const items: SearchedUser[] = raw.map((item) => {
    const mid = toInt(item.mid);
    return {
      mid,
      name: stripHtml(item.uname),
      face: normalizeUrl(item.upic),
      sign: item.usign ?? '',
      fans: toInt(item.fans),
      videos: toInt(item.videos),
      level: toInt(item.level),
      url: spaceUrl(mid),
    };
  });

  const total = pickTotal(data, items.length);
  return toPaged(items, total, page, pageSize);
}
