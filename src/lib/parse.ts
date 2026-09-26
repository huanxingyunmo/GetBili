/**
 * 输入解析与格式化工具。
 *
 * 设计取舍：**不做本地 BV ↔ AV 互转**。B 站所有 view 类接口都同时接受
 * bvid / aid 并在响应里同时回传两者，本地转换只会引入一类难以验证的 bug。
 * 这里只负责从用户输入（裸号 / 链接）里抽出可用标识。
 */

/** 清晰度映射（qn -> 中文描述） */
export const QUALITY_MAP: Record<number, string> = {
  127: '8K 超高清',
  126: '杜比视界',
  125: 'HDR 真彩',
  120: '4K 超清',
  116: '1080P60',
  112: '1080P+',
  100: '智能修复',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P',
  6: '240P',
};

export function qualityName(qn: number): string {
  return QUALITY_MAP[qn] ?? `未知清晰度(${qn})`;
}

export interface ParsedVideoId {
  bvid: string | null;
  aid: number | null;
}

/**
 * 从 BV 号 / av 号 / 视频链接中解析视频标识。
 * 支持：`BV17x411w7KC`、`https://www.bilibili.com/video/BV17x411w7KC?p=1`、`av170001`、`170001`
 */
export function parseVideoId(input: string): ParsedVideoId {
  const text = (input ?? '').trim();
  if (!text) return { bvid: null, aid: null };

  // BV 号固定 12 位（BV + 10 位 Base58 字符）；先精确匹配再放宽兜底
  const exactBv = text.match(/BV[0-9A-Za-z]{10}/);
  if (exactBv) return { bvid: exactBv[0], aid: null };
  const looseBv = text.match(/BV[0-9A-Za-z]+/);
  if (looseBv) return { bvid: looseBv[0], aid: null };

  const av = text.match(/av(\d+)/i);
  if (av) return { bvid: null, aid: Number(av[1]) };

  if (/^\d+$/.test(text)) return { bvid: null, aid: Number(text) };

  return { bvid: null, aid: null };
}

/** 解析 UP 主 mid：支持纯数字或 space.bilibili.com/{mid} 链接 */
export function parseMid(input: string): number | null {
  const text = (input ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/space\.bilibili\.com\/(\d+)/);
  if (match) return Number(match[1]);
  const anyDigits = text.match(/\d{2,}/);
  return anyDigits ? Number(anyDigits[0]) : null;
}

/** 解析收藏夹 ID：支持纯数字或含 fid= 参数的链接 */
export function parseFavlistId(input: string): number | null {
  const text = (input ?? '').trim();
  if (!text) return null;
  const byParam = text.match(/[?&]fid=(\d+)/);
  if (byParam) return Number(byParam[1]);
  const byPath = text.match(/favlist\/(\d+)/);
  if (byPath) return Number(byPath[1]);
  if (/^\d+$/.test(text)) return Number(text);
  return null;
}

/** 解析合集 season_id：支持纯数字或含 season_id / sid 的链接 */
export function parseSeasonId(input: string): number | null {
  const text = (input ?? '').trim();
  if (!text) return null;
  const byParam = text.match(/[?&](?:season_id|sid)=(\d+)/);
  if (byParam) return Number(byParam[1]);
  if (/^\d+$/.test(text)) return Number(text);
  return null;
}

/** 中文习惯的数字格式化：1902 -> "1902"，11200 -> "1.1万"，1112000 -> "111.2万" */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 100000000) {
    const value = Math.round((n / 100000000) * 10) / 10;
    return `${Number.isInteger(value) ? value : value.toFixed(1)}亿`;
  }
  if (n >= 10000) {
    const value = Math.round((n / 10000) * 10) / 10;
    return `${Number.isInteger(value) ? value : value.toFixed(1)}万`;
  }
  return String(n);
}

/** 秒 -> "01:23" / "1:02:03" */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v: number) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * 解析上游返回的时长文本为秒数。
 *
 * B 站不同接口对时长的表达方式并不统一：
 *   - search/type 的 `duration` 是 `"12:34"` 字符串
 *   - space/arc/search 的 `length` 也是 `"04:28"` 字符串
 *   - 部分接口直接给数字秒
 * 这里统一处理，无法解析时返回 0。
 */
export function parseDurationText(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value !== 'string') return 0;

  const text = value.trim();
  if (!text) return 0;
  // 纯数字视为秒数
  if (/^\d+$/.test(text)) return Number(text);

  const parts = text.split(':');
  // 只接受每一段都是纯数字的 MM:SS / HH:MM:SS
  if (parts.length < 2 || parts.length > 3) return 0;
  if (parts.some((part) => part === '' || !/^\d+$/.test(part.trim()))) return 0;

  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + Number(part.trim());
  }
  return seconds;
}

/** 把协议相对 URL（//i0.hdslb.com/...）补全为 https，并修正 http 封面链接 */
export function normalizeUrl(url: string | undefined | null): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice(7)}`;
  return trimmed;
}

/** 去掉搜索结果标题里的高亮标签与 HTML 实体 */
export function stripHtml(input: string | undefined | null): string {
  if (!input) return '';
  return input
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 安全取整 */
export function toInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 标准视频页链接 */
export function videoUrl(bvid: string): string {
  return bvid ? `https://www.bilibili.com/video/${bvid}` : '';
}

/** 个人空间链接 */
export function spaceUrl(mid: number): string {
  return mid ? `https://space.bilibili.com/${mid}` : '';
}
