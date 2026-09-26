/**
 * WBI 签名实现（对齐 B 站 web 端行为）。
 *
 * 流程：
 *   1. GET /x/web-interface/nav 取 wbi_img.img_url / sub_url
 *   2. 取两个 URL 的文件名主体作为 imgKey / subKey，拼接后按 MIXIN_KEY_ENC_TAB 重排取前 32 位 -> mixinKey
 *   3. 请求参数按 key 排序 → 追加 wts → 过滤空值 → 百分号编码 → md5(query + mixinKey) = w_rid
 *
 * 注意：未登录时 nav 返回 code=-101，但 data.wbi_img 依然存在，
 * 因此这里**不能**用 code==0 判断，否则未登录会拿不到密钥。
 */

import type { Env } from '../types';
import { md5Hex } from './md5';
import { BiliError, biliCodeToStatus, upstreamError } from './errors';
import { invalidateFingerprint } from './fingerprint';
import {
  MAIN_REFERER,
  biliEnvelope,
  buildUrl,
  type FetchOptions,
  type QueryValue,
} from './request';

/** B 站固定重排表 */
export const MIXIN_KEY_ENC_TAB: readonly number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const NAV_PATH = '/x/web-interface/nav';
/** 密钥缓存时长，与参考实现一致（600s） */
const KEY_TTL_MS = 10 * 60 * 1000;

export interface WbiKeys {
  imgKey: string;
  subKey: string;
  mixinKey: string;
  fetchedAt: number;
}

interface NavData {
  wbi_img?: { img_url?: string; sub_url?: string };
}

let cachedKeys: WbiKeys | null = null;
let inflight: Promise<WbiKeys> | null = null;

/** 按重排表从 imgKey + subKey 推导 mixinKey */
export function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  let key = '';
  for (const index of MIXIN_KEY_ENC_TAB) {
    key += raw[index] ?? '';
  }
  return key.slice(0, 32);
}

/** 让下一次取密钥时强制重新拉取（签名校验失败时使用） */
export function invalidateWbiKeys(): void {
  cachedKeys = null;
}

async function fetchWbiKeys(env: Env): Promise<WbiKeys> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const envelope = await biliEnvelope<NavData>(env, buildUrl(NAV_PATH), {
        referer: MAIN_REFERER,
      });
      const wbi = envelope.data?.wbi_img;
      if (wbi?.img_url && wbi?.sub_url) {
        const imgKey = wbi.img_url.split('/').pop()?.split('.')[0] ?? '';
        const subKey = wbi.sub_url.split('/').pop()?.split('.')[0] ?? '';
        if (imgKey && subKey) {
          return {
            imgKey,
            subKey,
            mixinKey: getMixinKey(imgKey, subKey),
            fetchedAt: Date.now(),
          };
        }
      }
      lastError = new Error('nav 响应中缺少 wbi_img');
    } catch (err) {
      lastError = err;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw upstreamError(`获取 WBI 签名密钥失败：${message}`);
}

/** 取 WBI 密钥（带模块级缓存 + 并发去重，避免请求风暴） */
export async function getWbiKeys(env: Env): Promise<WbiKeys> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < KEY_TTL_MS) {
    return cachedKeys;
  }
  if (!inflight) {
    inflight = fetchWbiKeys(env)
      .then((keys) => {
        cachedKeys = keys;
        return keys;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * 与 Python `urllib.parse.quote(s, safe="")` 完全一致的百分号编码。
 * encodeURIComponent 不会编码 ! * ' ( )，而 Python 会，故做一次补编码。
 */
function pyQuote(input: string): string {
  return encodeURIComponent(input).replace(
    /[!*'()]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * 对 URL 追加 wts / w_rid 完成 WBI 签名。
 * 无法获取密钥时直接抛出 BiliError（不静默降级，否则上游只会回一个费解的 -403）。
 */
export async function signWbi(env: Env, rawUrl: string): Promise<string> {
  const keys = await getWbiKeys(env);

  const url = new URL(rawUrl);
  const search = new URLSearchParams(url.search);
  search.set('wts', String(Math.floor(Date.now() / 1000)));

  const entries: Array<[string, string]> = [];
  search.forEach((value, key) => {
    entries.push([key, value]);
  });
  // Python 侧用 sorted(params.keys()) 排序，这里按 key 字典序保持一致
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const query = entries
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${pyQuote(key)}=${pyQuote(value)}`)
    .join('&');

  const wRid = md5Hex(query + keys.mixinKey);
  return `${url.origin}${url.pathname}?${query}&w_rid=${wRid}`;
}

/**
 * 需要 WBI 签名的 GET 请求。
 *
 * 首次失败时会重试一次，并针对不同失败原因做不同处理：
 *   - -401 / -403 / 提示 w_rid     → 强制刷新 WBI 密钥
 *   - -352 / -412（风控 / 被拦截） → 强制刷新设备指纹与票据
 *
 * 实测：`/x/space/wbi/arc/search` 的 -412 是按账号 + 时间窗口波动的风控，
 * 换一套全新的 buvid / bili_ticket 后重试往往就能通过。
 */
export async function wbiGet<T>(
  env: Env,
  path: string,
  params: Record<string, QueryValue> = {},
  opts: FetchOptions = {},
): Promise<T> {
  let lastCode = -1;
  let lastMessage = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    const signed = await signWbi(env, buildUrl(path, params));
    const envelope = await biliEnvelope<T>(env, signed, opts);

    if (envelope.code === 0) {
      return envelope.data;
    }

    lastCode = envelope.code;
    lastMessage = envelope.message ?? '';

    if (attempt > 0) break;

    if (envelope.code === -352 || envelope.code === -412) {
      invalidateFingerprint();
      continue;
    }

    const signatureRelated =
      envelope.code === -401 ||
      envelope.code === -403 ||
      /w_rid|sign/i.test(lastMessage);
    if (signatureRelated) {
      invalidateWbiKeys();
      continue;
    }

    break;
  }

  throw new BiliError(lastMessage || `B 站接口返回 code=${lastCode}`, {
    code: lastCode,
    status: biliCodeToStatus(lastCode),
  });
}
