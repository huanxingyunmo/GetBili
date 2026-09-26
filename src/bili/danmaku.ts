/**
 * 弹幕模块：拉取 DmSegMobileReply（protobuf 二进制）并转换为标准 XML。
 *
 * 说明：
 *   1. 弹幕接口 /x/v2/dm/web/seg.so 返回的是 **protobuf 二进制**，不是 JSON，
 *      因此走 biliRaw 拿 Response 后直接 arrayBuffer()，绝不能走 biliEnvelope。
 *   2. 解析器手写 varint，不引入 protobuf 运行时依赖（保持 Worker 体积为 0 依赖）。
 *      只解析本项目需要的字段，其余字段按其 wire type 跳过。
 *   3. B 站按「6 分钟一段」切分弹幕，段号从 1 开始递增；某段为空即表示已到末尾。
 */

import type { DanmakuItem, Env } from '../types';
import { biliRaw, buildUrl } from '../lib/request';
import { toInt, videoUrl } from '../lib/parse';

/** 弹幕分段接口（返回 protobuf） */
const SEGMENT_URL = 'https://api.bilibili.com/x/v2/dm/web/seg.so';

/** 默认最大段数：100 段 ≈ 10 小时视频（上游每段固定 6 分钟） */
const DEFAULT_MAX_SEGMENTS = 100;

/* ------------------------------------------------------------------ *
 * protobuf 手写解析
 * ------------------------------------------------------------------ */

/** 可变的读取游标，避免每次返回 [值, 新位置] 元组 */
interface Cursor {
  pos: number;
}

/**
 * 读取一个 varint，游标原地推进。
 * 用 `乘 2^shift` 累加而不是 `<<`，避免 JS 32 位移位溢出（id / progress 可能超过 2^31）。
 * 越界或长度非法时返回 null，调用方据此终止解析。
 */
function readVarint(bytes: Uint8Array, cursor: Cursor): number | null {
  let value = 0;
  let shift = 0;
  while (cursor.pos < bytes.length) {
    const byte = bytes[cursor.pos++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
    // protobuf 单个 varint 最多 10 字节（64 位），超出说明数据已损坏
    if (shift > 63) return null;
  }
  return null;
}

/** 读取一个 length-delimited 字段（返回视图，不拷贝），越界返回 null */
function readBytes(bytes: Uint8Array, cursor: Cursor): Uint8Array | null {
  const length = readVarint(bytes, cursor);
  if (length === null || length < 0 || cursor.pos + length > bytes.length) return null;
  const slice = bytes.subarray(cursor.pos, cursor.pos + length);
  cursor.pos += length;
  return slice;
}

/** 跳过非 0 / 2 的 wire type（1 -> 8 字节，5 -> 4 字节）；越界返回 false */
function skip(bytes: Uint8Array, cursor: Cursor, size: number): boolean {
  cursor.pos += size;
  return cursor.pos <= bytes.length;
}

/**
 * 解析单条 DanmakuElem。
 * 字段表：
 *   1 id / 2 progress(ms) / 3 mode / 4 fontsize / 5 color / 6 midHash(bytes)
 *   7 content(bytes) / 8 ctime / 9 weight / 11 pool
 * content 为空的条目直接丢弃（返回 null）。
 */
function parseElem(chunk: Uint8Array, decoder: TextDecoder): DanmakuItem | null {
  let id = 0;
  let progress = 0;
  let mode = 1;
  let fontsize = 25;
  let color = 0xffffff;
  let midHash = '';
  let content = '';
  let ctime = 0;
  let weight = 0;
  let pool = 0;

  const cursor: Cursor = { pos: 0 };

  while (cursor.pos < chunk.length) {
    const tag = readVarint(chunk, cursor);
    if (tag === null) break;
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;

    if (wireType === 0) {
      const value = readVarint(chunk, cursor);
      if (value === null) break;
      switch (field) {
        case 1:
          id = value;
          break;
        case 2:
          progress = value;
          break;
        case 3:
          mode = value;
          break;
        case 4:
          fontsize = value;
          break;
        case 5:
          color = value;
          break;
        case 8:
          ctime = value;
          break;
        case 9:
          weight = value;
          break;
        case 11:
          pool = value;
          break;
        default:
          break;
      }
      continue;
    }

    if (wireType === 2) {
      const data = readBytes(chunk, cursor);
      if (data === null) break;
      if (field === 6) {
        midHash = decoder.decode(data);
      } else if (field === 7) {
        content = decoder.decode(data);
      }
      continue;
    }

    if (wireType === 1) {
      if (!skip(chunk, cursor, 8)) break;
      continue;
    }

    if (wireType === 5) {
      if (!skip(chunk, cursor, 4)) break;
      continue;
    }

    // 未知 wire type（3/4 已废弃的 group）：数据不可信，终止解析
    break;
  }

  if (content === '') return null;
  return { id, progress, mode, fontsize, color, midHash, content, ctime, pool, weight };
}

/**
 * 解析 DmSegMobileReply（protobuf）二进制为弹幕数组 —— 纯函数，便于单测。
 *
 * 结构：field 1（wire type 2, repeated）= DanmakuElem。
 * 解析器对截断 / 损坏数据一律「优雅截断」：已解析出的条目照常返回，不抛异常。
 */
export function parseDanmakuSegment(buffer: ArrayBuffer): DanmakuItem[] {
  const bytes = new Uint8Array(buffer);
  // ignoreBOM 为 workers-types 的必填项，false 与 Web 标准默认行为一致
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
  const items: DanmakuItem[] = [];
  const cursor: Cursor = { pos: 0 };

  while (cursor.pos < bytes.length) {
    const tag = readVarint(bytes, cursor);
    if (tag === null) break;
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;

    if (wireType === 0) {
      if (readVarint(bytes, cursor) === null) break;
      continue;
    }

    if (wireType === 2) {
      const chunk = readBytes(bytes, cursor);
      if (chunk === null) break;
      // 顶层重复字段只有 field 1 是弹幕条目，其余 length-delimited 字段直接跳过
      if (field === 1) {
        const item = parseElem(chunk, decoder);
        if (item) items.push(item);
      }
      continue;
    }

    if (wireType === 1) {
      if (!skip(bytes, cursor, 8)) break;
      continue;
    }

    if (wireType === 5) {
      if (!skip(bytes, cursor, 4)) break;
      continue;
    }

    break;
  }

  return items;
}

/* ------------------------------------------------------------------ *
 * XML 序列化
 * ------------------------------------------------------------------ */

/** XML 文本转义（必须先转义 & ，否则会二次转义） */
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 转成 B 站标准 XML 弹幕格式：
 *   <d p="时间秒(3位小数),mode,fontsize,color,ctime,pool,midHash,id">内容</d>
 * 空列表返回空字符串。
 */
export function danmakuToXml(list: DanmakuItem[], cid?: number): string {
  if (!list || list.length === 0) return '';
  // cid 保留在签名中（B 站 XML 的 chatid 位），当前输出模板不含 chatid，故不参与拼接
  void cid;

  const lines = list.map((item) => {
    const seconds = (item.progress / 1000).toFixed(3);
    const p = `${seconds},${item.mode},${item.fontsize},${item.color},${item.ctime},${item.pool},${item.midHash},${item.id}`;
    return `    <d p="${p}">${escapeXml(item.content)}</d>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n<i>\n${lines.join('\n')}\n</i>\n`;
}

/* ------------------------------------------------------------------ *
 * 拉取
 * ------------------------------------------------------------------ */

export interface GetDanmakuOptions {
  /** 关联 bvid，仅用于拼 Referer，可不传 */
  bvid?: string | null;
  /** 只取某一段（1 开始），传了就只请求这一段 */
  segment?: number;
  /** 最多拉取多少段，默认 100（每段 6 分钟） */
  maxSegments?: number;
}

/**
 * 拉取弹幕（按 segment_index 递增，直到某段返回空）。
 *
 * 终止条件（任一命中即停止，已拿到的数据照常返回）：
 *   - HTTP 状态非 200
 *   - 响应体长度为 0
 *   - 该段解析出 0 条弹幕
 *   - 该段请求抛错
 */
export async function getDanmaku(
  env: Env,
  cid: number,
  opts: GetDanmakuOptions = {},
): Promise<DanmakuItem[]> {
  const oid = toInt(cid);
  if (oid <= 0) return [];

  const referer = opts.bvid ? videoUrl(opts.bvid) : undefined;
  const single =
    typeof opts.segment === 'number' && opts.segment > 0 ? opts.segment : null;
  const maxSegments = single !== null ? 1 : Math.max(1, toInt(opts.maxSegments, DEFAULT_MAX_SEGMENTS));

  const items: DanmakuItem[] = [];

  for (let index = 0; index < maxSegments; index++) {
    const segmentIndex = single ?? index + 1;

    let buffer: ArrayBuffer | null = null;
    try {
      const res = await biliRaw(
        env,
        buildUrl(SEGMENT_URL, { type: 1, oid, segment_index: segmentIndex }),
        { referer },
      );
      if (res.status !== 200) break;
      buffer = await res.arrayBuffer();
    } catch {
      // 单段请求失败：不再继续，但保留此前已拿到的弹幕
      break;
    }

    if (!buffer || buffer.byteLength === 0) break;

    const parsed = parseDanmakuSegment(buffer);
    if (parsed.length === 0) break;

    items.push(...parsed);
  }

  return items;
}
