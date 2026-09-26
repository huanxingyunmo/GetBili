/**
 * 搜索相关路由 —— 挂载在 /api/search
 *
 *   GET /video?keyword=...   视频搜索
 *   GET /user?keyword=...    UP 主搜索
 *   GET /?keyword=...        等价于 /video，便于省略
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { badRequest } from '../lib/errors';
import { ok, qInt, qStr, type AppContext } from '../lib/http';
import { searchUsers, searchVideos, type SearchOptions } from '../bili/search';

const search = new Hono<{ Bindings: Env }>();

function readOptions(c: AppContext, defaultPageSize: number): SearchOptions & { keyword: string } {
  const keyword = qStr(c, 'keyword').trim();
  if (!keyword) {
    throw badRequest('缺少参数 keyword（搜索关键词）');
  }
  const page = qInt(c, 'page', 1, { min: 1 });
  const pageSize = qInt(c, 'pageSize', defaultPageSize, { min: 1, max: 50 });
  const order = qStr(c, 'order').trim();
  return {
    keyword,
    page,
    pageSize,
    ...(order ? { order } : {}),
  };
}

search.get('/', async (c) => {
  const { keyword, page, pageSize, order } = readOptions(c, 20);
  const result = await searchVideos(c.env, keyword, { page, pageSize, ...(order ? { order } : {}) });
  return ok(c, result);
});

search.get('/video', async (c) => {
  const { keyword, page, pageSize, order } = readOptions(c, 20);
  const result = await searchVideos(c.env, keyword, { page, pageSize, ...(order ? { order } : {}) });
  return ok(c, result);
});

search.get('/user', async (c) => {
  const { keyword, page, pageSize, order } = readOptions(c, 20);
  const result = await searchUsers(c.env, keyword, { page, pageSize, ...(order ? { order } : {}) });
  return ok(c, result);
});

export default search;
