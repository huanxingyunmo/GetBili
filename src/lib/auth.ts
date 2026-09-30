/**
 * 管理后台认证 —— ADMIN_TOKEN 校验、HMAC 签名会话 cookie、Hono 中间件。
 *
 * 设计理由：
 * - 全部基于 Workers 内置 Web Crypto（全局 crypto.subtle，@cloudflare/workers-types
 *   以 declare const crypto 声明，与 src/lib/fingerprint.ts 用法一致），不引入任何依赖；
 * - HMAC 密钥不直接使用 ADMIN_TOKEN，而是派生为 hex(SHA-256(token + 盐))：
 *   即使签名值泄露也无法反推 token 本身，盐带版本号便于日后轮换算法；
 * - 所有秘密比较走常量时间路径（候选 token 先 SHA-256 再逐字节比较，
 *   签名 hex 逐字符比较），避免时序侧信道泄露；
 * - ADMIN_TOKEN 未配置时整个认证体系不可用：一切校验恒返回 false，
 *   杜绝「空 token 也能登录」的退化行为；
 * - 被拦截请求返回与全局 404 同构的 B 站风格 JSON，让探测者无法区分
 *   「接口不存在」与「无权限」。
 */

import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types';
import { jsonResponse } from './http';

/** 管理会话 cookie 名 */
export const SESSION_COOKIE = 'gb_adm';

/** 会话有效期（秒），默认 86400（24h） */
export const SESSION_MAX_AGE = 86400;

/** HMAC 密钥派生盐（版本化，便于日后轮换派生算法） */
const KEY_DERIVE_SALT = '::getbili-admin-session-v1';

/** 签名截取 hex 前 32 位（128 bit），足够防伪造且缩短 cookie 值 */
const SIG_LEN = 32;

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * 由 ADMIN_TOKEN 派生 HMAC-SHA256 密钥。
 * ADMIN_TOKEN 未配置时返回 null（整个认证体系不可用）。
 */
async function sessionKey(env: Env): Promise<CryptoKey | null> {
  const token = env.ADMIN_TOKEN;
  if (token === undefined || token === '') return null;
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token + KEY_DERIVE_SALT));
  // 用摘要的 hex 字符串（64 字节 ASCII）作为 HMAC key 材料
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(toHex(new Uint8Array(digest))),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** 用会话密钥对 message 做 HMAC-SHA256，返回完整 hex；密钥不可用时返回 null */
async function signHex(env: Env, message: string): Promise<string | null> {
  const key = await sessionKey(env);
  if (key === null) return null;
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(new Uint8Array(sig));
}

/**
 * 常量时间字符串比较：逐字符 XOR 累积差异，长度不同也走完整个循环，
 * 避免提前返回暴露「前缀对了多少」。charCodeAt 越界返回 NaN，|0 后为 0。
 */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length === b.length ? 0 : 1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

export async function tokenMatches(env: Env, candidate: string): Promise<boolean> {
  const expected = env.ADMIN_TOKEN;
  if (expected === undefined || expected === '') return false;
  // 两侧先 SHA-256（摘要定长 32 字节），再逐字节常量时间比较
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(candidate)));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(expected)));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 从 Cookie 头里取指定名字的值（取第一个匹配项），没有则 null */
function readCookie(headers: Headers, name: string): string | null {
  const header = headers.get('Cookie');
  if (header === null) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** 解析 cookie 值 "<expMs>.<sigHex>"；任何格式异常返回 null（绝不抛错） */
function parseSessionValue(value: string): { expMs: number; sig: string } | null {
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const expRaw = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d+$/.test(expRaw) || !/^[0-9a-f]+$/i.test(sig)) return null;
  const expMs = Number(expRaw);
  if (!Number.isSafeInteger(expMs) || expMs <= Date.now()) return null;
  return { expMs, sig };
}

export async function hasValidSession(env: Env, headers: Headers): Promise<boolean> {
  try {
    const raw = readCookie(headers, SESSION_COOKIE);
    if (raw === null) return false;
    const session = parseSessionValue(raw);
    if (session === null) return false;
    const expected = await signHex(env, String(session.expMs));
    if (expected === null) return false;
    return constantTimeEqual(session.sig.toLowerCase(), expected.slice(0, SIG_LEN));
  } catch {
    // 解析 / 校验中的任何异常一律视为无会话，绝不抛错
    return false;
  }
}

export async function hasAdminAccess(env: Env, headers: Headers): Promise<boolean> {
  const auth = headers.get('Authorization');
  if (auth !== null) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m !== null && (await tokenMatches(env, m[1].trim()))) return true;
  }
  return hasValidSession(env, headers);
}

export async function createSessionCookieValue(env: Env, maxAgeSec: number = SESSION_MAX_AGE): Promise<string> {
  const expMs = Date.now() + maxAgeSec * 1000;
  const sig = await signHex(env, String(expMs));
  if (sig === null) throw new Error('ADMIN_TOKEN 未配置，无法签发管理会话');
  const value = `${expMs}.${sig.slice(0, SIG_LEN)}`;
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}; Secure`;
}

export function clearSessionCookieValue(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure`;
}

export function requireAdmin(): MiddlewareHandler {
  return async (c, next) => {
    if (await hasAdminAccess(c.env, c.req.raw.headers)) return next();
    // 与全局 notFound 同构的 B 站风格 JSON 404：不暴露「无权限」信号
    return jsonResponse(
      { code: -404, message: `接口不存在：${c.req.method} ${c.req.path}`, data: null },
      404,
    );
  };
}
