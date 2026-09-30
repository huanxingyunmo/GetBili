/**
 * 接口公开策略 —— KV 存储 + 路径模板匹配 + Hono 中间件。
 *
 * 设计理由：
 * - 策略以 KV 单键（api_policy）整体存储：接口总量只有十几条，整体覆盖写入
 *   比逐键读写更简单，也天然避免半更新状态；
 * - 策略键统一为 ENDPOINTS 的 path 模板（如 /api/video/:id），请求路径先归一到
 *   模板再查策略，避免给每个具体路径（/api/video/BV1xx/playurl）单独配策略；
 * - 读取按「合法键 + 合法值」白名单过滤：KV 里出现未知键或非法值时直接丢弃，
 *   防止脏数据把策略体系带崩；
 * - fail-closed：policyGuard 里 KV 读失败时，把命中模板一律按 'token' 处理 ——
 *   管理员以为锁住的接口不能因为 KV 故障悄悄变成公开；而 KV 完全未绑定时
 *   （部署从未配置过策略）全放行，保持开箱即用的默认公开语义；
 * - 拦截响应与 requireAdmin 完全一致（B 站风格 JSON 404），探测者无法据此
 *   区分「不存在 / 无权限 / 被策略隐藏」。
 */

import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types';
import { jsonResponse } from './http';
import { ENDPOINTS } from './endpoints';
import { hasAdminAccess } from './auth';

/** 接口可见性：public=默认公开；token=需要管理访问（会话或 Bearer 令牌） */
export type ApiVisibility = 'public' | 'token';

/** 策略 KV 键 */
export const POLICY_KEY = 'api_policy';

/** 可被策略引用的全部目标：自描述入口 + 全部接口模板 */
export const POLICY_TARGETS: string[] = ['/api', ...ENDPOINTS.map((e) => e.path)];

/** 校验一个对象是否为合法可见性值 */
function isVisibility(value: unknown): value is ApiVisibility {
  return value === 'public' || value === 'token';
}

/** 解析 KV 原始值：只保留合法键（POLICY_TARGETS）与合法值（public|token） */
function parsePolicy(raw: string | null): Record<string, ApiVisibility> {
  if (raw === null || raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const allowed = new Set(POLICY_TARGETS);
  const result: Record<string, ApiVisibility> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (allowed.has(key) && isVisibility(value)) result[key] = value;
  }
  return result;
}

export async function loadPolicy(env: Env): Promise<Record<string, ApiVisibility>> {
  if (env.POLICY_KV === undefined) return {};
  try {
    return parsePolicy(await env.POLICY_KV.get(POLICY_KEY));
  } catch {
    // 读失败按空策略处理（policyGuard 另有 fail-closed 兜底）
    return {};
  }
}

export async function savePolicy(env: Env, policy: Record<string, ApiVisibility>): Promise<void> {
  if (env.POLICY_KV === undefined) throw new Error('POLICY_KV 未绑定，无法保存接口公开策略');
  const allowed = new Set(POLICY_TARGETS);
  const clean: Record<string, ApiVisibility> = {};
  for (const [key, value] of Object.entries(policy)) {
    if (allowed.has(key) && isVisibility(value)) clean[key] = value;
  }
  await env.POLICY_KV.put(POLICY_KEY, JSON.stringify(clean));
}

export function matchEndpointTemplate(pathname: string): string | null {
  // 先精确匹配（覆盖 '/api' 这类无模板段的目标，也兼得性能）
  if (POLICY_TARGETS.includes(pathname)) return pathname;
  // 再按模板匹配：段数一致，且每个模板段为 ':xxx' 或与请求段字面量相等；
  // 多个模板都能命中时取 POLICY_TARGETS 里的第一个（声明顺序即优先级）
  const reqSegs = pathname.split('/');
  for (const target of POLICY_TARGETS) {
    if (!target.includes(':')) continue;
    const tSegs = target.split('/');
    if (tSegs.length !== reqSegs.length) continue;
    let matched = true;
    for (let i = 0; i < tSegs.length; i++) {
      const seg = tSegs[i];
      if (seg.startsWith(':')) continue;
      if (seg !== reqSegs[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return target;
  }
  return null;
}

export function policyGuard(): MiddlewareHandler {
  return async (c, next) => {
    const template = matchEndpointTemplate(c.req.path);
    if (template === null) return next();

    const kv = c.env.POLICY_KV;
    if (kv === undefined) return next(); // KV 完全未绑定：默认全公开

    let visibility: ApiVisibility;
    try {
      const policy = parsePolicy(await kv.get(POLICY_KEY));
      visibility = policy[template] ?? 'public';
    } catch {
      // fail-closed：KV 故障时按「需令牌」处理，锁了的接口不会因故障裸奔
      visibility = 'token';
    }

    if (visibility === 'token' && !(await hasAdminAccess(c.env, c.req.raw.headers))) {
      return jsonResponse(
        { code: -404, message: `接口不存在：${c.req.method} ${c.req.path}`, data: null },
        404,
      );
    }
    return next();
  };
}
