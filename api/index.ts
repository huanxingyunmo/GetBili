/**
 * Vercel Edge Functions 入口。
 *
 * 所有请求经 vercel.json 的 rewrites 汇入本函数，req.url 保持浏览器原始路径，
 * 由 Hono 统一路由（/、/ui、/adm、/api/*）。
 *
 * 环境变量（ADMIN_TOKEN / BILI_COOKIE / KV_REST_API_URL ...）由 Vercel 注入
 * process.env，这里显式作为 env 传给 app.fetch —— 与 Cloudflare Workers 的
 * c.env 行为对齐（Hono 的 c.env 即 app.fetch 的第二参数）。
 *
 * 选 Edge Runtime 的原因：本项目全部使用 Web 标准 API（crypto.subtle、
 * AbortSignal.timeout、fetch、URL），当初就是按 Workers 语义写的，
 * Edge Runtime 零改动兼容；esbuild 打包支持无扩展名相对导入，源码不动。
 */

import app from '../src/index';
import type { Env } from '../src/types';

// Vercel Edge Runtime 注入的 process.env。项目类型环境是 @cloudflare/workers-types
// （无 Node 的 process 全局声明），这里做局部声明以保持 tsconfig types 不引入 @types/node
declare const process: { env: Record<string, string | undefined> };

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  return app.fetch(req, process.env as unknown as Env);
}
