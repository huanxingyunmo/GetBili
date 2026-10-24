/**
 * Vercel Functions 入口（Node.js 运行时，非 Edge）。
 *
 * 为什么保留这层显式入口，而不是让 Vercel 的 Hono 零配置预设直接吃 src/index.ts：
 * 实测（2026-10-24）预设生成的函数**不认 `vercel.json` 的 regions** —— 同一份配置下
 * 预设那条路跑在 hnd1（东京），而 `api/index.ts` + rewrites 这条路构建产物里明写
 * `regions: ["hkg1"]`、请求 id 也是 `hkg1::`。B 站对出口 IP 极敏感（数据中心段常直接
 * `-412 request was banned`），能不能钉在香港是功能性问题，不能交给平台的默认行为。
 *
 * 另注：Vercel 是**逐文件转译** `.ts` → `.js`、不改写 import 说明符，所以项目内所有相对
 * import 都带 `.js` 后缀（`from '../src/index.js'`）—— 这是能在 /var/task 上跑起来的前提。
 *
 * 所有请求经 vercel.json 的 rewrites 汇入本函数，req.url 保持浏览器原始路径，
 * 由 Hono 统一路由（/、/ui、/adm、/api/*）。
 *
 * 环境变量（ADMIN_TOKEN / BILI_COOKIE / KV_REST_API_URL ...）由 Vercel 注入
 * process.env，这里显式作为 env 传给 app.fetch —— 与 Cloudflare Workers 的
 * c.env 行为对齐（Hono 的 c.env 即 app.fetch 的第二参数）。
 */

import app from '../src/index.js';
import type { Env } from '../src/types.js';

// Node 运行时会注入真实的 process.env。项目类型环境是 lib DOM（无 Node 全局声明），
// 这里做局部声明以保持 tsconfig types 不引入 @types/node。
declare const process: { env: Record<string, string | undefined> };

export default {
  fetch(req: Request): Response | Promise<Response> {
    return app.fetch(req, process.env as unknown as Env);
  },
};