/**
 * GetBili —— 哔哩哔哩视频信息 API 服务（Cloudflare Workers + Hono）
 *
 * 入口职责：CORS、访问控制与 404 伪装、接口公开策略、统一错误处理、路由挂载、
 * 服务自描述。业务逻辑全部在 src/bili/*，路由装配在 src/routes/*。
 *
 * 访问控制总览（未配置 ADMIN_TOKEN 时一律按「无登录态」处理，伪装仍然生效）：
 * - GET / 与 GET /api 是服务性质泄露点，未登录一律返回 Cloudflare 风格 404 伪装页；
 * - /ui 控制台由 uiGate 把关，未登录同样 404 伪装，不暴露控制台存在；
 * - /adm 管理后台自带会话门禁（见 src/routes/adm.ts）；
 * - /api/* 业务接口由 policyGuard 按公开策略放行或要求登录；
 * - /api/health 保持公开：管理页的健康检查 pill 依赖它。
 */

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Env } from './types';
import {
  applyCorsHeaders,
  errorToResponse,
  jsonResponse,
  ok,
  resolveOrigin,
  type AppContext,
} from './lib/http';
import { getCookieString, tryLookEnabled } from './lib/request';
import videoRoutes from './routes/video';
import userRoutes from './routes/user';
import searchRoutes from './routes/search';
import favlistRoutes from './routes/favlist';
import uiRoutes, { uiPage } from './routes/ui';
import admRoutes from './routes/adm';
import { cf404Page } from './disguise/page';
import { hasAdminAccess } from './lib/auth';
import { policyGuard } from './lib/policy';
import { ENDPOINTS } from './lib/endpoints';

const SERVICE = {
  name: 'GetBili API',
  version: '0.1.0',
  description:
    '哔哩哔哩视频信息 / 播放地址 / 分P / 弹幕 / UP 主 / 搜索 / 合集收藏夹 接口服务，运行于 Cloudflare Workers。',
  docs: 'GET / 或 GET /api 可查看全部接口（需登录）；GET /ui 打开浏览器控制台（需登录）；GET /adm 管理后台',
  disclaimer: '本项目仅供学习和研究使用，请遵守哔哩哔哩用户协议及相关法律法规。',
};

/**
 * 浏览器控制台页面。
 *
 * 单独放在 endpoints 之外：endpoints 是对外 API 契约（12 个 JSON 接口），
 * 把 HTML 页面混进去会让「接口数」这个指标变得没有意义。
 */
const CONSOLE_PAGE = {
  path: '/ui',
  desc: '浏览器控制台页面（HTML），可交互地调试全部接口（需登录）',
};

/**
 * Cloudflare 风格 404 伪装页。
 *
 * 所有「未登录就不该被看见」的入口共用它：访客看到的是一页与真实 Cloudflare
 * 404 一致的白页，无法从响应形态推断出后面部署了什么服务。host / clientIp
 * 仅用于页面文案还原真实 Cloudflare 报错的样子（Ray ID 等由 cf404Page 内部伪造）。
 */
async function disguiseOr404(c: AppContext): Promise<Response> {
  return cf404Page({
    host: c.req.header('host') ?? 'unknown',
    clientIp: c.req.header('CF-Connecting-IP') ?? '1.1.1.1',
  });
}

/**
 * /ui 控制台门槛：未登录直接 404 伪装，不暴露控制台存在。
 *
 * 两条 use（精确路径 + 子路径）都要挂：Hono 的 /ui/* 不匹配 /ui 本身。
 * 必须注册在最外层 CORS 中间件之后、app.route('/ui') 之前 —— 前者保证伪装
 * 404 也统一带 CORS 头，后者保证门槛先于页面路由生效。
 */
const uiGate: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!(await hasAdminAccess(c.env, c.req.raw.headers))) {
    c.res = await disguiseOr404(c);
    return;
  }
  await next();
};

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

/**
 * 接口公开策略：/api 精确路径与子路径各挂一条（/api/* 不匹配 /api 本身）。
 *
 * 位置必须在 CORS 中间件之后、所有 /api 路由注册之前 —— 挂在 CORS 前会让
 * 策略拦截响应（404/401）丢失 CORS 头；OPTIONS 预检已在外层中间件直接短路，
 * 不受策略影响。/adm 自带 requireAdmin 门禁，不走策略。
 */
app.use('/api', policyGuard());
app.use('/api/*', policyGuard());

// /ui 门槛同理：必须在 CORS 之后（丢头问题相同）、app.route('/ui') 之前
app.use('/ui', uiGate);
app.use('/ui/*', uiGate);

// ---------------------------- 服务自描述（需登录） ----------------------------

app.get('/', async (c) => {
  // 首页自描述会列出全部接口契约，属于服务性质泄露点，未登录一律伪装 404
  if (!(await hasAdminAccess(c.env, c.req.raw.headers))) {
    return disguiseOr404(c);
  }
  return ok(c, {
    service: SERVICE,
    auth: {
      usingCookie: getCookieString(c.env) !== undefined,
      tryLook: tryLookEnabled(c.env),
      hint: '未配置 BILI_COOKIE 时以游客身份请求（仅能获取到低清晰度流）；配置后请通过 try_look 关闭该降级行为。',
    },
    console: CONSOLE_PAGE,
    endpoints: ENDPOINTS,
  });
});

app.get('/api', async (c) => {
  // 与首页同逻辑：/api 是无参自描述端点，泄露面比首页更大
  if (!(await hasAdminAccess(c.env, c.req.raw.headers))) {
    return disguiseOr404(c);
  }
  return ok(c, { service: SERVICE, console: CONSOLE_PAGE, endpoints: ENDPOINTS });
});

// 健康检查保持公开：管理页顶栏的 up/down pill 依赖它；策略默认 public
app.get('/api/health', (c) =>
  ok(c, {
    status: 'ok',
    time: new Date().toISOString(),
    anonymous: getCookieString(c.env) === undefined,
  }),
);

// ---------------------------- 控制台页面（uiGate 已在上方注册） ----------------------------

app.route('/ui', uiRoutes);

// Hono 的路由默认 strict：/ui 与 /ui/ 是两条不同路径。
// 手输地址或从别处跳转很容易多带一个尾斜杠，这里显式补一条，避免拿到 404。
app.get('/ui/', () => uiPage());

// ---------------------------- 管理后台 ----------------------------

app.route('/adm', admRoutes);

// 与 /ui/ 同理：Hono strict 路由下 /adm/ 不会命中 sub.get('/')，显式 302 归一
// 到无斜杠形式，登录后的重定向与手输地址都能落在同一条 URL 上。
app.get('/adm/', (c) => c.redirect('/adm', 302));

// ---------------------------- 业务路由 ----------------------------

app.route('/api/video', videoRoutes);
app.route('/api/user', userRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/favlist', favlistRoutes);

// ---------------------------- 兜底 ----------------------------

/**
 * 404 兜底：区分浏览器与 API 调用方。
 *
 * 与真实 Cloudflare 行为一致：仅对 HTML 请求渲染错误页 —— 浏览器直接访问
 * 一个不存在的路径时看到的是 Cloudflare 风格 404 伪装页，不暴露本服务的存在；
 * API 请求（Accept 不含 text/html）仍返回原 JSON 404，调用方契约不变。
 */
app.notFound((c) => {
  const accept = c.req.header('Accept') ?? '';
  if (accept.includes('text/html')) {
    return disguiseOr404(c);
  }
  return jsonResponse(
    {
      code: -404,
      message: `接口不存在：${c.req.method} ${c.req.path}`,
      data: null,
      hint: 'GET / 可查看全部可用接口',
    },
    404,
  );
});

// 双保险：正常错误已在中间件里转成 JSON，这里兜住中间件之外抛出的异常
app.onError((err, c) => errorToResponse(err, c));

export default app;
