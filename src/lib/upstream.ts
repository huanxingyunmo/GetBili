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
