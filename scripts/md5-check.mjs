import { md5Hex } from '../src/lib/md5.ts';

const vectors = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
  [
    '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
    '57edf4a22be3c955ac49da2e2107b67a',
  ],
  ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
];

let pass = 0;
let fail = 0;
for (const [input, expect] of vectors) {
  const got = md5Hex(input);
  const ok = got === expect;
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} md5(${JSON.stringify(input.slice(0, 32))}) => ${got}${ok ? '' : ' expected=' + expect}`);
}

// 跨多个 64 字节块的长输入（校验填充与长度字段）
console.log('len998  =', md5Hex('a'.repeat(998)));
console.log('len1000 =', md5Hex('a'.repeat(1000)));

// WBI 侧会用到的中文/特殊字符
console.log('cjk     =', md5Hex('中文测试 UTF8'));

console.log(`RESULT pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
