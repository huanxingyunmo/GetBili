/**
 * 视频相关路由 —— 挂载在 /api/video
 *
 *   GET /:id              视频详情
 *   GET /:id/pages        分 P 列表
 *   GET /:id/playurl      播放地址（DASH 音视频流 / durl）
 *   GET /:id/file         直接返回视频/音频文件本体（流式代理；qn= 清晰度，audio=1 音频流，download=1 下载）
 *   GET /:id/merge        音视频合并成完整 mp4（需 ffmpeg；qn= 清晰度，download=1 下载）
 *   GET /:id/qualities    可用清晰度
 *   GET /:id/danmaku      弹幕（JSON / XML）
 *   GET /:id/collection   所属合集
 *   GET /?url=...         详情（等价于 /:id，便于直接传完整链接）
 */

import { Hono } from 'hono';
import type { Env, QualityOption, VideoDetail } from '../types.js';
import { badRequest, upstreamError } from '../lib/errors.js';
import { ok, pathParam, qBool, qInt, qStr, type AppContext } from '../lib/http.js';
import { parseVideoId } from '../lib/parse.js';
import { danmakuToXml, getDanmaku } from '../bili/danmaku.js';
import { getCollectionByBvid } from '../bili/collection.js';
import {
  getAvailableQualities,
  getPlayUrl,
  getVideoDetail,
  getVideoFile,
  getVideoPages,
  resolveBvid,
  type VideoIdParam,
} from '../bili/video.js';
import { ffmpegAvailable, mergeDashToMp4 } from '../lib/ffmpeg.js';

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

/**
 * 直接返回视频/音频文件本体（流式代理），不是链接。
 *
 * GET /:id/file?download=1 时附带 Content-Disposition，
 * 浏览器访问即下载；默认（无 download）可被 <video src> / <audio src> 直接引用。
 *
 * 注意：本端点把 B 站的 Referer 防盗链"翻译"掉了 —— 服务端带 Referer 回源，
 * 调用方无需任何请求头。代价是流量过本服务，直链时效（约 1~2 小时）不再暴露给调用方。
 */
video.get('/:id/file', async (c) => {
  const id = readId(c, pathParam(c, 'id'));
  const qn = qInt(c, 'qn', 80, { min: 1 });
  const audio = qBool(c, 'audio', false);
  const download = qBool(c, 'download', false);
  const meta = await getVideoFile(c.env, id, { qn, audio });

  // 透传 Range（视频拖动进度条必需）。无 Range 时伪装 bytes=0-：
  // 1) 强迫上游走流式响应，首字节立即可转发；
  // 2) 避免无 Range 全量回源时响应头迟迟不返回，撞上 Cloudflare ~100s 代理超时 → 502。
  const clientSentRange = !!c.req.header('Range');
  const range = clientSentRange ? c.req.header('Range')! : 'bytes=0-';
  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (range) headers['Range'] = range;

  const upstream = await fetch(meta.url, {
    headers: {
      Referer: 'https://www.bilibili.com/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      ...(range ? { Range: range } : {}),
    },
    redirect: 'follow',
  });

  if (!upstream.ok && upstream.status !== 206) {
    throw upstreamError(`上游文件取流失败（HTTP ${upstream.status}）`);
  }

  const out = new Headers();
  const contentType = upstream.headers.get('Content-Type') || meta.mimeType || 'application/octet-stream';
  out.set('Content-Type', contentType);
  out.set('Accept-Ranges', 'bytes');
  out.set('Cache-Control', 'no-store');

  const len = upstream.headers.get('Content-Length');
  if (len) out.set('Content-Length', len);
  const cr = upstream.headers.get('Content-Range');
  if (cr && clientSentRange) out.set('Content-Range', cr);
  const etag = upstream.headers.get('ETag');
  if (etag) out.set('ETag', etag);

  // 上游 206 但客户端没发 Range（我们伪装的）→ 对客户端表现为 200 完整响应
  const status = clientSentRange && upstream.status === 206 ? 206 : 200;
  if (status === 200) out.set('Accept-Ranges', 'bytes');

  if (download) {
    const ext = contentType.includes('audio') ? 'm4a' : 'mp4';
    const name = `${meta.bvid}_${meta.qualityName}.${ext}`.replace(/[^\w.\-]/g, '_');
    out.set('Content-Disposition', `attachment; filename="${name}"`);
  }

  return new Response(upstream.body, { status, headers: out });
});

/**
 * 直接返回「音视频合并后」的完整 mp4 文件本体（DASH 两路 remux，-c copy 秒级）。
 *
 * 为什么需要：B 站 DASH 的音视频是分离的（`/:id/file` 在 DASH 下只给视频流，
 * 播放器要靠 MSE 才能同时拿到声音）。本端点由服务端把两路都拉下来 remux。
 *
 * 查询参数：qn= 清晰度（默认 80）；download=1 触发浏览器下载；cid= 指定分 P。
 * 依赖运行环境有 ffmpeg（Docker 镜像已内置）；没有时返回 501 + 说明。
 */
video.get('/:id/merge', async (c) => {
  const id = readId(c, pathParam(c, 'id'));
  const qn = qInt(c, 'qn', 80, { min: 1 });
  const download = qBool(c, 'download', false);

  try {
    await ffmpegAvailable();
  } catch {
    throw badRequest('服务端未安装 ffmpeg，无法合并音视频；请改用 /:id/file（仅视频流）');
  }

  const meta = await getVideoFile(c.env, id, { qn, audio: false });
  const bvid = meta.bvid;
  const referer = `https://www.bilibili.com/video/${bvid}/`;

  // 音频用 getPlayUrl 拿 best.audio
  const cid = meta.cid;
  const play = await getPlayUrl(c.env, id, cid, meta.quality ?? qn);
  const audio = play.best.audio ?? play.dash?.audio?.[0];
  if (!audio) throw badRequest('该视频没有可用的音频流，无法合并');

  const merged = await mergeDashToMp4(meta.url, audio.baseUrl, referer);

  const headers: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'none',
  };
  if (download) {
    const name = `${bvid}_${meta.qualityName}.mp4`.replace(/[^\w.\-]/g, '_');
    headers['Content-Disposition'] = `attachment; filename="${name}"`;
  }
  return new Response(merged as unknown as BodyInit, { status: 200, headers });
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
