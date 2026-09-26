/**
 * 视频业务模块：详情 / 分 P / 播放地址 / 可用清晰度。
 *
 * 设计要点：
 *   1. 所有接口都接受 bvid / aid 两种标识，进入前统一用 idParams() 归一，
 *      避免每个接口各写一套参数拼装逻辑。
 *   2. 详情优先走需要 WBI 签名的 wbi view/detail（字段最全），失败则降级到
 *      不需要签名的 /x/web-interface/view —— 后者同样返回 View 结构，
 *      因此两条链路共用 mapView()。
 *   3. playurl 走 WBI 签名；匿名态（未配置 Cookie）且开启 try_look 时附加
 *      try_look=1，可预览更高清晰度，但拿不到真实流地址，
 *      所以 acceptQuality[].available 必须基于 dash.video 实际存在的流来计算。
 *   4. 上游字段同时存在 snake_case（老版）与 camelCase（新版）两种写法，
 *      读取时统一 `xxx ?? xxxCamel`，兼容两版。
 */

import type {
  DashStream,
  Env,
  PlayUrlResult,
  QualityOption,
  VideoDetail,
  VideoOwner,
  VideoPart,
  VideoStat,
} from '../types';
import { BiliError, badRequest, notFound, upstreamError } from '../lib/errors';
import { normalizeUrl, qualityName, toInt, videoUrl } from '../lib/parse';
import { biliData, buildUrl, isAnonymous, tryLookEnabled, type QueryValue } from '../lib/request';
import { wbiGet } from '../lib/wbi';

/** 视频标识：bvid 与 aid 至少提供一个 */
export interface VideoIdParam {
  bvid?: string | null;
  aid?: number | null;
}

/* ------------------------------------------------------------------ *
 * 上游原始结构（只声明本模块用到的字段，全部可选以容忍上游缺字段/改字段）
 * ------------------------------------------------------------------ */

interface RawStat {
  view?: number;
  danmaku?: number;
  reply?: number;
  favorite?: number;
  coin?: number;
  share?: number;
  like?: number;
  now_rank?: number;
  his_rank?: number;
}

interface RawOwner {
  mid?: number;
  name?: string;
  face?: string;
}

interface RawDimension {
  width?: number;
  height?: number;
  rotate?: number;
}

interface RawPage {
  cid?: number;
  page?: number;
  /** 注意：上游分 P 的标题字段名是 part，不是 title */
  part?: string;
  duration?: number;
  from?: string;
}

interface RawUgcSeason {
  id?: number;
  title?: string;
  cover?: string;
  ep_count?: number;
  sections?: Array<{ episodes?: unknown[] }>;
}

interface RawRights {
  /** 互动视频标记（1 表示是） */
  is_stein_gate?: number;
}

/** /x/web-interface/view 与 wbi view/detail 里 View 的公共结构 */
interface RawView {
  bvid?: string;
  aid?: number;
  /** 顶层 cid 即默认第一 P 的 cid */
  cid?: number;
  title?: string;
  desc?: string;
  pic?: string;
  duration?: number;
  pubdate?: number;
  ctime?: number;
  state?: number;
  tname?: string;
  dynamic?: string;
  /** 分 P 数量 */
  videos?: number;
  stat?: RawStat;
  owner?: RawOwner;
  dimension?: RawDimension;
  pages?: RawPage[];
  is_interactive?: number;
  rights?: RawRights;
  ugc_season?: RawUgcSeason;
}

/** WBI 详情接口的 data 包装（data.View） */
interface RawDetailData {
  View?: RawView;
}

interface RawSupportFormat {
  quality?: number;
  format?: string;
  new_description?: string;
  display_desc?: string;
}

interface RawStream {
  id?: number;
  baseUrl?: string;
  base_url?: string;
  backupUrl?: string[];
  backup_url?: string[];
  bandwidth?: number;
  mimeType?: string;
  mime_type?: string;
  codecs?: string;
  width?: number;
  height?: number;
  frameRate?: string | number;
  frame_rate?: string | number;
  codecid?: number;
}

interface RawDash {
  duration?: number;
  video?: RawStream[];
  audio?: RawStream[];
}

interface RawDurl {
  order?: number;
  length?: number;
  size?: number;
  url?: string;
  backupUrl?: string[];
  backup_url?: string[];
}

interface RawPlayUrl {
  quality?: number;
  format?: string;
  timelength?: number;
  timeLength?: number;
  accept_quality?: number[];
  acceptQuality?: number[];
  accept_description?: string[];
  acceptDescription?: string[];
  support_formats?: RawSupportFormat[];
  supportFormats?: RawSupportFormat[];
  dash?: RawDash;
  durl?: RawDurl[];
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 宽松取字符串：上游偶尔回数字/ null，统一收敛为 string */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/** 宽松取字符串数组（兼容 null / 非数组） */
function asTextArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => asText(item)) : [];
}

/** 校验并归一视频标识；两者都没有直接 400，避免把无效请求打到上游 */
function idParams(id: VideoIdParam): Record<string, QueryValue> {
  const bvid = id.bvid?.trim();
  if (bvid) return { bvid };
  const aid = toInt(id.aid);
  if (aid > 0) return { aid };
  throw badRequest('缺少视频标识：请提供 bvid 或 aid');
}

/** 播放/弹幕接口的 Referer：B 站对缺失 Referer 的请求会回 -412 */
function refererOf(bvid: string | null | undefined, aid: number | null | undefined): string | undefined {
  const bv = bvid?.trim();
  if (bv) return videoUrl(bv);
  const av = toInt(aid);
  return av > 0 ? `https://www.bilibili.com/video/av${av}` : undefined;
}

/* ------------------------------------------------------------------ *
 * 字段映射
 * ------------------------------------------------------------------ */

function mapStat(raw: RawStat | undefined): VideoStat {
  return {
    view: toInt(raw?.view),
    danmaku: toInt(raw?.danmaku),
    reply: toInt(raw?.reply),
    favorite: toInt(raw?.favorite),
    coin: toInt(raw?.coin),
    share: toInt(raw?.share),
    like: toInt(raw?.like),
    nowRank: toInt(raw?.now_rank),
    hisRank: toInt(raw?.his_rank),
  };
}

function mapOwner(raw: RawOwner | undefined): VideoOwner {
  return {
    mid: toInt(raw?.mid),
    name: asText(raw?.name),
    face: normalizeUrl(raw?.face),
  };
}

function mapPage(raw: RawPage | null | undefined): VideoPart {
  return {
    cid: toInt(raw?.cid),
    page: toInt(raw?.page),
    title: asText(raw?.part),
    duration: toInt(raw?.duration),
    from: asText(raw?.from),
  };
}

/** 合集内的总集数：ep_count 缺失时退化为各 section 的 episodes 数量之和 */
function countSeasonEpisodes(season: RawUgcSeason): number {
  let total = 0;
  for (const section of season.sections ?? []) {
    total += section.episodes?.length ?? 0;
  }
  return total;
}

/** View -> VideoDetail */
function mapView(view: RawView, id: VideoIdParam): VideoDetail {
  const pages = (view.pages ?? []).map(mapPage);
  const bvid = asText(view.bvid) || asText(id.bvid);
  const isInteraction = Boolean(view.is_interactive) || view.rights?.is_stein_gate === 1;
  const season = view.ugc_season;

  return {
    bvid,
    aid: toInt(view.aid, toInt(id.aid)),
    cid: toInt(view.cid),
    title: asText(view.title),
    desc: asText(view.desc),
    cover: normalizeUrl(view.pic),
    duration: toInt(view.duration),
    pubdate: toInt(view.pubdate),
    ctime: toInt(view.ctime),
    url: videoUrl(bvid),
    state: toInt(view.state),
    stat: mapStat(view.stat),
    owner: mapOwner(view.owner),
    dimension: {
      width: toInt(view.dimension?.width),
      height: toInt(view.dimension?.height),
      rotate: toInt(view.dimension?.rotate),
    },
    pages,
    pageCount: pages.length,
    tname: asText(view.tname),
    dynamic: asText(view.dynamic),
    videos: toInt(view.videos, pages.length),
    collection: season
      ? {
          id: toInt(season.id),
          title: asText(season.title),
          cover: normalizeUrl(season.cover),
          count: toInt(season.ep_count ?? countSeasonEpisodes(season)),
        }
      : null,
    isInteraction,
  };
}

function mapDashStream(raw: RawStream | null | undefined): DashStream {
  const id = toInt(raw?.id);
  return {
    id,
    qualityName: qualityName(id),
    baseUrl: asText(raw?.baseUrl ?? raw?.base_url),
    backupUrl: asTextArray(raw?.backupUrl ?? raw?.backup_url),
    bandwidth: toInt(raw?.bandwidth),
    mimeType: asText(raw?.mimeType ?? raw?.mime_type),
    codecs: asText(raw?.codecs),
    width: toInt(raw?.width),
    height: toInt(raw?.height),
    frameRate: asText(raw?.frameRate ?? raw?.frame_rate),
    codecid: toInt(raw?.codecid),
  };
}

function mapDurl(raw: RawDurl | null | undefined): {
  order: number;
  length: number;
  size: number;
  url: string;
  backupUrl: string[];
} {
  return {
    order: toInt(raw?.order),
    length: toInt(raw?.length),
    size: toInt(raw?.size),
    url: asText(raw?.url),
    backupUrl: asTextArray(raw?.backupUrl ?? raw?.backup_url),
  };
}

/**
 * 构造 acceptQuality。
 * available 以 dash.video 中是否真的存在该 id 的流为准：匿名态下 B 站会返回
 * 一长串 accept_quality，但 dash 里只有低清晰度，这样能如实反映"可看/不可看"。
 */
function mapAcceptQuality(raw: RawPlayUrl, dashVideo: DashStream[]): QualityOption[] {
  const supportFormats = raw.support_formats ?? raw.supportFormats ?? [];
  const formatByQn = new Map<number, RawSupportFormat>();
  for (const item of supportFormats) {
    if (item && typeof item.quality === 'number') formatByQn.set(item.quality, item);
  }

  const acceptQn = (raw.accept_quality ?? raw.acceptQuality ?? []).map((qn) => toInt(qn));
  const acceptDesc = raw.accept_description ?? raw.acceptDescription ?? [];
  const qnList =
    acceptQn.length > 0
      ? acceptQn
      : supportFormats.map((item) => toInt(item?.quality)).filter((qn) => qn > 0);

  const availableIds = new Set(dashVideo.map((stream) => stream.id));

  return qnList.map((qn, index) => {
    const format = formatByQn.get(qn);
    const description =
      asText(format?.new_description) ||
      asText(format?.display_desc) ||
      asText(acceptDesc[index]) ||
      qualityName(qn);
    return { qn, description, available: availableIds.has(qn) };
  });
}

/* ------------------------------------------------------------------ *
 * 最佳流挑选（模块内私有）
 * ------------------------------------------------------------------ */

/** 编码优先级：数值越小越优先，未知编码排最后（avc > hevc > av1） */
const CODEC_PRIORITY: Record<number, number> = { 7: 0, 12: 1, 13: 2 };

function codecRank(codecid: number): number {
  return CODEC_PRIORITY[codecid] ?? 3;
}

/** 同清晰度可能有多条不同编码的流，取编码优先级最高的一条（排序稳定，同优先级保持原顺序） */
function pickByCodec(streams: DashStream[]): DashStream | null {
  if (streams.length === 0) return null;
  const sorted = [...streams].sort((a, b) => codecRank(a.codecid) - codecRank(b.codecid));
  return sorted[0];
}

/**
 * 视频最佳流：
 *   1. 优先 id === qn（精确命中）
 *   2. 否则取 id <= qn 中 id 最大的一档（降级到最接近的清晰度）
 *   3. 再没有则取全列表中 id 最大的一档
 */
function selectVideoStream(streams: DashStream[], qn: number): DashStream | null {
  if (streams.length === 0) return null;

  const exact = streams.filter((stream) => stream.id === qn);
  if (exact.length > 0) return pickByCodec(exact);

  const lower = streams.filter((stream) => stream.id <= qn);
  if (lower.length > 0) {
    const maxId = Math.max(...lower.map((stream) => stream.id));
    return pickByCodec(lower.filter((stream) => stream.id === maxId));
  }

  const maxId = Math.max(...streams.map((stream) => stream.id));
  return pickByCodec(streams.filter((stream) => stream.id === maxId));
}

/** 音频最佳流：码率最大者 */
function selectAudioStream(streams: DashStream[]): DashStream | null {
  if (streams.length === 0) return null;
  return streams.reduce((best, current) => (current.bandwidth > best.bandwidth ? current : best));
}

/* ------------------------------------------------------------------ *
 * playurl 映射
 * ------------------------------------------------------------------ */

function mapPlayUrl(
  raw: RawPlayUrl,
  ctx: { bvid: string; cid: number; qn: number },
): PlayUrlResult {
  const dashVideo = (raw.dash?.video ?? []).map(mapDashStream);
  const dashAudio = (raw.dash?.audio ?? []).map(mapDashStream);
  const dash = raw.dash
    ? { duration: toInt(raw.dash.duration), video: dashVideo, audio: dashAudio }
    : null;

  const durlRaw = raw.durl ?? [];
  const durl = durlRaw.length > 0 ? durlRaw.map(mapDurl) : null;

  const qn = toInt(raw.quality, ctx.qn);
  // 注意：上游的 format 字段是历史遗留值（DASH 模式下也会返回 "flv720" 之类），
  // 不可直接沿用。以实际返回的流结构为准，上游值仅作为最后兜底。
  const hasDash = dash !== null && (dash.video.length > 0 || dash.audio.length > 0);
  const format = hasDash ? 'dash' : durl ? 'durl' : asText(raw.format);

  return {
    bvid: ctx.bvid,
    cid: ctx.cid,
    requestQn: ctx.qn,
    qn,
    qualityName: qualityName(qn),
    format,
    timelength: toInt(raw.timelength ?? raw.timeLength),
    acceptQuality: mapAcceptQuality(raw, dashVideo),
    dash,
    durl,
    best: {
      video: selectVideoStream(dashVideo, qn),
      audio: selectAudioStream(dashAudio),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

const WBI_DETAIL_PATH = '/x/web-interface/wbi/view/detail';
const VIEW_PATH = '/x/web-interface/view';
const PAGELIST_PATH = '/x/player/pagelist';
const WBI_PLAYURL_PATH = '/x/player/wbi/playurl';

/** wbi view/detail 的固定业务参数 */
const DETAIL_BASE_PARAMS: Record<string, QueryValue> = {
  platform: 'web',
  page_no: 1,
  p: 1,
  need_operation_card: 1,
  web_rm_repeat: 1,
  need_elec: 1,
};

/** playurl 的默认清晰度（1080P） */
const DEFAULT_QN = 80;

/**
 * 拿到可用的 bvid（playurl / pagelist 等需要 bvid 的接口用）。
 * 已给 bvid 时直接返回，不会多发一次请求；只给 aid 时才查一次 view 接口。
 */
export async function resolveBvid(env: Env, id: VideoIdParam): Promise<string> {
  const params = idParams(id);
  if (params.bvid) return String(params.bvid);

  const aid = toInt(id.aid);
  const view = await biliData<RawView>(env, buildUrl(VIEW_PATH, params), {
    referer: refererOf(null, aid),
  });
  const bvid = asText(view?.bvid);
  if (!bvid) {
    throw notFound(`未找到 aid=${aid} 对应的视频`);
  }
  return bvid;
}

/**
 * 视频详情。
 * 先试 WBI 版（字段最全），失败或响应里没有 View 时降级到免签名的 view 接口；
 * 两个都失败才抛错（优先抛上游的 BiliError，便于把 -404 等业务码透传给调用方）。
 */
export async function getVideoDetail(env: Env, id: VideoIdParam): Promise<VideoDetail> {
  const params = idParams(id);
  const referer = refererOf(id.bvid, id.aid);
  let lastError: unknown = null;

  try {
    const data = await wbiGet<RawDetailData>(env, WBI_DETAIL_PATH, { ...DETAIL_BASE_PARAMS, ...params }, {
      referer,
    });
    const view = data?.View;
    if (view && (view.bvid || view.aid || (view.pages?.length ?? 0) > 0)) {
      return mapView(view, id);
    }
    lastError = upstreamError('WBI 视频详情响应中缺少 View 字段', { params });
  } catch (err) {
    lastError = err;
  }

  try {
    const view = await biliData<RawView>(env, buildUrl(VIEW_PATH, params), { referer });
    if (view) return mapView(view, id);
    lastError = upstreamError('视频详情响应为空', { params });
  } catch (err) {
    lastError = err;
  }

  if (lastError instanceof BiliError) throw lastError;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw upstreamError(`获取视频详情失败：${message}`, { params });
}

/** 分 P 列表 */
export async function getVideoPages(env: Env, id: VideoIdParam): Promise<VideoPart[]> {
  const params = idParams(id);
  const data = await biliData<RawPage[] | null>(env, buildUrl(PAGELIST_PATH, params), {
    referer: refererOf(id.bvid, id.aid),
  });
  return (Array.isArray(data) ? data : []).map(mapPage);
}

/**
 * 播放地址。
 * - 需要 bvid 才能拼 Referer，缺 bvid 时先解析一次（此时才多一次请求）
 * - 匿名 + try_look 开启时附加 try_look=1
 */
export async function getPlayUrl(
  env: Env,
  id: VideoIdParam,
  cid: number,
  qn: number = DEFAULT_QN,
): Promise<PlayUrlResult> {
  const params = idParams(id);
  const bvid = await resolveBvid(env, id);

  const query: Record<string, QueryValue> = {
    ...params,
    cid: toInt(cid),
    qn,
    fnval: 4048,
    fourk: 1,
    voice_balance: 1,
    gaia_source: 'pre-load',
    web_location: 1550101,
  };
  if (isAnonymous(env) && tryLookEnabled(env)) {
    query.try_look = 1;
  }

  const data = await wbiGet<RawPlayUrl>(env, WBI_PLAYURL_PATH, query, {
    referer: videoUrl(bvid),
  });
  return mapPlayUrl(data, { bvid, cid: toInt(cid), qn });
}

/** 可用清晰度列表（内部按 4K 请求，取上游回传的 accept_quality）；上游报错时返回空数组 */
export async function getAvailableQualities(
  env: Env,
  id: VideoIdParam,
  cid: number,
): Promise<QualityOption[]> {
  try {
    const result = await getPlayUrl(env, id, cid, 120);
    return result.acceptQuality;
  } catch {
    return [];
  }
}
