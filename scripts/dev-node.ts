/**
 * 本地开发服务器（Node 直跑 Hono，替代 wrangler dev）。
 *
 * 用法：pnpm dev（等价 tsx scripts/dev-node.ts），监听 127.0.0.1:8787，
 * 与 smoke.mjs 的默认 SMOKE_BASE 一致。
 *
 * 与 wrangler dev 的差异：
 * - 环境变量来自本机 process.env + 项目根 .dev.vars（KEY=VALUE 行，等价于
 *   wrangler 的本地 vars 文件，BILI_COOKIE / ADMIN_TOKEN 都在这里）；
 * - c.env = process.env（含 .dev.vars 注入项），与 Vercel 入口的行为一致；
 * - 无 Cloudflare KV 绑定（POLICY_KV 为 undefined），策略走内存兜底 ——
 *   对本地开发无影响（策略默认全公开，保存进内存即刻生效）。
 */

import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import app from '../src/index';
import type { Env } from '../src/types';

// 加载 .dev.vars（KEY=VALUE 行，剥引号；与 wrangler dev 的本地变量文件同格式）
try {
  const raw = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] ??= value;
  }
} catch {
  // 无 .dev.vars 时跳过（游客态 + 后台未启用）
}

const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8787;

serve(
  {
    fetch: (req) => app.fetch(req, process.env as unknown as Env),
    port,
    hostname: '127.0.0.1',
  },
  (info) => {
    console.log(`GetBili 本地服务: http://127.0.0.1:${info.port}`);
  },
);
