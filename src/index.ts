/**
 * GetBili —— 哔哩哔哩视频信息 API 服务（Cloudflare Workers + Hono）
 *
 * 入口职责：CORS、统一错误处理、路由挂载、服务自描述。
 * 业务逻辑全部在 src/bili/*，路由装配在 src/routes/*。
 */

import { Hono } from 'hono';
import type { Env } from './types';
import { applyCorsHeaders, errorToResponse, jsonResponse, ok, resolveOrigin } from './lib/http';
import { getCookieString, tryLookEnabled } from './lib/request';
import videoRoutes from './routes/video';
import userRoutes from './routes/user';
import searchRoutes from './routes/search';
import favlistRoutes from './routes/favlist';

const SERVICE = {
  name: 'GetBili API',
  version: '0.1.0',
  description:
    '哔哩哔哩视频信息 / 播放地址 / 分P / 弹幕 / UP 主 / 搜索 / 合集收藏夹 接口服务，运行于 Cloudflare Workers。',
  docs: 'GET / 或 GET /api 可查看全部接口',
  disclaimer: '本项目仅供学习和研究使用，请遵守哔哩哔哩用户协议及相关法律法规。',
};

const ENDPOINTS = [
  { method: 'GET', path: '/api/video/:id', desc: '视频详情（支持 BV 号 / av 号 / 视频链接）', query: 'qualities=1 附带可用清晰度探测；pages=0 省略分P' },
  { method: 'GET', path: '/api/video/:id/pages', desc: '分 P 列表', query: '' },
  { method: 'GET', path: '/api/video/:id/playurl', desc: '播放地址（DASH 音视频流 / durl）', query: 'qn=80 清晰度；cid= 指定分P' },
  { method: 'GET', path: '/api/video/:id/qualities', desc: '可用清晰度列表', query: 'cid= 指定分P' },
  { method: 'GET', path: '/api/video/:id/danmaku', desc: '弹幕，format=json 返回数组，format=xml 返回标准 XML', query: 'format=json|xml；segment= 指定分段；maxSegments= 最大分段数' },
  { method: 'GET', path: '/api/video/:id/collection', desc: '该视频所属合集及全部视频', query: '' },
  { method: 'GET', path: '/api/user/:mid', desc: 'UP 主信息', query: '' },
  { method: 'GET', path: '/api/user/:mid/videos', desc: 'UP 主投稿列表', query: 'page=1；pageSize=30；keyword=；order=pubdate|click' },
  { method: 'GET', path: '/api/search/video', desc: '视频搜索', query: 'keyword=必填；page=1；pageSize=20；order=totalrank|click|pubdate|danmaku|stow' },
  { method: 'GET', path: '/api/search/user', desc: 'UP 主搜索', query: 'keyword=必填；page=1；pageSize=20' },
  { method: 'GET', path: '/api/favlist/:mediaId', desc: '收藏夹内容', query: 'page=1；pageSize=20' },
  { method: 'GET', path: '/api/health', desc: '健康检查', query: '' },
];

const app = new Hono<{ Bindings: Env }>();

/**
 * 最外层中间件：CORS + 统一错误处理。
 *
 * 这里没有用 hono/cors，而是自己处理 —— 因为中间件的「后置代码」在处理器抛错时
 * 不会执行，会导致错误响应缺少 CORS 头，浏览器端只能看到一个不透明的网络错误。
 * 自己 try/catch 能保证**任何**响应（含 4xx/5xx）都带上 CORS 头。
 */
app.use('*', async (c, next) => {
  const origin = resolveOrigin(c);

  if (c.req.method === 'OPTIONS') {
    c.res = new Response(null, { status: 204 });
    applyCorsHeaders(c.res.headers, origin);
    return;
  }

  try {
    await next();
  } catch (err) {
    c.res = errorToResponse(err, c);
  }

  applyCorsHeaders(c.res.headers, origin);
});

// ---------------------------- 服务自描述 ----------------------------

app.get('/', (c) =>
  ok(c, {
    service: SERVICE,
    auth: {
      usingCookie: getCookieString(c.env) !== undefined,
      tryLook: tryLookEnabled(c.env),
      hint: '未配置 BILI_COOKIE 时以游客身份请求（仅能获取到低清晰度流）；配置后请通过 try_look 关闭该降级行为。',
    },
    endpoints: ENDPOINTS,
  }),
);

app.get('/api', (c) => ok(c, { service: SERVICE, endpoints: ENDPOINTS }));

app.get('/api/health', (c) =>
  ok(c, {
    status: 'ok',
    time: new Date().toISOString(),
    anonymous: getCookieString(c.env) === undefined,
  }),
);

// ---------------------------- 业务路由 ----------------------------

app.route('/api/video', videoRoutes);
app.route('/api/user', userRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/favlist', favlistRoutes);

// ---------------------------- 兜底 ----------------------------

app.notFound((c) =>
  jsonResponse(
    {
      code: -404,
      message: `接口不存在：${c.req.method} ${c.req.path}`,
      data: null,
      hint: 'GET / 可查看全部可用接口',
    },
    404,
  ),
);

// 双保险：正常错误已在中间件里转成 JSON，这里兜住中间件之外抛出的异常
app.onError((err, c) => errorToResponse(err, c));

export default app;
