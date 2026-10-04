/**
 * 上游出口地址管理（叶子模块：只依赖 types 纯类型，无其他 import）。
 *
 * 为什么独立成模块：request.ts 与 fingerprint.ts 都需要做上游 URL 重写，
 * 但 fingerprint 不能 import request（request 依赖 fingerprint 的指纹，会循环依赖），
 * 因此把重写逻辑抽到这里，两边各自 import 本模块。
 *
 * 背景：B 站对数据中心 IP（含 Cloudflare Workers 出口段）做 IP 级风控，
 * 线上直连所有上游接口都会拿到 `-412 request was banned`（本地家宽 IP 一切正常）。
 * 缓解方式：配置 UPSTREAM_PROXY_BASE 指向一台住宅/国内 IP 的反向代理，
 * 所有 B 站上游请求会被重写到该地址，由代理代发；Referer/Origin/Cookie 保持真实值。
 * 代理端只需透传路径与请求头（Host/SNI 指向 api.bilibili.com），不理解任何业务。
 */

import type { Env } from '../types';

export const API_BASE = 'https://api.bilibili.com';

/** 已知 B 站上游域名（以这些 origin 开头的请求会被重写到代理） */
const UPSTREAM_ORIGINS = ['https://api.bilibili.com', 'https://www.bilibili.com'];

/** 上游出口基址：未配置代理时为真实 B 站 API，配置后为代理服务地址（去掉尾部斜杠） */
export function getUpstreamBase(env: Env): string {
  const raw = env.UPSTREAM_PROXY_BASE?.trim();
  if (!raw) return API_BASE;
  return raw.replace(/\/+$/, '');
}

/** 把 B 站上游 URL 重写到出口代理（未配置代理时原样返回） */
export function rewriteUpstreamUrl(env: Env, url: string): string {
  const base = getUpstreamBase(env);
  if (base === API_BASE) return url;
  for (const origin of UPSTREAM_ORIGINS) {
    if (url.startsWith(origin)) return base + url.slice(origin.length);
  }
  return url;
}

/**
 * FAKE_CN_IP 实验（借鉴 NeteaseCloudMusicApiEnhanced/api-enhanced 对网易的手法）：
 * 向上游注入伪造的 X-Real-IP / X-Forwarded-For 中国 IP。
 *
 * - 网易服务端信任这两个头（网关按 CDN 透传头取客户端 IP），伪造中国 IP 可绕地域/风控；
 * - B 站是否同样信任未经证实（其风控大概率以 TCP 对端 IP 为准），故做成实验开关默认关闭；
 * - 中国 IP 生成：从真实中国主干网段中「按段大小加权随机」选段、段内均匀取 IP，
 *   使伪造 IP 落在真实分配范围内；模块级缓存，每运行时实例一个并全程复用
 *   （与 api-enhanced 的 global.cnIp 语义一致——IP 跳变本身就是可疑信号）；
 * - 关键约束：**所有到 B 站的请求必须带上同一个 IP**。若部分请求带真实出口、部分带伪造 IP，
 *   等于自报「机器伪装」，因此 request.ts 与 fingerprint.ts 的所有请求都要过本函数。
 */

/** 中国主干网段（CIDR，三大运营商常见分配；伪装用途选确认属于中国的大段即可） */
const CN_IP_CIDRS: ReadonlyArray<readonly [first: number, base: number, prefix: number]> = [
  [36, 0, 10], // 36.0.0.0/10
  [39, 0, 9], // 39.0.0.0/9（取前半，避开后半海外争议段）
  [58, 14, 15],
  [59, 32, 13],
  [60, 0, 13],
  [61, 128, 10],
  [101, 16, 12],
  [106, 112, 13],
  [110, 80, 13],
  [112, 0, 10],
  [116, 16, 12],
  [118, 112, 13],
  [121, 8, 13],
  [123, 4, 14],
  [125, 64, 13],
  [180, 96, 11],
  [182, 128, 10],
  [183, 192, 10],
  [202, 96, 12],
  [218, 0, 13],
  [220, 160, 11],
  [221, 192, 13],
  [222, 128, 11],
];

interface CnIpSegment {
  first: number;
  base: number;
  /** 次字节内可随机位数（prefix - 8，prefix 限定在 /8~/15） */
  bits: number;
  weight: number;
}

const CN_IP_SEGMENTS: ReadonlyArray<CnIpSegment> = (() => {
  const segs = CN_IP_CIDRS.map(([first, base, prefix]) => {
    const bits = Math.max(0, Math.min(7, prefix - 8));
    return { first, base, bits, weight: 2 ** bits * 65536 };
  });
  const total = segs.reduce((sum, s) => sum + s.weight, 0);
  return segs.map((s) => ({ ...s, weight: s.weight / total }));
})();

function generateRandomChineseIP(): string {
  let r = Math.random();
  let seg = CN_IP_SEGMENTS[CN_IP_SEGMENTS.length - 1];
  for (const s of CN_IP_SEGMENTS) {
    if (r < s.weight) {
      seg = s;
      break;
    }
    r -= s.weight;
  }
  const second = seg.base + Math.floor(Math.random() * 2 ** seg.bits);
  return `${seg.first}.${second}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
}

/** 每运行时实例（isolate/进程）生成一次并全程复用 */
const CACHED_CN_IP = generateRandomChineseIP();

/** FAKE_CN_IP 开启时向 headers 注入伪造中国 IP（未开启则原样返回，绝不发送多余的头） */
export function applyFakeCnIp(env: Env, headers: Record<string, string>): Record<string, string> {
  if ((env.FAKE_CN_IP ?? '').toLowerCase() === 'true') {
    headers['X-Real-IP'] = CACHED_CN_IP;
    headers['X-Forwarded-For'] = CACHED_CN_IP;
  }
  return headers;
}
