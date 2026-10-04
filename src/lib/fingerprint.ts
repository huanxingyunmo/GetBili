/**
 * B 站设备指纹（buvid3 / buvid4 / b_lsid / _uuid / buvid_fp）。
 *
 * 为什么需要：空间类接口（`/x/space/wbi/*`）在缺指纹时会返回
 *   -352「风控校验失败」或 -412「request was banned」，
 * 与 WBI 签名是否正确无关。带上完整指纹后即可正常返回数据。
 *
 * 获取优先级：
 *   1. 官方 SPI 接口 `/x/frontend/finger/spi` → data.b_3 / data.b_4（推荐）
 *   2. 抓 `https://www.bilibili.com/` 响应头 Set-Cookie 里的 buvid3
 *   3. 随机生成一个合法形态的兜底值（几乎拿不到数据，但不会崩）
 *
 * 结果缓存在模块作用域（Workers 实例复用时可跨请求生效）。
 *
 * 依赖说明：只依赖 types（纯类型）、md5（叶子模块）与 upstream（叶子模块，
 * 提供 URL 重写）。不 import ./request —— 否则会与 request.ts（它需要 import 本模块）
 * 形成循环依赖。因此 UA 由调用方以参数传入。
 */

import type { Env } from '../types';
import { md5Hex } from './md5';
import { applyFakeCnIp, rewriteUpstreamUrl } from './upstream';

export interface Fingerprint {
  buvid3: string;
  buvid4: string;
  /** md5(buvid4 + 时间戳 + 随机数)，B 站前端会上报该指纹 */
  buvidFp: string;
  bNut: string;
  /** randomHex(8) + "_" + 时间戳十六进制 */
  bLsid: string;
  /** 形如 xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxxinfoc */
  uuid: string;
  /** web 票据，空间类接口缺它会被判 -412「request was banned」 */
  ticket: string;
  /** 票据过期时间戳（秒） */
  ticketExpires: string;
}

const SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi';
const HOME_URL = 'https://www.bilibili.com/';
const TICKET_URL = 'https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket';
/** 票据签名用的固定密钥（B 站 web 端硬编码） */
const TICKET_HMAC_KEY = 'XgwSnGZ1p';
const TICKET_KEY_ID = 'ec02';
/** 缓存 6 小时（票据本身有效期约 3 天，指纹其余字段无有效期） */
const TTL_MS = 6 * 60 * 60 * 1000;

let cache: { value: Fingerprint; fetchedAt: number } | null = null;
let inflight: Promise<Fingerprint | null> | null = null;

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex.slice(0, length);
}

/** buvid3 兜底值（B 站旧格式：hex 段 + infoc 结尾） */
function fallbackBuvid3(): string {
  return `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}infoc`;
}

/** _uuid：8-4-4-4-12 结构，第 3 段以 4 开头，末尾拼 infoc */
function generateUuid(): string {
  const variant = '89ab'[Math.floor(Math.random() * 4)];
  return `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-${variant}${randomHex(3)}-${randomHex(12)}infoc`;
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

function timestampHex(): string {
  return Math.floor(Date.now() / 1000).toString(16);
}

/** 基于 buvid4 生成 buvid_fp */
function buildBuvidFp(buvid4: string): string {
  return md5Hex(`${buvid4}${Date.now()}${Math.random()}`);
}

function buildFingerprint(
  buvid3: string,
  buvid4: string,
  ticket: string,
  ticketExpires: string,
): Fingerprint {
  const seed = buvid4 || buvid3;
  return {
    buvid3,
    buvid4,
    buvidFp: buildBuvidFp(seed),
    bNut: nowSeconds(),
    bLsid: `${randomHex(8)}_${timestampHex()}`,
    uuid: generateUuid(),
    ticket,
    ticketExpires,
  };
}

/** HMAC-SHA256 十六进制（WebCrypto，浏览器/Workers/Node 均可用） */
async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  let hex = '';
  for (const byte of new Uint8Array(signature)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * 申请 web 票据（bili_ticket）。
 * 流程：ts = 当前秒 → hexsign = HMAC-SHA256("XgwSnGZ1p", "ts"+ts) →
 * POST GenWebTicket?key_id=ec02&hexsign=..&context[ts]=..&csrf=
 */
async function fetchBiliTicket(
  env: Env,
  userAgent: string,
  buvid3: string,
  timeoutMs: number,
): Promise<{ ticket: string; expires: string } | null> {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const hexsign = await hmacSha256Hex(TICKET_HMAC_KEY, `ts${ts}`);
    const query = new URLSearchParams({
      key_id: TICKET_KEY_ID,
      hexsign,
      'context[ts]': String(ts),
      csrf: '',
    });
    const res = await fetch(rewriteUpstreamUrl(env, `${TICKET_URL}?${query.toString()}`), {
      method: 'POST',
      headers: applyFakeCnIp(env, {
        'User-Agent': userAgent,
        Referer: 'https://www.bilibili.com/',
        Origin: 'https://www.bilibili.com',
        Cookie: `buvid3=${buvid3}`,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as {
      code?: number;
      data?: { ticket?: string; created_at?: number; ttl?: number };
    };
    const ticket = json?.data?.ticket;
    if (ticket) {
      const created = json.data?.created_at ?? ts;
      const ttl = json.data?.ttl ?? 259200;
      return { ticket, expires: String(created + ttl) };
    }
  } catch {
    /* 票据失败不致命，退化为仅指纹 */
  }
  return null;
}

async function fetchJson<T>(
  env: Env,
  url: string,
  userAgent: string,
  timeoutMs: number,
): Promise<T | null> {
  try {
    const res = await fetch(rewriteUpstreamUrl(env, url), {
      headers: applyFakeCnIp(env, {
        'User-Agent': userAgent,
        Referer: 'https://www.bilibili.com/',
        Accept: 'application/json, text/plain, */*',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchFingerprint(env: Env, userAgent: string): Promise<Fingerprint | null> {
  const timeoutMs = Number(env.REQUEST_TIMEOUT_MS) > 0 ? Number(env.REQUEST_TIMEOUT_MS) : 15000;

  let buvid3 = '';
  let buvid4 = '';

  // 1) 官方 SPI 接口（同时给 buvid3 与 buvid4，最省事）
  const spi = await fetchJson<{ code?: number; data?: { b_3?: string; b_4?: string } }>(
    env,
    SPI_URL,
    userAgent,
    timeoutMs,
  );
  if (spi?.data?.b_3) {
    buvid3 = spi.data.b_3;
    buvid4 = spi.data.b_4 ?? '';
  }

  // 2) 抓首页 Set-Cookie
  if (!buvid3) {
    try {
      const res = await fetch(rewriteUpstreamUrl(env, HOME_URL), {
        headers: applyFakeCnIp(env, { 'User-Agent': userAgent }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const setCookie = res.headers.get('set-cookie') ?? '';
      const match = setCookie.match(/buvid3=([^;,\s]+)/);
      if (match?.[1]) {
        buvid3 = match[1];
        buvid4 = setCookie.match(/buvid4=([^;,\s]+)/)?.[1] ?? '';
      }
    } catch {
      /* 落到下一步兜底 */
    }
  }

  // 3) 随机兜底
  if (!buvid3) {
    buvid3 = fallbackBuvid3();
    buvid4 = randomHex(32);
  }

  const ticketInfo = await fetchBiliTicket(env, userAgent, buvid3, timeoutMs);
  return buildFingerprint(
    buvid3,
    buvid4,
    ticketInfo?.ticket ?? '',
    ticketInfo?.expires ?? '',
  );
}

/** 取设备指纹（带缓存 + 并发去重）；不会抛错，最差返回随机兜底值 */
export async function getFingerprint(env: Env, userAgent: string): Promise<Fingerprint> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) {
    return cache.value;
  }
  if (!inflight) {
    inflight = fetchFingerprint(env, userAgent)
      .then((value) => {
        if (value) cache = { value, fetchedAt: Date.now() };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  const resolved = await inflight;
  return resolved ?? buildFingerprint(fallbackBuvid3(), randomHex(32), '', '');
}

/** 让下一次取指纹时强制重新拉取（指纹失效导致 -352 / -412 时使用） */
export function invalidateFingerprint(): void {
  cache = null;
}

/**
 * 转成 Cookie 串片段。
 * 字段对齐 B 站 web 端实际携带的指纹 cookie 集合 —— 缺字段容易被风控拦截。
 */
export function fingerprintToCookieString(fp: Fingerprint): string {
  const pairs: Array<[string, string]> = [
    ['buvid3', fp.buvid3],
    ['buvid4', fp.buvid4],
    ['b_nut', fp.bNut],
    ['b_lsid', fp.bLsid],
    ['_uuid', fp.uuid],
    ['buvid_fp', fp.buvidFp],
    ['bili_ticket', fp.ticket],
    ['bili_ticket_expires', fp.ticketExpires],
    ['browser_resolution', '1920x1080'],
    ['i-wanna-go-back', '-1'],
  ];
  return pairs
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}
