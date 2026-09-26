/**
 * 视频相关路由 —— 挂载在 /api/video
 *
 *   GET /:id              视频详情
 *   GET /:id/pages        分 P 列表
 *   GET /:id/playurl      播放地址（DASH 音视频流 / durl）
 *   GET /:id/qualities    可用清晰度
 *   GET /:id/danmaku      弹幕（JSON / XML）
 *   GET /:id/collection   所属合集
 *   GET /?url=...         详情（等价于 /:id，便于直接传完整链接）
 */

import { Hono } from 'hono';
import type { Env, QualityOption, VideoDetail } from '../types';
import { badRequest } from '../lib/errors';
import { ok, pathParam, qBool, qInt, qStr, type AppContext } from '../lib/http';
import { parseVideoId } from '../lib/parse';
import { danmakuToXml, getDanmaku } from '../bili/danmaku';
import { getCollectionByBvid } from '../bili/collection';
import {
  getAvailableQualities,
  getPlayUrl,
  getVideoDetail,
  getVideoPages,
  resolveBvid,
  type VideoIdParam,
} from '../bili/video';

const video = new Hono<{ Bindings: Env }>();

/** 从路径参数解析视频标识，失败即 400 */
function readId(c: AppContext, raw: string): VideoIdParam {
  const id = parseVideoId(raw);
  if (!id.bvid && !id.aid) {
    throw badRequest(
      `无法从 "${raw}" 解析出视频标识，请传入 BV 号（如 BV17x411w7KC）、av 号或视频链接`,
    );
  }
  return id;
}

/**
 * 解析 cid：优先用查询参数；没传则回退到详情里默认第一 P 的 cid。
 * 同时返回 bvid 以便调用方拼 Referer。
 */
async function resolveCidAndBvid(
  c: AppContext,
  id: VideoIdParam,
): Promise<{ cid: number; bvid: string }> {
  const explicit = qInt(c, 'cid', 0, { min: 0 });
  if (explicit > 0) {
    return { cid: explicit, bvid: await resolveBvid(c.env, id) };
  }
  const detail = await getVideoDetail(c.env, id);
  return { cid: detail.cid, bvid: detail.bvid };
}

/** 详情（含可选清晰度探测） */
async function detailHandler(c: AppContext, id: VideoIdParam): Promise<Response> {
  const withQualities = qBool(c, 'qualities', false);
  const withPages = qBool(c, 'pages', true);

  const detail = await getVideoDetail(c.env, id);
  let qualities: QualityOption[] | undefined;

  if (withQualities) {
    qualities = await getAvailableQualities(c.env, id, detail.cid);
  }

  const data: VideoDetail & { qualities?: QualityOption[] } = {
    ...detail,
    ...(withPages ? {} : { pages: [] }),
    ...(qualities ? { qualities } : {}),
  };

  return ok(c, data);
}

video.get('/', async (c) => {
  // 支持 /api/video?url=<完整链接> 或 ?bvid= / ?aid=
  const raw = qStr(c, 'url') || qStr(c, 'input') || qStr(c, 'bvid') || qStr(c, 'aid');
  if (!raw) {
    throw badRequest('缺少参数：请使用 /api/video/:id 或在查询串中提供 url / bvid / aid');
  }
  return detailHandler(c, readId(c, raw));
});

video.get('/:id', async (c) => detailHandler(c, readId(c, pathParam(c, 'id'))));

video.get('/:id/pages', async (c) => {
  const id = readId(c, pathParam(c, 'id'));
  const pages = await getVideoPages(c.env, id);
  return ok(c, { count: pages.length, pages });
});

video.get('/:id/playurl', async (c) => {
  const id = readId(c, pathParam(c, 'id'));
  const qn = qInt(c, 'qn', 80, { min: 1 });
  const { cid } = await resolveCidAndBvid(c, id);
  const result = await getPlayUrl(c.env, id, cid, qn);
  return ok(c, result);
});

video.get('/:id/qualities', async (c) => {
  const id = readId(c, pathParam(c, 'id'));
  const { cid } = await resolveCidAndBvid(c, id);
  const qualities = await getAvailableQualities(c.env, id, cid);
  return ok(c, { cid, count: qualities.length, qualities });
});

video.get('/:id/danmaku', async (c) => {
  const id = readId(c, pathParam(c, 'id'));
  const format = qStr(c, 'format', 'json').toLowerCase();
  const segment = qInt(c, 'segment', 0, { min: 0 });
  const maxSegments = qInt(c, 'maxSegments', 100, { min: 1, max: 1000 });

  const { cid, bvid } = await resolveCidAndBvid(c, id);
  const list = await getDanmaku(c.env, cid, {
    bvid,
    ...(segment > 0 ? { segment } : {}),
    maxSegments,
  });

  if (format === 'xml') {
    // 保留原始弹幕数据，不做合并/过滤
    return new Response(danmakuToXml(list, cid), {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `inline; filename="${bvid || cid}.xml"`,
      },
    });
  }

  return ok(c, {
    bvid,
    cid,
    count: list.length,
    danmaku: list,
  });
});

video.get('/:id/collection', async (c) => {
  const id = readId(c, pathParam(c, 'id'));
  const result = await getCollectionByBvid(c.env, id);
  return ok(c, result);
});

export default video;
