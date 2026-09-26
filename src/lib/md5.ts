/**
 * 纯 TypeScript 的 MD5 实现。
 *
 * 为什么不用 node:crypto？—— 那需要开启 nodejs_compat 兼容标志并引入 @types/node；
 * Web Crypto (`crypto.subtle`) 又不支持 MD5。WBI 签名强依赖 MD5，
 * 因此这里自带一份实现，零依赖、与运行时无关。
 *
 * 正确性由 scripts/smoke.mjs 中的 RFC 1321 官方测试向量校验。
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** RFC 1321 的 T 表：K[i] = floor(abs(sin(i + 1)) * 2^32) */
const K = (() => {
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  return table;
})();

/** 对原始字节做 MD5，返回 16 字节摘要 */
export function md5Bytes(input: Uint8Array): Uint8Array {
  const len = input.length; // 字节长度
  const bitLen = len * 8;

  // 填充：0x80 + 若干 0x00，使总长度 ≡ 56 (mod 64)，末尾 8 字节存原始比特长度
  const paddedLen = (((len + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLen);
  buffer.set(input);
  buffer[len] = 0x80;

  const view = new DataView(buffer.buffer, buffer.byteOffset, paddedLen);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      M[i] = view.getUint32(offset + i * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;

      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      f = (f + a + K[i] + M[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + (((f << S[i]) | (f >>> (32 - S[i]))) >>> 0)) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

/** 对字符串（按 UTF-8 编码）做 MD5，返回 32 位小写十六进制 */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const digest = md5Bytes(bytes);
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    hex += digest[i].toString(16).padStart(2, '0');
  }
  return hex;
}
