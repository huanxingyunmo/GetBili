/**
 * 上游请求层：统一封装 UA / Referer / Cookie / Origin 头、超时、重试与 JSON 解析。
 *
 * 约定：所有对 B 站的请求都必须经过本模块，以保证请求头一致（B 站对缺失
 * Referer / UA 的请求会返回 -412 风控）。
 */

import type { BiliEnvelope, Env } from '../types';
import { BiliError, biliCodeToStatus, upstreamError } from './errors';
import { fingerprintToCookieString, getFingerprint } from './fingerprint';
import { API_BASE, applyFakeCnIp, rewriteUpstreamUrl } from './upstream';

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export const MAIN_REFERER = 'https://www.bilibili.com';

export function getCookieString(env: Env, override?: string): string | undefined {
  const raw = override ?? env.BILI_COOKIE;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getUserAgent(env: Env): string {
  const raw = env.BILI_UA?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_UA;
}

export function getTimeoutMs(env: Env): number {
  const n = Number(env.REQUEST_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15000;
}

/** 是否处于「未登录」状态（用于决定是否附加 try_look=1） */
export function isAnonymous(env: Env): boolean {
  return getCookieString(env) === undefined;
}

/** try_look 开关，默认开启 */
export function tryLookEnabled(env: Env): boolean {
  return (env.TRY_LOOK ?? 'true').toLowerCase() !== 'false';
}

export interface FetchOptions {
  referer?: string;
  /** 覆盖默认 Cookie */
  cookie?: string;
  timeoutMs?: number;
  /** 额外重试次数（不含首次请求），默认 2 */
  retries?: number;
  headers?: Record<string, string>;
}

/**
 * 中国 IP 伪造（FAKE_CN_IP 实验）的实现统一放在 ./upstream 叶子模块：
 * fingerprint.ts 的裸 fetch 也必须注入同一个 IP（不能 import request，会循环依赖），
 * 且所有到 B 站的请求 IP 必须一致，否则「部分真实 IP + 部分伪造 IP」等于自报机器伪装。
 */
export function buildHeaders(env: Env, opts: FetchOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': getUserAgent(env),
    Referer: opts.referer ?? MAIN_REFERER,
    Origin: MAIN_REFERER,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...opts.headers,
  };
  applyFakeCnIp(env, headers);
  const cookie = getCookieString(env, opts.cookie);
  if (cookie) {
    headers.Cookie = cookie;
  }
  return headers;
}

/**
 * 解析最终 Cookie：用户配置的登录态 Cookie 优先；
 * 若其中没有 buvid3，则补上设备指纹（空间类接口缺它会直接 -352 风控失败）。
 */
async function resolveCookie(env: Env, override?: string): Promise<string | undefined> {
  const base = getCookieString(env, override);
  if (base && /buvid3=/i.test(base)) {
    return base;
  }
  const fingerprint = await getFingerprint(env, getUserAgent(env));
  const extra = fingerprintToCookieString(fingerprint);
  if (!base) return extra;
  return `${base}; ${extra}`;
}

export type QueryValue = string | number | boolean | undefined | null;

/** 构造完整 URL，空值参数（undefined / null / ""）会被丢弃 */
export function buildUrl(path: string, params: Record<string, QueryValue> = {}): string {
  const base = path.startsWith('http')
    ? path
    : `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * 发出上游请求，返回原始 Response（不做 JSON 解析）。
 * 网络异常与 5xx 会自动重试。
 */
export async function biliRaw(env: Env, url: string, opts: FetchOptions = {}): Promise<Response> {
  const retries = Math.max(0, opts.retries ?? 2);
  const timeoutMs = opts.timeoutMs ?? getTimeoutMs(env);
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const cookie = await resolveCookie(env, opts.cookie);
      const headers = buildHeaders(env, opts);
      if (cookie) {
        headers.Cookie = cookie;
      } else {
        delete headers.Cookie;
      }
      const res = await fetch(rewriteUpstreamUrl(env, url), {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 500 && attempt < retries) {
        lastError = new Error(`上游返回 HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) continue;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw upstreamError(`请求 B 站接口失败：${message}`, { url });
}

/** 请求上游并解析为 B 站响应信封（不校验 code） */
export async function biliEnvelope<T>(
  env: Env,
  url: string,
  opts: FetchOptions = {},
): Promise<BiliEnvelope<T>> {
  const res = await biliRaw(env, url, opts);
  const text = await res.text();
  try {
    return JSON.parse(text) as BiliEnvelope<T>;
  } catch {
    throw upstreamError(`上游返回非 JSON 内容（HTTP ${res.status}）`, {
      url,
      body: text.slice(0, 300),
    });
  }
}

/** 请求上游并直接返回 data；code !== 0 时抛出 BiliError */
export async function biliData<T>(env: Env, url: string, opts: FetchOptions = {}): Promise<T> {
  const envelope = await biliEnvelope<T>(env, url, opts);
  if (envelope.code !== 0) {
    throw new BiliError(envelope.message || `B 站接口返回 code=${envelope.code}`, {
      code: envelope.code,
      status: biliCodeToStatus(envelope.code),
      detail: envelope,
    });
  }
  return envelope.data;
}
