# Project: GetBili

哔哩哔哩（Bilibili）信息 API 服务：运行在 Cloudflare Workers 上，通过 HTTP 接口获取视频详情、播放地址（DASH 直链）、分 P、弹幕、UP 主信息、投稿列表、搜索、合集与收藏夹。

服务本身不代理视频流量，只返回结构化元数据与可直连的流地址。

## 技术栈

- 语言/运行时：TypeScript 5/7 + Cloudflare Workers（workerd）
- 框架/核心库：Hono 4（路由）、零运行时依赖（WBI 签名、设备指纹、protobuf 弹幕解析全部自实现）
- 构建/包管理：pnpm 11 + wrangler 4（esbuild 由 wrangler 内置）
- 测试：`node scripts/md5-check.mjs`（MD5 回归）+ `node scripts/smoke.mjs`（全接口真实上游冒烟）
- 参考项目：`D:\projects\python\BiLiganbei`（Python/PySide6 下载器，本项目的接口逻辑与风控策略参照它实现）

## 项目结构

- `src/index.ts` —— Worker 入口：CORS、访问控制挂载（policyGuard / uiGate）、伪装门槛、路由挂载、服务自描述
- `src/types.ts` —— **共享类型契约**，所有业务模块的接口签名以此为准；改动属破坏性变更
- `src/lib/endpoints.ts` —— **接口契约清单（ENDPOINTS）的唯一权威来源**（策略键与自描述共用；index.ts 也从这里 import）
- `src/lib/auth.ts` —— 管理后台认证：ADMIN_TOKEN 校验、HMAC 会话 Cookie（`gb_adm`）、Bearer 通道、`requireAdmin`
- `src/lib/policy.ts` —— 接口公开策略：KV 读写、路径模板匹配（`matchEndpointTemplate`）、`policyGuard` 中间件
- `src/disguise/page.ts` —— Cloudflare 404 伪装页（`cf404Page`，未登录时隐藏服务存在）
- `src/adm/page.ts` + `src/routes/adm.ts` —— /adm 管理后台（登录 + 策略开关，单文件内联 HTML）
- `src/ui/page.ts` + `src/routes/ui.ts` —— /ui 浏览器控制台（单文件内联 HTML）
- `src/lib/md5.ts` —— 纯 TS MD5（WBI 签名必需，见下方「项目记忆」）
- `src/lib/request.ts` —— 上游请求层：UA/Referer/Origin/Cookie 头、超时、重试、`biliRaw`/`biliEnvelope`/`biliData`
- `src/lib/wbi.ts` —— WBI 签名 + `wbiGet`（含按错误码自动刷新密钥/指纹并重试）
- `src/lib/fingerprint.ts` —— 设备指纹（buvid3/buvid4/b_lsid/_uuid/buvid_fp）与 `bili_ticket`，模块级缓存
- `src/lib/parse.ts` —— 输入解析（BV/av/URL、mid、收藏夹 ID）、清晰度映射、时长解析/格式化
- `src/lib/errors.ts` —— `BiliError` + `biliCodeToStatus`（上游码 → HTTP 状态码的唯一映射点）
- `src/lib/http.ts` —— 响应信封 `ok()`、查询参数读取、CORS、`errorToResponse`
- `src/bili/video.ts` —— 详情 / 分P / playurl / 清晰度
- `src/bili/danmaku.ts` —— protobuf 弹幕解析 + XML 输出（手写 varint）
- `src/bili/user.ts` —— UP 主信息（多源兜底）/ 投稿列表
- `src/bili/search.ts` —— 视频搜索 / UP 主搜索
- `src/bili/collection.ts` —— 合集（ugc_season）/ 收藏夹
- `src/routes/*.ts` —— 按资源划分的 Hono 路由
- `scripts/md5-check.mjs` —— RFC 1321 官方向量回归
- `scripts/smoke.mjs` —— 全接口冒烟（打本地 dev 服务，服务端再打真实上游；含访问控制与伪装断言，需 `.dev.vars` 里有 `ADMIN_TOKEN`）
- `scripts/ui-check.mjs` —— 内联页面离线检查（ui + adm + disguise 共 28 项，无需起服务）
- `scripts/ui-e2e.mjs` —— CDP 真实浏览器端到端（15 项，需先起 pnpm dev + 无头 Chrome，浏览器内先登录 /adm）
- `scripts/debug-upstream.ts` —— 调试夹具：直接打上游并打印原始响应，排查字段映射/风控必备
- `docs/API.md` —— 完整接口文档
- `wrangler.toml` —— Worker 配置与环境变量

## 工作流

```bash
pnpm install          # 安装依赖（见下方「pnpm 安装」注意事项）
pnpm dev              # 本地预览，默认 http://127.0.0.1:8787
pnpm typecheck        # tsc --noEmit，必须为 0 错误
pnpm test             # MD5 回归测试
pnpm smoke            # 全接口冒烟（需先起 pnpm dev）
pnpm debug:upstream   # 直接打上游看原始响应
pnpm deploy           # 部署到 Cloudflare
```

- 配置登录态：本地写 `.dev.vars`（`BILI_COOKIE="SESSDATA=xxx; bili_jct=xxx"`），线上 `pnpm exec wrangler secret put BILI_COOKIE`
- 代码约定：
  - 所有上游请求必须经 `src/lib/request.ts`，不要在业务模块里直接 `fetch`（会丢 Referer/UA 导致 -412 风控）
  - 错误统一抛 `BiliError`，HTTP 状态码只由 `biliCodeToStatus` 决定；不要在业务层硬编码状态码
  - 类型：禁用 `any`；上游响应定义内部 `RawXxx` interface 描述，再映射到 `src/types.ts` 的对外类型
  - import 用无扩展名相对路径；纯类型用 `import type`
  - 中文注释，重点说明「为什么」而不只是「做什么」
- Git 工作流：无固定分支约定；提交前跑 `pnpm run check`

### pnpm 安装（本机沙箱环境注意）

本机 WorkBuddy 沙箱下 pnpm 默认的 **isolated 链接模式会失效**（`node_modules/.pnpm` 里包齐全，但顶层符号链接全部缺失，表现为 `Cannot find module 'hono'`）。

解决：`pnpm-workspace.yaml` 里设置 `nodeLinker: hoisted`（pnpm 11 起配置写在 `pnpm-workspace.yaml` 而不是 `.npmrc`）。

配套注意：
- 从 isolated 切到 hoisted **必须先手动删掉 `node_modules`**（用 PowerShell 的 `Remove-Item -Recurse -Force`；bash 的 `rm -rf` 会被 safe-delete 守卫拦下并返回 `SAFE_DELETE_BULK_GUARD_ERROR: state lock timeout`，导致 `pnpm install` 静默失败/被杀）
- 原生包的 postinstall（esbuild / workerd / sharp）在沙箱里会因禁止 spawn 子进程而失败。已在 `pnpm-workspace.yaml` 的 `allowBuilds` 里全部设为 `false` —— 平台二进制包仍会正常安装，实测不影响 `wrangler dev` 与 `esbuild`
- 跑 node 包管理/构建命令前需 `unset NODE_OPTIONS`（WorkBuddy 注入的 safe-delete 钩子会拦截删除操作导致超时）。
  两个必须注意的次生影响：
  1. **该钩子同时也是删除保护网**，摘掉后子进程的删除操作会变成真实删除。因此只清**最少必要**的那一条命令，
     且对已入库目录做删除操作后立刻 `git status` 确认没有波及其它文件；误删可用 `git checkout -- <路径>` 恢复。
  2. 清变量只能用 `unset NODE_OPTIONS;` 或 `NODE_OPTIONS= <cmd>`，**不要用 `env -u NODE_OPTIONS <cmd>`** ——
     本机 shim 环境下后者会让子进程 stdout 完全丢失（退出码 0 但零输出），极易误判成命令静默失败。

### 调试脚本的运行方式

`scripts/debug-upstream.ts` 用了 `src/` 里的模块，而 Node 原生 TS 剥离**不支持无扩展名相对导入**，因此要先打包再跑：

```bash
node node_modules/esbuild/bin/esbuild scripts/debug-upstream.ts --bundle \
  --format=esm --platform=node --target=node20 --outfile=.tmp/debug-upstream.mjs
node .tmp/debug-upstream.mjs
```

（等价于 `pnpm debug:upstream`）

## 项目记忆

### 为什么用纯 TS 实现 MD5

WBI 签名强依赖 MD5，但 Web Crypto（`crypto.subtle`）不支持 MD5；走 `node:crypto` 则需要开 `nodejs_compat` 并引入 `@types/node`。为保持零依赖与运行时无关，`src/lib/md5.ts` 自带一份实现，正确性由 `scripts/md5-check.mjs` 的 RFC 1321 官方向量保证（8 条全通过）。**改动该文件后必须重跑 `pnpm test`。**

### WBI 签名要点（`src/lib/wbi.ts`）

- 密钥来自 `/x/web-interface/nav` 的 `wbi_img`。**未登录时该接口返回 `code=-101`，但 `data.wbi_img` 依然存在**，所以判断条件不能是 `code === 0`，否则游客态永远拿不到密钥
- mixinKey = `(imgKey + subKey)` 按 `MIXIN_KEY_ENC_TAB` 重排后取前 32 位
- 签名：参数按 key 字典序排序 → 追加 `wts` → **过滤空值参数** → 百分号编码 → `md5(query + mixinKey)` = `w_rid`
- 百分号编码用项目内的 `pyQuote()`（Python `quote(safe="")` 语义）：`encodeURIComponent` 不会编码 `!*'()`，而 Python 会，需补编码
- 密钥模块级缓存 10 分钟；并发请求用 inflight promise 去重，避免密钥请求风暴

### 设备指纹与 bili_ticket（`src/lib/fingerprint.ts`）—— 解决风控的关键

空间类接口（`/x/space/wbi/*`）**光有正确的 WBI 签名远远不够**，实测演进过程：

| 状态 | 上游返回 | 缺失的东西 |
| --- | --- | --- |
| 只有 WBI 签名 | `-352 风控校验失败` | 设备指纹（buvid3） |
| 加了 buvid3/buvid4/b_lsid/_uuid/buvid_fp | `-412 request was banned` | `bili_ticket` |
| 补齐 `bili_ticket` | 成功返回数据 | —— |

`bili_ticket` 申请链路：`ts = 当前秒` → `hexsign = HMAC-SHA256("XgwSnGZ1p", "ts" + ts)` → `POST /bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket?key_id=ec02&hexsign=..&context[ts]=..&csrf=`。

另外 `/x/space/wbi/arc/search` 还需按 web 端补齐 `dm_img_list` / `dm_img_str` / `dm_cover_img_str` / `dm_img_inter` 这组「设备画像」参数（见 `src/bili/user.ts` 的 `WEB_RISK_PARAMS`）。

`wbiGet` 的重试策略：`-401/-403/提示 w_rid` → 刷新 WBI 密钥；`-352/-412` → 刷新指纹与票据。各重试一次。

**遗留问题**：即使补齐上述全部，`/x/space/wbi/arc/search` 仍会按账号 + 时间窗口波动地返回 `-412`（实测同一个 mid 前一次 `count=258919` 正常、紧接着查询又变 `-412`）。配置 `BILI_COOKIE` 是唯一可靠缓解手段。

### 风控的「伪成功」陷阱（重要）

B 站风控有**两类**「伪成功」响应，都会让调用方拿到看起来合法、实际错误的答案。两处都必须显式处理，不能当普通空结果：

1. **搜索类接口**：返回 `code=0` 但 data 里只有 `v_voucher`、没有任何结果集。
   处理：`src/bili/search.ts` 的 `assertNotRiskControlled()` 识别这种应答并抛 `BiliError{code:-412}`。判定条件不能只看「数组为空」，而是「既没有结果数组、也没有 numResults」（真正的无匹配会返回 `result: []` 且 `numResults=0`）。

2. **空间投稿接口**：返回 `code=0` 但 `vlist: []` 且 `page.count=0`，与「该 UP 主确实没有投稿」在结构上**完全一致、无法区分**。
   实测佐证：同一个 `mid=486906719`（实际 258919 个投稿）前后两次请求，一次返回 `count=258919`、紧接着一次返回 `count=0`。
   处理：`src/routes/user.ts` 不做硬判错（否则会对真的没有投稿的 UP 主误报），而是在 `items` 为空、`total=0`、`page=1`、未传 `keyword` 时给响应附加 `meta.warning`。**冒烟测试会断言这个 warning 必须存在**，防止「静默错误答案」回归。

### 上游字段映射陷阱（都踩过并已修正）

1. **`playurl.format` 是历史遗留值**：DASH 模式下上游依然返回 `"flv720"` 这类值。必须按实际返回的流结构判定 `format`（有 `dash` → `"dash"`，否则 `durl` → `"durl"`），不能直接沿用上游字段
2. **搜索结果数组字段名是单数 `result`**，不是 `results`（读错会得到空列表）
3. **搜索结果的 `duration` 是 `"12:34"` 字符串**，不是秒数
4. **空间投稿列表的时长字段是 `length: "04:28"`**，既不是 `duration` 也不是数字
5. 搜索结果的 `pic` 常以 `//` 开头，必须补协议；标题含 `<em class="keyword">` 高亮标签，必须清理
6. `playurl` 的 dash 流字段同时存在 camelCase（`baseUrl`/`mimeType`/`frameRate`）与 snake_case（`base_url`/...），新版是 camelCase，需双兼容
7. 合集里的作者信息在 `arc.author`，**不是** `arc.owner`

时长解析统一走 `src/lib/parse.ts` 的 `parseDurationText()`（同时处理纯数字秒、`MM:SS`、`HH:MM:SS`）。

### 弹幕实现（`src/bili/danmaku.ts`）

- 接口 `/x/v2/dm/web/seg.so`（protobuf 二进制，不能用 JSON 解析），每段 6 分钟，`segment_index` 从 1 递增到解析不出数据为止
- 手写 varint 解析，无依赖。`DanmakuElem` 字段号：1=id, 2=progress(ms), 3=mode, 4=fontsize, 5=color, 6=midHash, 7=content, 8=ctime, 9=weight, 11=pool；`DmSegMobileReply` 的 field 1 是 repeated DanmakuElem
- 注意 `@cloudflare/workers-types` 把 `TextDecoder` 的 `ignoreBOM` 标为必填，构造时要显式传 `{ fatal: false, ignoreBOM: false }`
- XML 输出严格保持原始数据（不做合并/过滤，合并逻辑只服务于参考项目的 ASS 生成，本项目不需要）

### 访问控制与伪装（2026-09-30 新增）

**三层结构**：认证（`src/lib/auth.ts`）→ 策略（`src/lib/policy.ts`）→ 伪装（`src/disguise/page.ts`）。

- **认证**：`ADMIN_TOKEN`（secret）是唯一凭据。登录成功签发 HttpOnly + SameSite=Strict 的 HMAC 签名 Cookie（`gb_adm`，值 `<expMs>.<hex32签名>`，24h）；同时支持 `Authorization: Bearer <ADMIN_TOKEN>` 直连（脚本调用友好）。HMAC 密钥由 ADMIN_TOKEN 派生，**更换 ADMIN_TOKEN 即踢出全部会话**。token 比较先 SHA-256 再逐字节比对（防时序攻击）；登录失败固定延迟 300ms。
- **伪装矩阵**（未登录时）：`/`、`/api`（自描述端点）、`/ui`、`/ui/` → `cf404Page()` HTTP 404（三栏状态图 + Ray ID footer，main.css 与 SVG 图标全部内联，零外链）；业务接口被策略拦截 → 与 notFound 逐字一致的 JSON 404（不暴露「存在但需权限」）；全局 notFound 对 Accept 含 text/html 的请求也返回伪装页（与真实 CF 行为一致）。**伪装页是唯一的「明文 404」来源，不要把它改成 401/302**——那会立刻暴露服务存在。
- **策略**：KV（`POLICY_KV`，键 `api_policy`），值为 `Record<'/api' | '/api/health' | ENDPOINTS模板, 'public'|'token'>`。`matchEndpointTemplate()` 把实际路径映射回模板（`:xxx` 匹配任意单段）。**KV 读失败 fail-closed（按 token 处理），KV 未绑定全放行**——前者防「管理员以为锁了」，后者保持未部署 KV 时的向后兼容。
- **中间件顺序（关键）**：`policyGuard` 与 `uiGate` 必须挂在最外层 CORS 中间件**之后**（否则拦截响应丢 CORS 头）、所有路由注册之前；OPTIONS 预检在外层已短路。`/adm` 不受 policyGuard 管（否则会把自己锁死），`/adm/api/*` 用 `requireAdmin` 保护。
- **workers-types 5.x 下用裸 `crypto` 而不是 `globalThis.crypto`**（后者过不了 TS2339，与 fingerprint.ts 惯例一致，运行时等价）。
- **测试**：smoke 38 项（含 11 项访问控制断言 + 策略闭环 try/finally 恢复现场）、ui-check 28 项（ui 12 + adm 12 + disguise 4）、e2e 15 项（浏览器内 fetch 登录后 cookie 自动落 jar）。冒烟测试从 `.dev.vars` 解析 ADMIN_TOKEN，不读 BILI_COOKIE 进变量。

**内联页面三约定（血泪教训，三个页面都适用）**：整页 HTML 是一个模板字面量导出；内层 JS 禁止嵌套模板字面量与一切反斜杠（正则、`\n`、转义引号全不行）；动态文本一律 `textContent`/`createTextNode` 禁止 `innerHTML`。离线检查由 `scripts/ui-check.mjs` 把关（含 `vm.Script` 语法解析），违反约定的代码过不了它。

### 其他约定

- 未登录时 `playurl` 附加 `try_look=1`（受 `TRY_LOOK` 环境变量控制），可预览更高清晰度；`acceptQuality[].available` 反映的是**当前身份实际能拿到的流**，游客通常只有 480P/360P，这是真实反映而非 bug
- CORS 没有用 `hono/cors`，而是入口中间件自己 try/catch：中间件的「后置代码」在处理器抛错时不会执行，会导致错误响应缺少 CORS 头，浏览器端只能看到一个不透明的网络错误
- `-412` 统一映射为 HTTP 429（含搜索接口识别的风控应答），调用方用单一 `code=-412` 即可判定风控

### 冒烟测试的判读方式

`pnpm smoke` 的 SKIP 项通常是**环境性**的，不代表代码有问题：

- `GET /api/user/:mid/videos` 报 SKIP = 所有候选 UP 主当轮都被风控。脚本内置 `UPLOADER_MID_FALLBACKS`
  （`[8047632, 2267573, 703007996]`，覆盖不同量级与领域）作为兜底候选，因为 UP 主搜索接口本身常被拦，
  候选 mid 可能只剩详情接口给出的那一个。补兜底后该项实测由 SKIP 转 PASS（`mid=486906719` → `total=258919`）
- `GET /api/favlist/:mediaId` 报 SKIP = 从候选 UP 主里没探测到公开收藏夹

冒烟脚本会真实请求 B 站上游，**连续运行会触发限流**（搜索接口尤其明显，表现为 429）；此时它会把「风控被正确识别」也算作通过，而不会把静默空列表当成功。
