/**
 * 合集 / 收藏夹业务。
 *
 * - 合集：先取视频详情（/x/web-interface/view），再用其中的 ugc_season 展开所有分集。
 * - 收藏夹：/x/v3/fav/resource/list 分页读取。
 * 两者都无需 WBI 签名。
 */

import type { CollectionInfo, Env, VideoBrief } from '../types';
import { biliData, buildUrl } from '../lib/request';
import { normalizeUrl, toInt, videoUrl } from '../lib/parse';
import { badRequest, notFound } from '../lib/errors';

/**
 * 视频标识。注意：本文件刻意本地定义而不 import video.ts 的 VideoIdParam，
 * 以避免与并行开发的其他模块产生耦合。
 */
interface SeasonVideoId {
  bvid?: string | null;
  aid?: number | null;
}

/* ------------------------------------------------------------------ *
 * 上游原始结构
 * ------------------------------------------------------------------ */

interface RawAuthor {
  mid?: number;
  name?: string;
  face?: string;
}

/** view 响应里的「稿件」信息（合集分集与普通视频共用） */
interface RawArc {
  aid?: number;
  bvid?: string;
  title?: string;
  pic?: string;
  duration?: number;
  pubdate?: number;
  /** 注意：合集里的作者挂在 arc.author，而不是 arc.owner */
  author?: RawAuthor | null;
  stat?: { view?: number; danmaku?: number } | null;
}

/** ugc_season.sections[].episodes[] 单项 */
interface RawEpisode {
  aid?: number;
  bvid?: string;
  title?: string;
  arc?: RawArc | null;
  /** 分集自身的时长（优先于 arc.duration） */
  page?: { duration?: number } | null;
}

interface RawSection {
  episodes?: Array<RawEpisode | null> | null;
}

interface RawViewData {
  ugc_season?: {
    id?: number;
    title?: string;
    cover?: string;
    ep_count?: number;
    sections?: Array<RawSection | null> | null;
  } | null;
}

/** /x/v3/fav/resource/list */
interface RawFavMedia {
  id?: number;
  bvid?: string;
  bv_id?: string;
  title?: string;
  cover?: string;
  duration?: number;
  pubtime?: number;
  /** 非 0 表示已失效稿件 */
  attr?: number;
  cnt_info?: { play?: number; danmaku?: number } | null;
  upper?: RawAuthor | null;
}

interface RawFavData {
  medias?: Array<RawFavMedia | null> | null;
  has_more?: boolean;
  info?: {
    id?: number;
    title?: string;
    cover?: string;
    media_count?: number;
    mid?: number;
    upper?: RawAuthor | null;
  } | null;
}

/* ------------------------------------------------------------------ *
 * 合集
 * ------------------------------------------------------------------ */

/** 把合集分集映射为统一 VideoBrief */
function mapEpisode(ep: RawEpisode): VideoBrief {
  const bvid = ep.bvid ?? ep.arc?.bvid ?? '';
  return {
    bvid,
    aid: toInt(ep.aid ?? ep.arc?.aid),
    title: ep.title ?? ep.arc?.title ?? '',
    cover: normalizeUrl(ep.arc?.pic),
    // 分集时长优先，缺失时退回稿件时长
    duration: toInt(ep.page?.duration ?? ep.arc?.duration),
    play: toInt(ep.arc?.stat?.view),
    danmaku: toInt(ep.arc?.stat?.danmaku),
    // 合集内作者字段是 arc.author
    ownerName: ep.arc?.author?.name ?? '',
    ownerMid: toInt(ep.arc?.author?.mid),
    pubdate: toInt(ep.arc?.pubdate),
    url: videoUrl(bvid),
  };
}

/**
 * 按 BV 号 / av 号取其所属合集（通过 video view 的 ugc_season）。
 * 视频不属于任何合集时抛 404。
 */
export async function getCollectionByBvid(
  env: Env,
  id: SeasonVideoId,
): Promise<{ info: CollectionInfo; videos: VideoBrief[] }> {
  if (!id.bvid && !id.aid) {
    throw badRequest('必须提供 bvid 或 aid');
  }

  const data = await biliData<RawViewData>(
    env,
    buildUrl('/x/web-interface/view', {
      bvid: id.bvid ?? undefined,
      aid: id.aid ?? undefined,
    }),
    { referer: id.bvid ? videoUrl(id.bvid) : undefined },
  );

  const season = data?.ugc_season;
  if (!season) throw notFound('该视频不属于任何合集');

  // 展平 sections[].episodes[]，并过滤数组空洞
  const sections = season.sections ?? [];
  const episodes: RawEpisode[] = [];
  for (const section of sections) {
    if (!section) continue;
    for (const ep of section.episodes ?? []) {
      if (ep) episodes.push(ep);
    }
  }

  const videos = episodes.map((ep) => mapEpisode(ep));
  const first = videos[0];

  const info: CollectionInfo = {
    type: 'collection',
    id: toInt(season.id),
    title: season.title ?? '',
    cover: normalizeUrl(season.cover),
    // ep_count 缺失时以实际展开到的分集数为准
    count: toInt(season.ep_count) || videos.length,
    mid: first?.ownerMid ?? 0,
    upperName: first?.ownerName ?? '',
  };

  return { info, videos };
}

/* ------------------------------------------------------------------ *
 * 收藏夹
 * ------------------------------------------------------------------ */

export interface FavlistResult {
  info: CollectionInfo;
  videos: VideoBrief[];
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  hasMore: boolean;
}

/** 把收藏夹资源映射为统一 VideoBrief（失效稿件用空串兜底） */
function mapFavMedia(media: RawFavMedia): VideoBrief {
  const bvid = media.bvid ?? media.bv_id ?? '';
  return {
    bvid,
    // 收藏夹资源以 id 字段承载 aid
    aid: toInt(media.id),
    title: media.title ?? '',
    cover: normalizeUrl(media.cover),
    duration: toInt(media.duration),
    play: toInt(media.cnt_info?.play),
    danmaku: toInt(media.cnt_info?.danmaku),
    ownerName: media.upper?.name ?? '',
    ownerMid: toInt(media.upper?.mid),
    pubdate: toInt(media.pubtime),
    url: videoUrl(bvid),
  };
}

/** 取收藏夹内容（media_id = 收藏夹 ID） */
export async function getFavlistVideos(
  env: Env,
  mediaId: number,
  opts: { page?: number; pageSize?: number } = {},
): Promise<FavlistResult> {
  const page = Math.max(1, toInt(opts.page ?? 1, 1));
  const pageSize = Math.max(1, toInt(opts.pageSize ?? 20, 20));

  const data = await biliData<RawFavData>(
    env,
    buildUrl('/x/v3/fav/resource/list', {
      media_id: mediaId,
      pn: page,
      ps: pageSize,
      platform: 'web',
      order: 'mtime',
      desc: 1,
    }),
    { referer: 'https://www.bilibili.com/' },
  );

  // medias 里可能夹带 null，先过滤干净
  const medias = (data?.medias ?? []).filter(
    (item): item is RawFavMedia => item !== null && item !== undefined,
  );
  const rawInfo = data?.info ?? null;
  const total = toInt(rawInfo?.media_count);

  // 空页且总数为 0 -> 收藏夹不存在或为空
  if (medias.length === 0 && total === 0) {
    throw notFound('收藏夹不存在或为空');
  }

  const videos = medias.map((media) => mapFavMedia(media));
  const pageCount = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  const hasMore =
    typeof data?.has_more === 'boolean' ? data.has_more : page * pageSize < total;

  const info: CollectionInfo = {
    type: 'favlist',
    id: toInt(rawInfo?.id),
    title: rawInfo?.title ?? '',
    cover: normalizeUrl(rawInfo?.cover),
    count: total,
    mid: toInt(rawInfo?.mid),
    upperName: rawInfo?.upper?.name ?? '',
  };

  return { info, videos, page, pageSize, pageCount, total, hasMore };
}
