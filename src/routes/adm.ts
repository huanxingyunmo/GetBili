/**
 * 管理后台路由 —— 挂载在 /adm
 *
 *   GET  /adm             管理后台页面（HTML）。三态（未启用 / 登录 / 管理态）
 *                         由页面 JS 依 data-admin-enabled 属性与 session 接口自行切换，
 *                         服务端不做任何 HTML 模板拼装。
 *   POST /adm/login       令牌登录。校验通过 → Set-Cookie 会话凭证 + {code:0}；
 *                         校验失败 → 延迟 300ms 后 401「令牌不正确」；
 *                         ADMIN_TOKEN 未配置 → 404，与 requireAdmin 同文案。
 *   POST /adm/logout      清除会话 cookie，返回 {code:0}。
 *   GET  /adm/api/session 当前会话状态 { enabled, authed }。公开无门禁 —— 页面
 *                         初判必需，且只暴露布尔值，不泄露任何敏感信息。
 *   GET  /adm/api/policy  读取接口公开策略与接口契约列表（requireAdmin）。
 *   PUT  /adm/api/policy  保存接口公开策略（requireAdmin）。逐键校验：键必须是
 *                         matchEndpointTemplate 可识别的接口目标，值必须是
 *                         'public' | 'token'，非法一律 400；合法则落 KV 并返回
 *                         保存后的最新策略，方便前端直接同步本地状态。
 *
 * 伪装与防爆破：
 * - ADMIN_TOKEN 未配置时，/adm/login 与受保护接口一样返回 B 站风格 JSON 404，
 *   让探针无法区分「后台存在但未启用」与「接口不存在」；
 * - 登录失败统一延迟 300ms 再响应，抬高在线爆破的单次成本；成功路径不延迟，
 *   保持正常体验。
 *
 * 所有 handler 抛出的异常由 src/index.ts 最外层中间件统一转 JSON，无需逐个 try/catch。
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { admPage } from '../adm/page';
import { jsonResponse, ok, type AppContext } from '../lib/http';
import {
  requireAdmin,
  tokenMatches,
  hasAdminAccess,
  createSessionCookieValue,
  clearSessionCookieValue,
} from '../lib/auth';
import { loadPolicy, savePolicy, matchEndpointTemplate } from '../lib/policy';
import { ENDPOINTS } from '../lib/endpoints';

/**
 * B 站风格 JSON 404 —— 文案与 src/lib/auth.ts 里 requireAdmin / policyGuard 的
 * 无权限拦截响应逐字一致（接口不存在：METHOD PATH），保证探测者无法从响应
 * 形态区分「无权限」与「后台未启用」。
 */
function disguisedNotFound(c: AppContext): Response {
  return jsonResponse(
    { code: -404, message: `接口不存在：${c.req.method} ${c.req.path}`, data: null },
    404,
  );
}

const adm = new Hono<{ Bindings: Env }>();

// 页面本体；body 属性注入 enabled 标志的逻辑在 admPage() 内
adm.get('/', (c) => admPage(c.env));

adm.post('/login', async (c) => {
  // 未配置令牌 = 后台未启用：伪装成接口不存在，不暴露后台部署事实
  if (!c.env.ADMIN_TOKEN) {
    return disguisedNotFound(c);
  }

  // body 解析失败按「令牌为空」处理，走同一条失败路径，避免区分性响应
  let candidate = '';
  try {
    const body = await c.req.json<{ token?: unknown }>();
    candidate = typeof body?.token === 'string' ? body.token : '';
  } catch {
    candidate = '';
  }

  const passed = candidate !== '' && (await tokenMatches(c.env, candidate));
  if (!passed) {
    // 防爆破：失败路径统一延迟，抹平「空令牌 / 错令牌」的响应时间差异
    await new Promise((r) => setTimeout(r, 300));
    return jsonResponse({ code: -401, message: '令牌不正确', data: null }, 401);
  }

  const cookie = await createSessionCookieValue(c.env);
  return jsonResponse({ code: 0, message: 'ok', data: null }, 200, { 'Set-Cookie': cookie });
});

// 登出只是清 cookie，无论当前是否登录都幂等返回成功
adm.post('/logout', (c) =>
  jsonResponse({ code: 0, message: 'ok', data: null }, 200, {
    'Set-Cookie': clearSessionCookieValue(c.env),
  }),
);

// 会话状态：页面启动时第一个调用的接口。enabled=false 时不再问 authed，
// 避免在后台未启用时触发无意义的会话校验。
adm.get('/api/session', async (c) => {
  const enabled = c.env.ADMIN_TOKEN !== undefined && c.env.ADMIN_TOKEN !== '';
  const authed = enabled ? await hasAdminAccess(c.env, c.req.raw.headers) : false;
  return ok(c, { enabled, authed });
});

// 策略读取：返回策略本体 + 接口契约，前端一次请求即可渲染完整列表
adm.get('/api/policy', requireAdmin(), async (c) =>
  ok(c, { policy: await loadPolicy(c.env), endpoints: ENDPOINTS }),
);

// 策略保存：逐键校验后落 KV。键允许两种形态 —— 模板串（ENDPOINTS 里的 path）
// 或能匹配到某个模板的具体路径，后者统一归一化为模板，避免策略表出现碎片键。
adm.put('/api/policy', requireAdmin(), async (c) => {
  let raw: unknown;
  try {
    const body = await c.req.json<{ policy?: unknown }>();
    raw = body?.policy;
  } catch {
    return jsonResponse({ code: -400, message: '参数错误：请求体必须是 JSON', data: null }, 400);
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return jsonResponse({ code: -400, message: '参数错误：policy 必须是对象', data: null }, 400);
  }

  const knownTemplates = new Set(ENDPOINTS.map((e) => e.path));
  const normalized: Record<string, 'public' | 'token'> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== 'public' && value !== 'token') {
      return jsonResponse(
        { code: -400, message: '参数错误：策略值只能是 public 或 token', data: null },
        400,
      );
    }
    const template = matchEndpointTemplate(key);
    if (template === null && !knownTemplates.has(key)) {
      return jsonResponse({ code: -400, message: '参数错误：未知的接口路径 ' + key, data: null }, 400);
    }
    normalized[template ?? key] = value;
  }

  await savePolicy(c.env, normalized);
  return ok(c, { policy: await loadPolicy(c.env), endpoints: ENDPOINTS });
});

export default adm;
