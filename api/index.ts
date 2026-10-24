/**
 * Vercel Functions 入口（Node.js 运行时，非 Edge）。
 *
 * 为什么不用 Edge Runtime：Edge 函数跑在全球 100+ PoP 上、按请求就近执行，
 * 执行位置无法指定（`vercel.json` 的 regions 对 Edge 无效），出口 IP 也就不可控。
 * 本项目要对抗的是 B 站对「出口 IP 信誉」的风控，出口必须稳定落在某个非美区机房，
 * 所以改用 Node.js 运行时 —— 只有它的 `regions` 配置真正生效（Hobby 仅支持单区域）。
 * 区域钉在 hkg1（香港，见根目录 vercel.json），离 B 站源站最近且不是 iad1 美东段。
 *
 * 请求以 Web 标准 Request 进来、返回 Response（fetch Web Standard 导出），
 * 与 src/ 里全部 Web API 代码零改动兼容：Hono 的 app.fetch 直接可用。
 *
 * 所有请求经 vercel.json 的 rewrites 汇入本函数，req.url 保持浏览器原始路径，
 * 由 Hono 统一路由（/、/ui、/adm、/api/*）。
 *
 * 环境变量（ADMIN_TOKEN / BILI_COOKIE / KV_REST_API_URL ...）由 Vercel 注入
 * process.env，这里显式作为 env 传给 app.fetch —— 与 Cloudflare Workers 的
 * c.env 行为对齐（Hono 的 c.env 即 app.fetch 的第二参数）。
 */

import app from '../src/index';
import type { Env } from '../src/types';

// Node 运行时会注入真实的 process.env。项目类型环境是 lib DOM（无 Node 全局声明），
// 这里做局部声明以保持 tsconfig types 不引入 @types/node。
declare const process: { env: Record<string, string | undefined> };

export default {
  fetch(req: Request): Response | Promise<Response> {
    return app.fetch(req, process.env as unknown as Env);
  },
};
