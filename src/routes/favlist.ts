/**
 * 收藏夹路由 —— 挂载在 /api/favlist
 *
 *   GET /:mediaId?page=&pageSize=   收藏夹内容（分页）
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { badRequest } from '../lib/errors';
import { ok, pathParam, qInt, type AppContext } from '../lib/http';
import { parseFavlistId } from '../lib/parse';
import { getFavlistVideos } from '../bili/collection';

const favlist = new Hono<{ Bindings: Env }>();

function readMediaId(c: AppContext, raw: string): number {
  const mediaId = parseFavlistId(raw);
  if (!mediaId || mediaId <= 0) {
    throw badRequest(
      `无法从 "${raw}" 解析出收藏夹 ID，请传入 media_id 或含 fid= 参数的收藏夹链接`,
    );
  }
  return mediaId;
}

favlist.get('/:mediaId', async (c) => {
  const mediaId = readMediaId(c, pathParam(c, 'mediaId'));
  const page = qInt(c, 'page', 1, { min: 1 });
  const pageSize = qInt(c, 'pageSize', 20, { min: 1, max: 50 });

  const result = await getFavlistVideos(c.env, mediaId, { page, pageSize });
  return ok(c, result);
});

export default favlist;
