/**
 * 生产服务器入口（Docker / 通用自托管）。
 *
 * 与 scripts/dev-node.ts 的差异：
 * - 默认监听 0.0.0.0（容器内必须绑全网卡才能被端口映射访问），可用 HOST 覆盖；
 * - .dev.vars 仅作兼容加载（文件不存在则静默跳过）——容器场景环境变量由
 *   docker run --env / compose environment|env_file 注入；
 * - 打包方式：esbuild bundle 成自包含单文件（hono 与 @hono/node-server 全部内联），
 *   运行镜像不需要 node_modules —— 见 Dockerfile 两阶段构建。
 *
 * env 注入语义与 api/index.ts（Vercel）一致：app.fetch(req, process.env)，
 * Hono 的 c.env 即第二参数，三平台行为对齐。
 */

import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import app from '../src/index';
import type { Env } from '../src/types';

// 与 dev-node.ts 相同的 .dev.vars 加载（KEY=VALUE 行，剥引号，不覆盖已有 env）；
// 容器内无此文件时静默跳过。运行目录变化时按打包产物相对位置解析。
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
  // 无 .dev.vars：环境变量完全来自运行环境
}

const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8787;
const hostname = process.env.HOST?.trim() || '0.0.0.0';

serve(
  {
    fetch: (req) => app.fetch(req, process.env as unknown as Env),
    port,
    hostname,
  },
  () => {
    const shown = hostname === '0.0.0.0' ? '127.0.0.1' : hostname;
    console.log(`GetBili 服务已启动: http://${shown}:${port}（监听 ${hostname}）`);
  },
);
