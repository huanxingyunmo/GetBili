/**
 * HTTP 层小工具：统一响应信封、查询参数读取、CORS 与错误响应构造。
 *
 * 成功响应统一为 { code: 0, message: "ok", data: ... }
 * 失败响应统一为 { code: <非0>, message: "...", data: null }
 */

import type { Context } from 'hono';
import type { Env } from '../types';
import { BiliError } from './errors';

export type AppContext = Context<{ Bindings: Env }>;

/** 统一成功响应（始终 200） */
export function ok<T>(c: AppContext, data: T, meta?: Record<string, unknown>): Response {
  return jsonResponse(
    {
      code: 0,
      message: 'ok',
      data,
      ...(meta ? { meta } : {}),
    },
    200,
  );
}

/** 直接构造 JSON Response（不经过 Hono 的 c.json，避免状态码类型体操） */
export function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

/** 从 URL 路径参数中读取并解码（Hono 已解码，这里只做兜底） */
export function pathParam(c: AppContext, name: string): string {
  const raw = c.req.param(name) ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 读字符串查询参数 */
export function qStr(c: AppContext, name: string, fallback = ''): string {
  const value = c.req.query(name);
  if (value === undefined || value === null) return fallback;
  return value;
}

/** 读整数查询参数，带范围钳制 */
export function qInt(
  c: AppContext,
  name: string,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  let value = Math.trunc(n);
  if (opts.min !== undefined) value = Math.max(opts.min, value);
  if (opts.max !== undefined) value = Math.min(opts.max, value);
  return value;
}

/** 读布尔查询参数；`1/true/yes/on`（不分大小写）为真 */
export function qBool(c: AppContext, name: string, fallback = false): boolean {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

/** 解析允许的跨域来源（支持 "*"、单域名、逗号分隔白名单） */
export function resolveOrigin(c: AppContext): string {
  const configured = (c.env.CORS_ORIGIN ?? '*').trim();
  const requestOrigin = c.req.header('Origin') ?? '';

  if (configured === '' || configured === '*') {
    return requestOrigin || '*';
  }

  const allowList = configured
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (allowList.includes('*')) return requestOrigin || '*';
  if (requestOrigin && allowList.includes(requestOrigin)) return requestOrigin;
  return allowList[0] ?? '*';
}

export function applyCorsHeaders(headers: Headers, origin: string): void {
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type,Accept');
  headers.set('Access-Control-Max-Age', '86400');
  headers.append('Vary', 'Origin');
}

/** 把任意异常转成统一的 JSON 错误响应 */
export function errorToResponse(err: unknown, c: AppContext): Response {
  if (err instanceof BiliError) {
    return jsonResponse(
      {
        code: err.code,
        message: err.message,
        data: null,
        ...(err.detail === undefined ? {} : { detail: err.detail }),
      },
      err.status,
    );
  }

  const message = err instanceof Error ? err.message : String(err);
  return jsonResponse(
    {
      code: -500,
      message: `服务内部错误：${message}`,
      data: null,
      path: c.req.path,
    },
    500,
  );
}
