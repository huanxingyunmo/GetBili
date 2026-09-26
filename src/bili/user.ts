/**
 * UP 主相关业务：UP 主信息（多源兜底）+ UP 主投稿列表（WBI 签名）。
 */

import type { Env, Paged, UploaderInfo, VideoBrief } from '../types';
import { biliData, buildUrl } from '../lib/request';
import { wbiGet } from '../lib/wbi';
import { normalizeUrl, parseDurationText, spaceUrl, toInt, videoUrl } from '../lib/parse';
import { notFound } from '../lib/errors';

/* ------------------------------------------------------------------ *
 * 上游原始结构（只声明用到的字段，全部可选以容忍上游缺字段 / 变更）
 * ------------------------------------------------------------------ */

/** /x/web-interface/card */
interface RawCardData {
  card?: {
    mid?: number;
    name?: string;
    face?: string;
    sign?: string;
  } | null;
  /** 投稿数：注意在 data 顶层，不在 card 里 */
  archive_count?: number;
  /** 粉丝数：同样在 data 顶层 */
  follower?: number;
}

/** /x/space/wbi/acc/info */
interface RawAccInfo {
  mid?: number;
  name?: string;
  face?: string;
  sign?: string;
  level?: number;
  sex?: string;
}

/** /x/relation/stat */
interface RawRelationStat {
  mid?: number;
  following?: number;
  follower?: number;
}

/** /x/space/upstat —— archive 在部分响应里是数字（投稿数），此处做兼容 */
interface RawUpStat {
  archive?: { view?: number } | number | null;
  likes?: number;
}

/** /x/space/wbi/arc/search */
interface RawVlistItem {
  bvid?: string;
  aid?: number;
  title?: string;
  pic?: string;
  /** 时长：该接口给的是 "04:28" 文本，字段名是 length 而不是 duration */
  length?: string | number;
  duration?: number;
  play?: number;
  video_review?: number;
  author?: string;
  mid?: number;
  created?: number;
  comment?: number;
}

interface RawSpaceSearchData {
  page?: { count?: number; num?: number; size?: number } | null;
  list?: { vlist?: Array<RawVlistItem | null> | null } | null;
}

/* ------------------------------------------------------------------ *
 * UP 主信息
 * ------------------------------------------------------------------ */

/**
 * 取 UP 主信息。参考实现采用「多源兜底」策略：
 *   主源 card（无需签名，含投稿数/粉丝数）
 *   备源 A acc/info（需 WBI，含 level/sex，风控下会 -352 需静默降级）
 *   备源 B relation/stat（无需签名，含关注数）
 *   备源 C upstat（无需签名，含总获赞 / 投稿数）
 * 任一源失败都不影响整体，最终只要拿到 name 即视为成功。
 */
export async function getUploaderInfo(env: Env, mid: number): Promise<UploaderInfo> {
  let name = '';
  let face = '';
  let sign = '';
  let level = 0;
  let sex = '';

  // 用 null 表示「该字段尚未取到」，避免 0 与「未取到」混淆
  let follower: number | null = null;
  let following: number | null = null;
  let video: number | null = null;
  let likes: number | null = null;

  const spaceReferer = spaceUrl(mid) || undefined;

  // ---- 主源：card（无需签名） ----
  try {
    const data = await biliData<RawCardData>(
      env,
      buildUrl('/x/web-interface/card', { mid, photo: true }),
      { referer: spaceReferer },
    );
    const card = data?.card;
    if (card) {
      if (!name && card.name) name = card.name;
      if (!face && card.face) face = card.face;
      if (!sign && card.sign) sign = card.sign;
    }
    if (video === null && data?.archive_count !== undefined) {
      video = toInt(data.archive_count);
    }
    if (follower === null && data?.follower !== undefined) {
      follower = toInt(data.follower);
    }
  } catch {
    // 主源失败：交由后续备源兜底
  }

  // ---- 备源 A：acc/info（需 WBI，风控下会 -352，必须静默降级） ----
  try {
    const data = await wbiGet<RawAccInfo>(
      env,
      '/x/space/wbi/acc/info',
      { mid },
      { referer: spaceReferer },
    );
    if (!name && data?.name) name = data.name;
    if (!face && data?.face) face = data.face;
    if (!sign && data?.sign) sign = data.sign;
    if (data?.level !== undefined) level = toInt(data.level);
    if (!sex && data?.sex) sex = data.sex;
  } catch {
    // 未登录 / 风控 / 接口变更：静默降级
  }

  // ---- 备源 B：relation/stat（无需签名） ----
  try {
    const data = await biliData<RawRelationStat>(
      env,
      buildUrl('/x/relation/stat', { vmid: mid }),
    );
    if (follower === null && data?.follower !== undefined) follower = toInt(data.follower);
    if (following === null && data?.following !== undefined) following = toInt(data.following);
  } catch {
    // 静默降级
  }

  // ---- 备源 C：upstat（无需签名） ----
  try {
    const data = await biliData<RawUpStat>(env, buildUrl('/x/space/upstat', { mid }), {
      referer: spaceReferer,
    });
    if (likes === null && data?.likes !== undefined) likes = toInt(data.likes);
    // archive 既有对象形态（含 view 总播放）也有数字形态（投稿数）；
    // 注意 UploaderInfo 没有「总播放」字段，故 view 仅读取不对外暴露。
    const archive = data?.archive;
    if (video === null && typeof archive === 'number') {
      video = toInt(archive);
    }
  } catch {
    // 静默降级
  }

  // 所有源都没拿到昵称，视为该 UP 主不存在
  if (!name) throw notFound('未找到该 UP 主');

  return {
    mid,
    name,
    face: normalizeUrl(face),
    sign,
    level: toInt(level),
    sex,
    follower: follower ?? 0,
    following: following ?? 0,
    video: video ?? 0,
    likes: likes ?? 0,
    url: spaceUrl(mid),
  };
}

/* ------------------------------------------------------------------ *
 * UP 主投稿列表
 * ------------------------------------------------------------------ */

/**
 * B 站 web 端请求空间接口时固定携带的「设备画像」参数。
 *
 * 这些值来自 B 站 web 端源码（`dm_img_*`），本身不含密钥，作用是让请求看起来
 * 像来自真实浏览器。缺失时 `/x/space/wbi/arc/search` 更容易被判 -412
 * （request was banned）—— 实测带上后仍可能被拦，说明该接口还有 IP 维度的风控，
 * 配置 BILI_COOKIE 可显著提高成功率。
 */
const WEB_RISK_PARAMS = {
  dm_img_list: '[]',
  dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
  dm_cover_img_str:
    'QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwIChveDAwMDAzRTlCKSBEaXJlY3QzRDExIHZzXzVfMCBwc181XzAsIEQzRDExKQ',
  dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
} as const;

export interface UploaderVideosOptions {
  /** 页码，默认 1 */
  page?: number;
  /** 每页条数，默认 30 */
  pageSize?: number;
  /** 关键词过滤（上游支持） */
  keyword?: string;
  /** 排序，默认 'pubdate'（最新），可选 'click'（按播放） */
  order?: string;
}

/** 把空间投稿 vlist 的单项映射为统一 VideoBrief */
function mapVlistItem(item: RawVlistItem): VideoBrief {
  const bvid = item.bvid ?? '';
  return {
    bvid,
    aid: toInt(item.aid),
    title: item.title ?? '',
    cover: normalizeUrl(item.pic),
    // 上游给的是 length: "04:28" 文本，必须解析成秒数
    duration: parseDurationText(item.length ?? item.duration),
    play: toInt(item.play),
    danmaku: toInt(item.video_review),
    ownerName: item.author ?? '',
    ownerMid: toInt(item.mid),
    pubdate: toInt(item.created),
    url: videoUrl(bvid),
  };
}

/**
 * 取 UP 主投稿列表。
 * 接口需要 WBI 签名；wbiGet 内部已实现「签名失效 -> 刷新密钥重试」，此处不再重复包装。
 */
export async function getUploaderVideos(
  env: Env,
  mid: number,
  opts: UploaderVideosOptions = {},
): Promise<Paged<VideoBrief>> {
  const page = Math.max(1, toInt(opts.page ?? 1, 1));
  const pageSize = Math.max(1, toInt(opts.pageSize ?? 30, 30));
  const order = opts.order?.trim() || 'pubdate';
  const keyword = opts.keyword?.trim();

  const data = await wbiGet<RawSpaceSearchData>(
    env,
    '/x/space/wbi/arc/search',
    {
      mid,
      ps: pageSize,
      pn: page,
      order,
      keyword: keyword && keyword.length > 0 ? keyword : undefined,
      platform: 'web',
      // web 空间页会一并上报的「设备画像」参数。缺失时该接口更容易被判 -412 风控，
      // 因此这里按 B 站 web 端的固定值补齐（这些值本身不是密钥，仅用于伪装成浏览器）。
      ...WEB_RISK_PARAMS,
    },
    { referer: `https://space.bilibili.com/${mid}/video` },
  );

  const vlist = data?.list?.vlist ?? [];
  const items = vlist
    .filter((item): item is RawVlistItem => item !== null && item !== undefined)
    .map((item) => mapVlistItem(item));

  // 总数、当前页、每页条数以响应为准，缺失时回退到请求参数
  const total = toInt(data?.page?.count, items.length);
  const resultPage = toInt(data?.page?.num, page) || page;
  const resultSize = toInt(data?.page?.size, pageSize) || pageSize;
  const pageCount = resultSize > 0 ? Math.ceil(total / resultSize) : 0;

  return {
    items,
    total,
    page: resultPage,
    pageSize: resultSize,
    pageCount,
    hasMore: resultPage * resultSize < total,
  };
}
