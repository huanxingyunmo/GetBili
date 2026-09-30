/**
 * 接口公开策略 —— 多后端存储 + 路径模板匹配 + Hono 中间件。
 *
 * 存储后端优先级（readRaw/writeRaw 统一封装，上层无感）：
 *   1. Upstash REST KV（KV_REST_API_URL + KV_REST_API_TOKEN；Vercel KV 即此协议）—— 跨实例持久
 *   2. Cloudflare KV（POLICY_KV 绑定，仅 Workers 部署）—— 跨实例持久
 *   3. 实例内存 Map —— 兜底后端；serverless 多实例/冷启动会漂移，个人使用可接受
 *
 * 设计理由：
 * - 策略以单键（api_policy）整体存储：接口总量只有十几条，整体覆盖写入
 *   比逐键读写更简单，也天然避免半更新状态；
 * - 策略键统一为 ENDPOINTS 的 path 模板（如 /api/video/:id），请求路径先归一到
 *   模板再查策略，避免给每个具体路径单独配策略；
 * - 读取按「合法键 + 合法值」白名单过滤：存储里出现未知键或非法值时直接丢弃，
 *   防止脏数据把策略体系带崩；
 * - fail-closed：policyGuard 里「存在外部后端但读失败」时，把命中模板一律按
 *   'token' 处理 —— 管理员以为锁住的接口不能因为存储故障悄悄变成公开；
 *   而「完全没有任何存储后端」（从未配置过策略）全放行，保持开箱即用的默认公开语义；
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

/** 策略存储键 */
export const POLICY_KEY = 'api_policy';

/** 可被策略引用的全部目标：自描述入口 + 全部接口模板 */
export const POLICY_TARGETS: string[] = ['/api', ...ENDPOINTS.map((e) => e.path)];

/** 校验一个对象是否为合法可见性值 */
function isVisibility(value: unknown): value is ApiVisibility {
  return value === 'public' || value === 'token';
}

/** 解析存储原始值：只保留合法键（POLICY_TARGETS）与合法值（public|token） */
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

// ---------------------------- 存储后端 ----------------------------

/** 内存兜底后端（也是「无外部后端」时的唯一真实存储；serverless 实例内共享） */
const memStore = new Map<string, string>();

/** 是否配置了跨实例持久后端（Upstash REST / Cloudflare KV 任一） */
function hasPersistentStore(env: Env): boolean {
  return (
    (!!env.KV_REST_API_URL && !!env.KV_REST_API_TOKEN) || env.POLICY_KV !== undefined
  );
}

/** Upstash REST GET（Vercel KV 兼容协议）；失败抛错 */
async function kvRestGet(env: Env): Promise<string | null> {
  const base = (env.KV_REST_API_URL ?? '').replace(/\/+$/, '');
  const res = await fetch(`${base}/get/${encodeURIComponent(POLICY_KEY)}`, {
    headers: { Authorization: `Bearer ${env.KV_REST_API_TOKEN ?? ''}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`Upstash REST GET HTTP ${res.status}`);
  const json = (await res.json()) as { result?: string | null; error?: string | null };
  if (json.error) throw new Error(`Upstash REST GET 错误：${json.error}`);
  return json.result ?? null;
}

/** Upstash REST SET；失败抛错 */
async function kvRestSet(env: Env, value: string): Promise<void> {
  const base = (env.KV_REST_API_URL ?? '').replace(/\/+$/, '');
  const res = await fetch(`${base}/set/${encodeURIComponent(POLICY_KEY)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.KV_REST_API_TOKEN ?? ''}`,
      'Content-Type': 'text/plain',
    },
    body: value,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`Upstash REST SET HTTP ${res.status}`);
  const json = (await res.json()) as { error?: string | null };
  if (json.error) throw new Error(`Upstash REST SET 错误：${json.error}`);
}

/**
 * 读策略原始值。
 * - 返回 string / null：正常结果（null = 无数据）
 * - 抛错：存在外部后端但读失败（调用方决定 fail-closed 还是按空处理）
 */
async function readRaw(env: Env): Promise<string | null> {
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) {
    return kvRestGet(env);
  }
  if (env.POLICY_KV) {
    return env.POLICY_KV.get(POLICY_KEY);
  }
  return memStore.get(POLICY_KEY) ?? null;
}

/**
 * 写策略原始值。内存永远写入（兜底 + 本实例立即生效），
 * 配置了外部后端则同时写外部；外部写失败时抛出（内存已生效）。
 */
async function writeRaw(env: Env, value: string): Promise<void> {
  memStore.set(POLICY_KEY, value);
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) {
    await kvRestSet(env, value);
  } else if (env.POLICY_KV) {
    await env.POLICY_KV.put(POLICY_KEY, value);
  }
}

// ---------------------------- 对外接口 ----------------------------

export async function loadPolicy(env: Env): Promise<Record<string, ApiVisibility>> {
  if (!hasPersistentStore(env) && !memStore.has(POLICY_KEY)) return {};
  try {
    return parsePolicy(await readRaw(env));
  } catch {
    // 读失败按空策略处理（policyGuard 另有 fail-closed 兜底）
    return {};
  }
}

export async function savePolicy(env: Env, policy: Record<string, ApiVisibility>): Promise<void> {
  const allowed = new Set(POLICY_TARGETS);
  const clean: Record<string, ApiVisibility> = {};
  for (const [key, value] of Object.entries(policy)) {
    if (allowed.has(key) && isVisibility(value)) clean[key] = value;
  }
  await writeRaw(env, JSON.stringify(clean));
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

    if (!hasPersistentStore(c.env) && !memStore.has(POLICY_KEY)) {
      return next(); // 从未配置过策略存储：默认全公开
    }

    let visibility: ApiVisibility;
    try {
      const policy = parsePolicy(await readRaw(c.env));
      visibility = policy[template] ?? 'public';
    } catch {
      // fail-closed：外部后端故障时按「需令牌」处理，锁了的接口不会因故障裸奔
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
