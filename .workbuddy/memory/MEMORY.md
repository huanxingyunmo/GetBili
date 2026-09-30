# GetBili 项目长期记忆

> 详细的技术细节、接口映射陷阱与风控策略见根目录 `AGENTS.md`（这是本项目的主要记忆载体）。
> 此处只保留跨会话最需要先知道的事实。

## 项目定位

Cloudflare Workers + Hono 4 + TypeScript 的哔哩哔哩信息 API 服务。
参考实现来源：`D:\projects\python\BiLiganbei`（Python/PySide6 下载器，接口逻辑与风控策略参照它）。
只返回结构化元数据与可直连流地址，不代理视频流量。

## 必须记住的约定

- `src/types.ts` 是**共享类型契约**，改动属破坏性变更。
- `src/lib/endpoints.ts` 是接口清单（ENDPOINTS）的唯一权威来源（已从 index.ts 迁出）。
- 所有上游请求必须经 `src/lib/request.ts`（否则丢 Referer/UA 会触发 -412）。
- HTTP 状态码只由 `src/lib/errors.ts` 的 `biliCodeToStatus` 决定，业务层不硬编码
  （访问控制层的 404/401 伪装响应除外，走 `jsonResponse` 直构）。
- 依赖安装用 pnpm 且**必须保持 `nodeLinker: hoisted`**（见 `pnpm-workspace.yaml`）；
  切换链接模式前先手动删 `node_modules`（用 PowerShell，bash `rm -rf` 会被守卫拦）。
- 改 `src/lib/md5.ts` 后必须重跑 `pnpm test`（WBI 签名依赖它）。
- 访问控制三层：auth（HMAC 会话 + Bearer）/ policy（KV fail-closed）/ disguise（CF 404 伪装）。
  伪装页绝不能改成 401/302；policyGuard/uiGate 必须挂 CORS 之后；/adm 不受 policyGuard 管。
  详见 `AGENTS.md`「访问控制与伪装」章节。
- 内联页面三约定（ui/adm/disguise 通用）：单模板字面量、内层 JS 零反斜杠零嵌套模板、
  textContent 禁 innerHTML；`scripts/ui-check.mjs`（28 项）离线把关。

## 验证入口

- `pnpm run check` —— typecheck + MD5 回归（必须 0 错误、8/8 通过）
- `node scripts/ui-check.mjs` —— 内联页面离线检查 28 项（无需起服务）
- `pnpm smoke` —— 全接口冒烟 38 项，需先 `pnpm dev`。真实请求上游，连续跑会触发限流。
  报 SKIP/风控被识别都可能是环境性的，判读方式见 `AGENTS.md` 末尾。
  访问控制断言依赖 `.dev.vars` 里的 `ADMIN_TOKEN`（本地为 dev-admin-token）。
- `node scripts/ui-e2e.mjs` —— CDP 真实浏览器 15 项（需 dev 服务 + 无头 Chrome）
- `pnpm debug:upstream` —— 直接打上游看原始响应，排查字段映射与风控时首选。

## 核心风险（交付时必须如实告知用户）

1. `/api/user/:mid/videos` 与 `/api/search/user` 在游客身份下会被 B 站风控（-412 / v_voucher / 软拦截），
   `BILI_COOKIE` 是唯一可靠缓解手段。已实现完整设备指纹 + `bili_ticket` 链路并自动重试一次。
2. 两类「伪成功」响应（搜索的 `v_voucher`、空间投稿的空 `vlist`）已显式处理，
   不要为了让测试变绿而把这两处告警去掉 —— 那会退化成静默的错误答案。
