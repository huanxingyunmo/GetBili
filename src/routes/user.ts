/**
 * UP 主相关路由 —— 挂载在 /api/user
 *
 *   GET /:mid             UP 主信息
 *   GET /:mid/videos      投稿视频列表（分页）
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { badRequest } from '../lib/errors';
import { ok, pathParam, qInt, qStr, type AppContext } from '../lib/http';
import { parseMid } from '../lib/parse';
import { getUploaderInfo, getUploaderVideos } from '../bili/user';

const user = new Hono<{ Bindings: Env }>();

function readMid(c: AppContext, raw: string): number {
  const mid = parseMid(raw);
  if (!mid || mid <= 0) {
    throw badRequest(`无法从 "${raw}" 解析出 UP 主 UID，请传入数字 UID 或空间链接`);
  }
  return mid;
}

user.get('/:mid', async (c) => {
  const mid = readMid(c, pathParam(c, 'mid'));
  const info = await getUploaderInfo(c.env, mid);
  return ok(c, info);
});

user.get('/:mid/videos', async (c) => {
  const mid = readMid(c, pathParam(c, 'mid'));
  const page = qInt(c, 'page', 1, { min: 1 });
  const pageSize = qInt(c, 'pageSize', 30, { min: 1, max: 50 });
  const keyword = qStr(c, 'keyword').trim();
  const order = qStr(c, 'order', 'pubdate').trim() || 'pubdate';

  const result = await getUploaderVideos(c.env, mid, {
    page,
    pageSize,
    ...(keyword ? { keyword } : {}),
    order,
  });

  /**
   * 软拦截告警。
   *
   * B 站对该接口的风控有两种形态：明确的 -412，以及**返回 code=0 但列表为空、
   * total=0 的「软拦截」**。后者在结构上与「该 UP 主确实没有投稿」完全一致，
   * 无法从响应本身区分。放任不管会让调用方拿到一个看起来合法的空列表 —— 也就是
   * 静默的错误答案（实测 mid=486906719 有 258919 个投稿，仍会返回 total=0）。
   * 因此这里不改判为错误（避免对真的没有投稿的 UP 主误报），而是显式附上告警。
   */
  const suspicious =
    result.items.length === 0 && result.total === 0 && page === 1 && keyword.length === 0;

  return ok(
    c,
    result,
    suspicious
      ? {
          warning:
            '返回空列表且 total=0。B 站对该接口存在「软拦截」：风控时会返回 code=0 但列表为空，与「该 UP 主确实没有投稿」在响应结构上无法区分。若该 UP 主确实有投稿，请稍后重试或在服务端配置 BILI_COOKIE。',
        }
      : undefined,
  );
});

export default user;
