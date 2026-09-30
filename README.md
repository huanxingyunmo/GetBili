# GetBili — 哔哩哔哩信息 API 服务

基于 **Cloudflare Workers + Hono 4 + TypeScript** 的哔哩哔哩（Bilibili）信息聚合接口服务。通过统一的 HTTP 接口获取视频详情、DASH 播放直链、分 P、弹幕、UP 主信息、投稿列表、搜索、合集与收藏夹，全部接口返回统一 JSON 信封。

> 本项目只做「信息读取 + 地址解析」，不代理、不转发、不缓存任何音视频与图片资源。播放地址直接返回 B 站 CDN 直链，由调用方自行访问。

---

## 功能特性

- **视频详情**：标题、UP 主、统计（播放/点赞/投币/收藏/转发）、封面、时长、分区、互动视频标记、所属合集
- **播放地址**：DASH 音视频分流直链（含备用地址、编码、带宽、分辨率），并服务端挑好 `best.video` / `best.audio`
- **清晰度探测**：返回可用清晰度列表，并如实标注每个清晰度在**当前身份**下是否真的能拿到流
- **分 P 列表**：多 P 视频的分 P 标题、时长、cid
- **弹幕**：解析 B 站 protobuf 分段弹幕，输出 JSON 或标准 XML，零 protobuf 依赖（手写 varint）
- **UP 主**：资料信息（粉丝/关注/投稿/获赞/等级）+ 投稿列表（分页、关键词、排序）
- **搜索**：视频搜索与 UP 主搜索，自动识别风控应答并明确报错，不返回伪成功空列表
- **合集 / 收藏夹**：视频所属合集全部分集；收藏夹分页内容
- **WBI 签名**：完整实现 B 站 web 端签名链路（密钥缓存 + 签名失效自动刷新）
- **设备指纹**：SPI 取 buvid3/buvid4 + HMAC-SHA256 申请 `bili_ticket` + web 端指纹 Cookie 集合
- **输入兼容**：BV 号 / av 号 / 完整视频链接 / URL 编码链接，UP 主 mid / 空间链接，收藏夹 ID / 带 `fid=` 的链接
- **CORS**：自实现中间件，保证**连错误响应**也带 CORS 头；支持 `*` 或逗号分隔白名单
- **访问控制与伪装**：未登录时首页与控制台伪装成 Cloudflare 404 错误页隐藏服务存在；`/adm` 管理后台（令牌登录）可在线切换每个接口的「公开 / 需令牌」策略（KV 持久化）

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 运行时 | Cloudflare Workers |
| Web 框架 | Hono 4 |
| 语言 | TypeScript（strict，`tsc --noEmit` 校验） |
| 构建 / 本地 / 部署 | Wrangler 4 |
| 包管理 | pnpm |
| 加密 | WebCrypto（HMAC-SHA256）+ 自实现纯 TS MD5（WBI 签名） |
| 弹幕解析 | 手写 protobuf varint 解析（零运行时依赖） |

运行时依赖仅 `hono` 一个。

---

## 目录结构

```text
GetBili/
├── src/
│   ├── index.ts              # Worker 入口：CORS、访问控制挂载、伪装门槛、路由挂载、服务自描述
│   ├── types.ts              # 全局类型契约（Env 与所有接口返回结构）
│   ├── bili/                 # 业务模块（直接对接 B 站上游并做字段映射）
│   │   ├── video.ts          # 视频详情 / 分P / 播放地址 / 可用清晰度
│   │   ├── user.ts           # UP 主信息（多源兜底）/ 投稿列表
│   │   ├── search.ts         # 视频搜索 / UP 主搜索
│   │   ├── collection.ts     # 合集（ugc_season）/ 收藏夹
│   │   └── danmaku.ts        # 弹幕 protobuf 解析 + XML 序列化
│   ├── lib/                  # 基础设施
│   │   ├── request.ts        # 请求头 / Cookie / 超时 / 重试 / JSON 解析
│   │   ├── wbi.ts            # WBI 签名（密钥缓存 + 失效刷新）
│   │   ├── fingerprint.ts    # 设备指纹（buvid3/buvid4/b_lsid/_uuid/buvid_fp）+ bili_ticket
│   │   ├── parse.ts          # 输入解析（BV/av/URL、mid、收藏夹 ID）与格式化
│   │   ├── md5.ts            # 纯 TypeScript MD5
│   │   ├── http.ts           # 统一响应信封 / 查询参数读取 / CORS
│   │   ├── errors.ts         # 错误类型与 B 站错误码 -> HTTP 状态码映射
│   │   ├── auth.ts           # 管理后台认证（ADMIN_TOKEN 校验 + HMAC 会话 Cookie + Bearer）
│   │   ├── policy.ts         # 接口公开策略（KV 存储 + 路径模板匹配 + 拦截中间件）
│   │   └── endpoints.ts      # 接口契约清单（ENDPOINTS，策略键与自描述共用）
│   ├── routes/               # Hono 路由装配
│   │   ├── video.ts
│   │   ├── user.ts
│   │   ├── search.ts
│   │   ├── favlist.ts
│   │   ├── ui.ts             # /ui 控制台页面路由
│   │   └── adm.ts            # /adm 管理后台路由（登录 / 会话 / 策略读写）
│   ├── ui/page.ts            # /ui 浏览器控制台（单文件内联 HTML）
│   ├── adm/page.ts           # /adm 管理页（登录 + 策略开关，单文件内联 HTML）
│   └── disguise/page.ts      # Cloudflare 404 伪装页（未登录时隐藏服务存在）
├── scripts/
│   ├── smoke.mjs             # 全接口冒烟测试（含访问控制与伪装断言，真实打到本地服务 + B 站上游）
│   ├── md5-check.mjs         # MD5 回归测试（RFC 1321 官方向量）
│   ├── ui-check.mjs          # 内联页面离线检查（模板字面量/转义/语法/id 完整性）
│   ├── ui-e2e.mjs            # CDP 真实浏览器端到端测试（需先起 pnpm dev + 无头 Chrome）
│   └── debug-upstream.ts     # 直接请求上游并打印原始响应，用于排查字段映射
├── docs/
│   ├── API.md                # 完整接口文档
│   └── console-*.png         # 控制台页面截图
├── wrangler.toml             # Workers 配置与非敏感环境变量（含 POLICY_KV 绑定）
├── tsconfig.json
└── package.json
```

---

## 快速开始

### 环境要求

- Node.js >= 18
- pnpm

### 安装与本地预览

```bash
pnpm install
pnpm dev            # 本地预览，默认 http://127.0.0.1:8787
```

启动后访问 `http://127.0.0.1:8787/` —— 未登录时**伪装成 Cloudflare 404 错误页**（这是预期行为，用于隐藏服务存在）。用 `ADMIN_TOKEN` 登录 `/adm` 后，`/`、`/api`、`/ui` 才会正常展示。

### 部署到 Cloudflare

```bash
# 首次部署前先登录（会打开浏览器完成授权）
pnpm exec wrangler login

# 创建接口策略存储的 KV namespace，并把返回的 id 回填到 wrangler.toml 的 POLICY_KV
pnpm exec wrangler kv namespace create POLICY_KV

# 部署
pnpm deploy

# 配置管理后台令牌（未配置则 /adm 显示「后台未启用」）
pnpm exec wrangler secret put ADMIN_TOKEN
```

### 配置登录态（可选，但强烈建议）

未配置 Cookie 时服务以**游客身份**请求，只能拿到低清晰度流，且搜索 / 空间类接口容易被风控拦截。

本地开发：新建 `.dev.vars` 文件（已在 `.gitignore` 中，不会被提交）：

```ini
BILI_COOKIE="SESSDATA=xxx; bili_jct=xxx"
```

线上部署：用 secret 写入，不要写进 `wrangler.toml`：

```bash
pnpm exec wrangler secret put BILI_COOKIE
```

> 建议 `BILI_COOKIE` 里只放登录态字段（`SESSDATA`、`bili_jct` 等）。若 Cookie 中已包含 `buvid3`，服务会直接沿用该 Cookie 而不再追加设备指纹与 `bili_ticket`；不含 `buvid3` 时服务会自动补全（详见 `src/lib/request.ts` 的 `resolveCookie`）。

### 环境变量

`wrangler.toml` 的 `[vars]` 与 secrets：

| 变量名 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `CORS_ORIGIN` | 普通变量 | `"*"` | 允许的跨域来源，支持逗号分隔白名单 |
| `REQUEST_TIMEOUT_MS` | 普通变量 | `"15000"` | 上游请求超时（毫秒） |
| `TRY_LOOK` | 普通变量 | `"true"` | 未登录时附加 `try_look=1` 以预览更高清晰度 |
| `ADMIN_TOKEN` | **secret** | 无 | `/adm` 管理后台令牌；配置后启用登录、`/ui` 与首页门槛、接口策略管理。**不要写进 `wrangler.toml`** |
| `BILI_COOKIE` | **secret** | 无 | 登录态 Cookie，**不要写进 `wrangler.toml`** |
| `BILI_UA` | secret / 变量 | 内置 Chrome UA | 自定义 User-Agent |

KV 绑定：`POLICY_KV`（接口公开策略存储，本地 dev 由 wrangler 自动模拟，无需真实 id；线上部署前需 `wrangler kv namespace create POLICY_KV` 并回填 id 到 `wrangler.toml`）。

---

## 访问控制与管理后台

### 行为矩阵

| 请求 | 未登录（无会话/Bearer） | 已登录 |
| --- | --- | --- |
| `GET /` | **Cloudflare 404 伪装页**（HTTP 404） | 服务自描述 JSON |
| `GET /api` | 同上伪装 | 服务自描述 JSON |
| `GET /ui`、`GET /ui/` | 同上伪装 | 浏览器控制台页面 |
| `GET /adm` | 管理页（未登录态：令牌输入框） | 管理页（策略开关） |
| 业务接口（`/api/video/*` 等） | 按策略表：默认**公开**；设为「需令牌」后返回与 notFound 相同的 JSON 404 | 会话 Cookie 或 Bearer 均可通过 |
| 未知路径 | Accept 含 `text/html` → CF 404 伪装；API 请求 → JSON 404 | 同左 |

> 伪装页视觉来自 [cloudflare-error-page](https://github.com/nickvdyck/cloudflare-error-page) 风格模板：三栏状态图、Ray ID + IP footer，整页零外链、图标全部内联 data URI。

### 登录方式

- **页面**：访问 `/adm`，输入令牌登录（签发 HttpOnly 会话 Cookie，有效期 24h）
- **脚本/程序化**：请求头带 `Authorization: Bearer <ADMIN_TOKEN>`，无需先登录

### 接口公开策略

`/adm` 页面登录后可逐个切换 12 个接口的「公开 / 需令牌」状态，保存后写入 KV（键 `api_policy`），实时生效：

- 策略键是**接口模板**（如 `/api/video/:id`），同模板的全部实例路径一起生效
- 策略为「需令牌」的接口未登录访问返回**与路由不存在完全一致的 JSON 404**（`code: -404`），不暴露「接口存在但需要权限」的信息
- KV 读取失败时按「需令牌」处理（fail-closed，安全优先）；KV 未绑定时全部公开
- `/api/health` 也纳入策略表但默认公开；`/adm` 本身永远可访问（否则会把自己锁死）

### 本地开发配置

`.dev.vars` 追加一行（该文件已 gitignore）：

```ini
ADMIN_TOKEN=dev-admin-token
```

---

## 接口速览

统一响应信封：成功 `{ "code": 0, "message": "ok", "data": ... }`，失败 `{ "code": <非0>, "message": "...", "data": null }`。

| 方法 | 路径 | 说明 | 主要查询参数 |
| --- | --- | --- | --- |
| GET | `/` | 服务自描述 + 接口清单（含登录态信息），**需登录**（未登录伪装 404） | — |
| GET | `/api` | 服务自描述 + 接口清单，**需登录**（未登录伪装 404） | — |
| GET | `/api/health` | 健康检查 | — |
| GET | `/ui` | 浏览器控制台页面，**需登录** | — |
| GET | `/adm` | 管理后台（令牌登录 + 接口策略开关） | — |
| GET | `/api/video/:id` | 视频详情 | `qualities=1`、`pages=0` |
| GET | `/api/video` | 视频详情（查询串入参） | `url` / `bvid` / `aid` |
| GET | `/api/video/:id/pages` | 分 P 列表 | — |
| GET | `/api/video/:id/playurl` | 播放地址（DASH / durl） | `qn`（默认 80）、`cid` |
| GET | `/api/video/:id/qualities` | 可用清晰度列表 | `cid` |
| GET | `/api/video/:id/danmaku` | 弹幕（JSON / XML） | `format`、`segment`、`maxSegments` |
| GET | `/api/video/:id/collection` | 所属合集 | — |
| GET | `/api/user/:mid` | UP 主信息 | — |
| GET | `/api/user/:mid/videos` | UP 主投稿列表 | `page`、`pageSize`、`keyword`、`order` |
| GET | `/api/search/video` | 视频搜索 | `keyword`（必填）、`page`、`pageSize`、`order` |
| GET | `/api/search/user` | UP 主搜索 | `keyword`（必填）、`page`、`pageSize` |
| GET | `/api/favlist/:mediaId` | 收藏夹内容 | `page`、`pageSize` |

`:id` 支持 BV 号、av 号、纯数字 aid，或 URL 编码后的完整视频链接。每个接口的完整参数表、curl 示例与真实返回结构见 [`docs/API.md`](docs/API.md)。

### 错误码约定

| code | HTTP | 含义 |
| --- | --- | --- |
| `0` | 200 | 成功 |
| `-400` | 400 | 参数错误（缺失 / 无法解析输入） |
| `-404` | 404 | 资源不存在（视频、UP 主、合集、收藏夹，或路由不存在） |
| `-412` | 429 | 风控拦截（含搜索接口识别到的风控应答），`message` 会提示配置 `BILI_COOKIE` |
| `-502` | 502 | 上游异常 / 网络失败 / 上游返回非 JSON |
| `-500` | 500 | 服务内部错误 |
| `-509` / `-799` | 429 | 上游限流 / 请求被限制 |

路由不存在时返回 HTTP 404，body 为 `{ "code": -404, "message": "接口不存在：GET /xxx", "data": null, "hint": "GET / 可查看全部可用接口" }`。浏览器请求（`Accept` 含 `text/html`）则得到 Cloudflare 404 伪装页——与真实 Cloudflare 行为一致，仅对 HTML 请求渲染错误页。

**关于 `-412`**：所有风控拦截统一返回 **HTTP 429 + `code=-412`**，便于调用方用单一 `code` 判定并按「稍后重试」处理。搜索接口识别到 `v_voucher` 风控应答时抛出的也是同一个码（见 `src/bili/search.ts`，状态码取自 `src/lib/errors.ts` 的 `biliCodeToStatus`）。`message` 中会明确提示配置 `BILI_COOKIE`。

### 播放地址返回结构要点

- `data.format` 只会是 `"dash"` 或 `"durl"`。**不要照抄上游的 `format` 字段**——上游在 DASH 模式下也会返回 `flv720` 这类遗留值，本项目已按实际流结构（是否存在 `dash.video`/`dash.audio`）判定。
- `data.best` 是服务端挑好的最佳音视频流：
  - `best.video`：先取 `id === qn`；否则取 `id <= qn` 中最大者；再否则取全列表最大者。同清晰度多编码时按 `7(avc) > 12(hevc) > 13(av1)` 优先。
  - `best.audio`：取 `bandwidth` 最大者。
- `data.acceptQuality[].available` 表示**当前身份（游客 / 登录）实际能拿到该清晰度的流**。游客通常只有 480P/360P 可用，这是 B 站按身份下发的真实结果，不是 bug。
- `durl` 仅在部分老视频 / 番剧下出现；`durl` 为 `null` 时以 `dash` 为准。

---

## 已知限制

以下限制均为实测确认，在使用前请知悉。

1. **UP 主投稿接口（`/api/user/:mid/videos`）有较严的账号级风控，且存在「软拦截」**
   该接口（上游 `/x/space/wbi/arc/search`）需要 `bili_ticket`。本项目已实现完整链路（`src/lib/fingerprint.ts`：SPI 取 `buvid3`/`buvid4` + HMAC-SHA256 申请 `bili_ticket` + `b_lsid`/`_uuid`/`buvid_fp` 等 web 端指纹 Cookie），实测可成功返回数据（例如 `mid=486906719` 返回 `total=258919`）。但 B 站会按账号与时间窗口返回 `-412 request was banned`，此时服务会自动换一套全新指纹重试一次；仍失败则返回 429。

   更需要注意的是**软拦截**：风控时上游会返回 `code=0` 但列表为空、`total=0`，与「该 UP 主确实没有投稿」在响应结构上完全一致（实测 `mid=486906719` 有 258919 个投稿，被软拦截时同样返回 `total=0`）。服务不会把它硬判成错误（避免对真的没有投稿的 UP 主误报），而是在响应里附带 `meta.warning`——**调用方必须检查该字段，不要把空的 `items` 直接当成「没有投稿」**。

2. **UP 主搜索（`/api/search/user`）在未登录状态下高概率被要求风控验证**
   上游返回 `code=0` 但 `data` 里只有一个 `v_voucher` 字段、没有任何结果。本项目**显式识别这种应答并抛出 HTTP 429 + `code=-412`**，而不是返回一个看起来成功的空列表。配置 `BILI_COOKIE` 后可大幅改善。

3. **搜索接口存在 IP 级限流**
   短时间内连续请求会触发同样的 `v_voucher` 风控应答。建议降低请求频率。

4. **通用缓解手段：配置 `BILI_COOKIE`**
   上述问题的通用缓解方式都是配置登录态 Cookie。可从浏览器开发者工具复制 `SESSDATA`、`bili_jct` 等字段；本地写入 `.dev.vars`，线上用 `pnpm exec wrangler secret put BILI_COOKIE`。

> 补充：`/api/video/:id/qualities` 与详情接口的 `qualities=1` 内部会发起一次播放地址请求（按 4K 请求以获取完整 `accept_quality`），失败时返回空列表而不报错。

---

## 安全提示

- **`BILI_COOKIE` 是敏感凭据**，等同于你的 B 站登录态。切勿写入 `wrangler.toml`、源码或提交到版本库。本地用 `.dev.vars`（已 gitignore），线上用 `wrangler secret put`。
- **`ADMIN_TOKEN` 是管理后台唯一凭据**，泄露等同服务被接管（可改接口公开策略）。请使用足够长的随机串；本地 `.dev.vars` 已 gitignore，线上用 `wrangler secret put ADMIN_TOKEN`。
- 生产环境建议把 `CORS_ORIGIN` 从 `"*"` 收紧为具体域名，避免任意站点直接调用你的服务。
- 会话 Cookie 为 HttpOnly + SameSite=Strict，签名密钥由 `ADMIN_TOKEN` 派生——**更换 `ADMIN_TOKEN` 会立即使全部已有会话失效**（可用于紧急踢出）。
- 服务为只读接口，不写入任何账号数据；但携带登录态 Cookie 意味着请求以你的账号身份发出，请自行评估风险。
- 请勿高频调用，以免给上游造成压力，也避免触发风控导致服务不可用。

---

## 开发脚本

| 脚本 | 命令 | 说明 |
| --- | --- | --- |
| `pnpm dev` | `wrangler dev` | 本地预览，默认 `http://127.0.0.1:8787` |
| `pnpm typecheck` | `tsc --noEmit` | TypeScript 类型检查 |
| `pnpm test` | `node scripts/md5-check.mjs` | MD5 回归测试（RFC 1321 官方向量） |
| `pnpm smoke` | `node scripts/smoke.mjs` | 全接口冒烟测试（**需先起 `pnpm dev`**） |
| `pnpm debug:upstream` | esbuild 打包后运行 | 直接打上游看原始响应，排查字段映射 |
| `pnpm deploy` | `wrangler deploy` | 部署到 Cloudflare |
| `pnpm check` | `typecheck && test` | 类型检查 + 单测 |

冒烟测试默认请求 `http://127.0.0.1:8787`，可通过环境变量切换：

```bash
SMOKE_BASE=http://127.0.0.1:8788 pnpm smoke
```

---

## 免责声明

本项目仅供学习和研究使用。使用前请阅读并遵守哔哩哔哩用户协议及相关法律法规，不要用于商业用途或侵犯他人版权。接口数据与视频版权归哔哩哔哩及原视频作者所有。请勿高频请求，以免给上游造成压力。
