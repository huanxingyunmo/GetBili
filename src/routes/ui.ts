/**
 * 控制台页面路由 —— 挂载在 /ui
 *
 *   GET /ui    浏览器控制台（HTML）
 *   GET /ui/   同上，尾斜杠路由由 src/index.ts 单独注册（见文件末尾说明）
 *
 * 这个路由只负责「把页面以正确的头和策略吐出去」，页面内容本身在 src/ui/page.ts。
 * 页面与接口同源，因此不存在跨域问题；不要在页面里请求别的域名。
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { UI_HTML } from '../ui/page';

/**
 * 页面响应头。
 *
 * CSP 的放行项都是「页面确实需要」的：
 * - script-src / style-src 需要 'unsafe-inline'，因为整页就是一段内联脚本 + 内联样式；
 * - img-src 要放行 https:，封面与头像来自 B 站图床，且图片都标了 referrerpolicy="no-referrer"；
 * - frame-src 只放行官方播放器，避免页面被用来嵌入任意第三方页面；
 * - connect-src 只放行 'self'，页面只能调本服务接口。
 *
 * 这里刻意不设置 Referrer-Policy：页面上的 <img> 已经逐个标了 no-referrer（B 站图床
 * 会拒绝带外站 Referer 的请求），而 iframe 播放器需要默认的 origin 级 Referer 才能正常取流。
 */
export function uiPage(): Response {
  return new Response(UI_HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "media-src 'self' blob: https:",
        'frame-src https://player.bilibili.com',
        "connect-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join('; '),
    },
  });
}

const ui = new Hono<{ Bindings: Env }>();

ui.get('/', uiPage);

/**
 * 尾斜杠路由由 src/index.ts 直接注册。
 *
 * Hono 的路由默认是 strict 的：`app.route('/ui', sub)` 里的 `sub.get('/')` 只会
 * 注册出 `/ui` 这一条路径，`/ui/` 会落到 notFound。这里不能用 `ui.get('')` 之类的
 * 写法绕过 —— 实测同样注册不出 `/ui/`，必须在最外层显式声明，见 index.ts。
 */
export default ui;
