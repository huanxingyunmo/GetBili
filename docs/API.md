# GetBili 接口文档

本文档描述 GetBili 对外暴露的全部 HTTP 接口。所有接口均为 `GET`，返回 `application/json; charset=utf-8`（弹幕 XML 格式除外）。

- 本地默认地址：`http://127.0.0.1:8787`
- 部署后地址：`https://<your-worker>.<your-subdomain>.workers.dev`

---

## 通用约定

### 统一响应信封

成功：

```json
{ "code": 0, "message": "ok", "data": { } }
```

失败：

```json
{ "code": -400, "message": "缺少参数 keyword（搜索关键词）", "data": null }
```

部分错误响应会附带额外信息：

- 上游异常（`-502`）可带 `detail`，用于定位上游请求；
- 路由不存在（`-404`）会带 `hint`，提示查看接口清单。

**成功响应也可能带 `meta`**，用于提示「结果虽然返回成功、但可信度存疑」的情况。目前唯一的用例是 `/api/user/:mid/videos` 的软拦截告警（`meta.warning`），详见该接口小节。

### HTTP 状态码与业务码

| 业务 code | HTTP | 触发场景 |
| --- | --- | --- |
| `0` | 200 | 成功 |
| `-400` | 400 | 参数错误：缺失必填参数、无法从输入解析出标识 |
| `-404` | 404 | 资源不存在：视频 / UP 主 / 合集 / 收藏夹 / 路由 |
| `-412` | 429 | 风控拦截（含搜索接口识别到的风控应答），`message` 会提示配置 `BILI_COOKIE` |
| `-502` | 502 | 上游异常、网络失败、上游返回非 JSON |
| `-500` | 500 | 服务内部错误 |
| `-509` / `-799` | 429 | 上游限流 |

> 关于 `-412`：所有风控拦截统一返回 **HTTP 429 + `code=-412`**。包括搜索接口（`/api/search/video`、`/api/search/user`）识别到的 `v_voucher` 风控应答，以及其它接口透传的上游 `-412`（如 UP 主投稿的 `request was banned`）。调用方只需用 `code=-412` 判定风控并按「稍后重试」处理。

### CORS

- 非预检请求：所有响应（含 4xx / 5xx）都会带上 `Access-Control-Allow-Origin`。
- `OPTIONS` 预检：返回 `204`，含 `Access-Control-Allow-Methods: GET,OPTIONS`。
- 允许来源由 `CORS_ORIGIN` 控制，默认回显请求的 `Origin`；配置为逗号分隔白名单时只放行命中项。

### 输入解析规则

| 参数形态 | 支持的输入 | 解析规则 |
| --- | --- | --- |
| 视频标识 `:id` | `BV17x411w7KC`、`av170001`、`170001`、完整链接（可 URL 编码） | 优先匹配 `BV` + 10 位字符；再匹配 `av\d+`；再匹配纯数字 |
| UP 主 `:mid` | `486906719`、`https://space.bilibili.com/486906719` | 纯数字直接用；否则从 `space.bilibili.com/{mid}` 或首个 ≥2 位数字中提取 |
| 收藏夹 `:mediaId` | `123456`、含 `?fid=123456` 或 `/favlist/123456` 的链接 | 优先 `fid=`，其次 `favlist/`，再次纯数字 |

> 说明：本项目**不做本地 BV ↔ av 互转**。两个标识都会原样传给上游，由上游返回完整字段。

### 查询参数通用行为

- 整数参数使用 `qInt`：非数字时回退默认值，超出 `min`/`max` 会被钳制。
- 布尔参数使用 `qBool`：`0` / `false` / `no` / `off`（不区分大小写）为假，其余非空值为真。
- 空字符串查询参数（如 `?keyword=`）按「未提供」处理。

### 清晰度 qn 对照表

| qn | 描述 | qn | 描述 |
| --- | --- | --- | --- |
| 127 | 8K 超高清 | 80 | 1080P |
| 126 | 杜比视界 | 74 | 720P60 |
| 125 | HDR 真彩 | 64 | 720P |
| 120 | 4K 超清 | 32 | 480P |
| 116 | 1080P60 | 16 | 360P |
| 112 | 1080P+ | 6 | 240P |
| 100 | 智能修复 | | |

不在表中的 qn 会被格式化为 `未知清晰度(<qn>)`。

---

## 目录

- [服务自描述](#服务自描述)
  - [`GET /`](#get-)
  - [`GET /api`](#get-api)
- [健康检查](#健康检查)
  - [`GET /api/health`](#get-apihealth)
- [视频](#视频)
  - [`GET /api/video/:id`](#get-apivideoid)
  - [`GET /api/video`](#get-apivideo)
  - [`GET /api/video/:id/pages`](#get-apivideoidpages)
  - [`GET /api/video/:id/playurl`](#get-apivideoidplayurl)
  - [`GET /api/video/:id/qualities`](#get-apivideoidqualities)
  - [`GET /api/video/:id/danmaku`](#get-apivideoiddanmaku)
  - [`GET /api/video/:id/collection`](#get-apivideoidcollection)
- [UP 主](#up-主)
  - [`GET /api/user/:mid`](#get-apiusermid)
  - [`GET /api/user/:mid/videos`](#get-apiusermidvideos)
- [搜索](#搜索)
  - [`GET /api/search/video`](#get-apisearchvideo)
  - [`GET /api/search/user`](#get-apisearchuser)
- [收藏夹](#收藏夹)
  - [`GET /api/favlist/:mediaId`](#get-apifavlistmediaid)
- [公共数据结构](#公共数据结构)

---

## 服务自描述

### `GET /`

返回服务元信息、当前登录态与全部接口清单。可用于探活与客户端自动发现接口。

**查询参数**：无

**curl**

```bash
curl http://127.0.0.1:8787/
```

**返回示例**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "service": {
      "name": "GetBili API",
      "version": "0.1.0",
      "description": "哔哩哔哩视频信息 / 播放地址 / 分P / 弹幕 / UP 主 / 搜索 / 合集收藏夹 接口服务，运行于 Cloudflare Workers。",
      "docs": "GET / 或 GET /api 可查看全部接口",
      "disclaimer": "本项目仅供学习和研究使用，请遵守哔哩哔哩用户协议及相关法律法规。"
    },
    "auth": {
      "usingCookie": false,
      "tryLook": true,
      "hint": "未配置 BILI_COOKIE 时以游客身份请求（仅能获取到低清晰度流）；配置后请通过 try_look 关闭该降级行为。"
    },
    "endpoints": [
      { "method": "GET", "path": "/api/video/:id", "desc": "视频详情（支持 BV 号 / av 号 / 视频链接）", "query": "qualities=1 附带可用清晰度探测；pages=0 省略分P" },
      { "method": "GET", "path": "/api/video/:id/pages", "desc": "分 P 列表", "query": "" },
      { "method": "GET", "path": "/api/video/:id/playurl", "desc": "播放地址（DASH 音视频流 / durl）", "query": "qn=80 清晰度；cid= 指定分P" }
    ]
  }
}
```

> `endpoints` 为完整清单（共 12 项），此处仅节选。`auth.usingCookie` 表示服务是否已配置 `BILI_COOKIE`。

### `GET /api`

返回服务元信息与接口清单（不带 `auth` 块）。

**查询参数**：无

**curl**

```bash
curl http://127.0.0.1:8787/api
```

**返回示例**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "service": { "name": "GetBili API", "version": "0.1.0" },
    "endpoints": [
      { "method": "GET", "path": "/api/health", "desc": "健康检查", "query": "" }
    ]
  }
}
```

---

## 健康检查

### `GET /api/health`

**查询参数**：无

**curl**

```bash
curl http://127.0.0.1:8787/api/health
```

**返回示例**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "status": "ok",
    "time": "2026-09-26T09:30:00.000Z",
    "anonymous": true
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | 固定为 `"ok"` |
| `time` | string | 服务端当前时间（ISO 8601） |
| `anonymous` | boolean | 是否为游客身份（即未配置 `BILI_COOKIE`） |

---

## 视频

### `GET /api/video/:id`

获取视频详情。优先走需要 WBI 签名的上游详情接口（字段最全），失败时自动降级到免签名的 `view` 接口。

**路径参数**

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | BV 号 / av 号 / aid / 完整视频链接（建议 URL 编码） |

**查询参数**

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `qualities` | boolean | `false` | 传 `1` 时额外返回 `qualities` 数组（可用清晰度探测） |
| `pages` | boolean | `true` | 传 `0` 时省略分 P（`pages` 置为空数组），减小响应体 |

**curl**

```bash
# BV 号
curl "http://127.0.0.1:8787/api/video/BV1GJ411x7h7?qualities=1"

# av 号
curl "http://127.0.0.1:8787/api/video/av170001"

# URL 编码后的完整链接
curl "http://127.0.0.1:8787/api/video/https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1GJ411x7h7%2F"
```

**返回示例**（`data` 为 `VideoDetail`，附加 `qualities`）

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "bvid": "BV1GJ411x7h7",
    "aid": 170001,
    "cid": 279786,
    "title": "示例视频标题",
    "desc": "视频简介文案……",
    "cover": "https://i0.hdslb.com/bfs/archive/xxxxxxxx.jpg",
    "duration": 213,
    "pubdate": 1542038078,
    "ctime": 1542038078,
    "url": "https://www.bilibili.com/video/BV1GJ411x7h7",
    "state": 0,
    "stat": {
      "view": 1234567,
      "danmaku": 45678,
      "reply": 12345,
      "favorite": 65432,
      "coin": 32100,
      "share": 8765,
      "like": 98765,
      "nowRank": 0,
      "hisRank": 0
    },
    "owner": {
      "mid": 486906719,
      "name": "示例UP主",
      "face": "https://i1.hdslb.com/bfs/face/xxxxxxxx.jpg"
    },
    "dimension": { "width": 1920, "height": 1080, "rotate": 0 },
    "pages": [
      { "cid": 279786, "page": 1, "title": "P1 正片", "duration": 213, "from": "vupload" }
    ],
    "pageCount": 1,
    "tname": "MV",
    "dynamic": "视频动态文案",
    "videos": 1,
    "collection": null,
    "isInteraction": false,
    "qualities": [
      { "qn": 120, "description": "4K 超清", "available": false },
      { "qn": 80, "description": "1080P", "available": false },
      { "qn": 64, "description": "720P", "available": false },
      { "qn": 32, "description": "480P", "available": true },
      { "qn": 16, "description": "360P", "available": true }
    ]
  }
}
```

> `collection` 为视频所属合集的摘要（`{ id, title, cover, count }`），不属于任何合集时为 `null`。`qualities` 仅在 `qualities=1` 时出现，其 `available` 取决于当前身份。

**错误**

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `-400` | `:id` 无法解析出视频标识 |
| 404 | `-404` | 视频不存在（上游返回 `-404`） |
| 502 | `-502` | 上游异常 / 网络失败 |

### `GET /api/video`

与 `GET /api/video/:id` 等价，改用查询串传参，便于直接携带完整链接。

**查询参数**

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `url` | string | — | 完整视频链接（优先） |
| `input` | string | — | `url` 的别名，作用相同 |
| `bvid` | string | — | BV 号 |
| `aid` | string | — | av 号 / 纯数字 aid |
| `qualities` | boolean | `false` | 同 `/api/video/:id` |
| `pages` | boolean | `true` | 同 `/api/video/:id` |

四个入参按 `url` → `input` → `bvid` → `aid` 的顺序取第一个非空值。

**curl**

```bash
curl "http://127.0.0.1:8787/api/video?bvid=BV1GJ411x7h7"
curl "http://127.0.0.1:8787/api/video?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1GJ411x7h7"
```

**返回示例**：与 `GET /api/video/:id` 完全一致。

**错误**

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `-400` | 四个入参全部缺失 |

### `GET /api/video/:id/pages`

获取分 P 列表。

**路径参数**

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 同 `/api/video/:id` |

**查询参数**：无

**curl**

```bash
curl "http://127.0.0.1:8787/api/video/BV1GJ411x7h7/pages"
```

**返回示例**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "count": 2,
    "pages": [
      { "cid": 279786, "page": 1, "title": "P1 正片", "duration": 213, "from": "vupload" },
      { "cid": 279787, "page": 2, "title": "P2 番外", "duration": 96, "from": "vupload" }
    ]
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `count` | number | 分 P 数量 |
| `pages[].cid` | number | 该分 P 的 cid |
| `pages[].page` | number | 第几 P（从 1 开始） |
| `pages[].title` | string | 分 P 标题 |
| `pages[].duration` | number | 时长（秒） |
| `pages[].from` | string | 来源标记（如 `vupload`） |

### `GET /api/video/:id/playurl`

获取播放地址。返回 DASH 音视频分流直链（含备用地址与编码信息），部分老视频 / 番剧返回 `durl`。

**路径参数**

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 同 `/api/video/:id` |

**查询参数**

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `qn` | number | `80` | 请求清晰度（`min=1`）；服务端会返回最接近且不高于该值的流 |
| `cid` | number | `0` | 指定分 P 的 cid；不传则自动取第一 P |

**curl**

```bash
curl "http://127.0.0.1:8787/api/video/BV1GJ411x7h7/playurl?qn=80"
curl "http://127.0.0.1:8787/api/video/BV1GJ411x7h7/playurl?qn=64&cid=279786"
```

**返回示例**（游客身份下 1080P 不可用，服务端降级到 480P）

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "bvid": "BV1GJ411x7h7",
    "cid": 279786,
    "requestQn": 80,
    "qn": 32,
    "qualityName": "480P",
    "format": "dash",
    "timelength": 213000,
    "acceptQuality": [
      { "qn": 120, "description": "4K 超清", "available": false },
      { "qn": 80, "description": "1080P", "available": false },
      { "qn": 64, "description": "720P", "available": false },
      { "qn": 32, "description": "480P", "available": true },
      { "qn": 16, "description": "360P", "available": true }
    ],
    "dash": {
      "duration": 213,
      "video": [
        {
          "id": 32,
          "qualityName": "480P",
          "baseUrl": "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/.../video.m4s?params",
          "backupUrl": ["https://upos-sz-mirrorali.bilivideo.com/upgcxcode/.../video.m4s?params"],
          "bandwidth": 587000,
          "mimeType": "video/mp4",
          "codecs": "avc1.64001F",
          "width": 852,
          "height": 480,
          "frameRate": "30",
          "codecid": 7
        },
        {
          "id": 16,
          "qualityName": "360P",
          "baseUrl": "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/.../video.m4s?params",
          "backupUrl": [],
          "bandwidth": 304000,
          "mimeType": "video/mp4",
          "codecs": "avc1.64001E",
          "width": 640,
          "height": 360,
          "frameRate": "30",
          "codecid": 7
        }
      ],
      "audio": [
        {
          "id": 30280,
          "qualityName": "未知清晰度(30280)",
          "baseUrl": "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/.../audio.m4s?params",
          "backupUrl": [],
          "bandwidth": 132000,
          "mimeType": "audio/mp4",
          "codecs": "mp4a.40.2",
          "width": 0,
          "height": 0,
          "frameRate": "",
          "codecid": 0
        }
      ]
    },
    "durl": null,
    "best": {
      "video": {
        "id": 32,
        "qualityName": "480P",
        "baseUrl": "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/.../video.m4s?params",
        "backupUrl": ["https://upos-sz-mirrorali.bilivideo.com/upgcxcode/.../video.m4s?params"],
        "bandwidth": 587000,
        "mimeType": "video/mp4",
        "codecs": "avc1.64001F",
        "width": 852,
        "height": 480,
        "frameRate": "30",
        "codecid": 7
      },
      "audio": {
        "id": 30280,
        "qualityName": "未知清晰度(30280)",
        "baseUrl": "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/.../audio.m4s?params",
        "backupUrl": [],
        "bandwidth": 132000,
        "mimeType": "audio/mp4",
        "codecs": "mp4a.40.2",
        "width": 0,
        "height": 0,
        "frameRate": "",
        "codecid": 0
      }
    }
  }
}
```

**字段说明**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `requestQn` | number | 请求时指定的清晰度 |
| `qn` | number | 上游实际返回的清晰度 |
| `qualityName` | string | `qn` 对应的中文描述 |
| `format` | string | `"dash"` 或 `"durl"`（依据实际流结构判定，非照抄上游） |
| `timelength` | number | 视频总时长（毫秒） |
| `acceptQuality[]` | array | 可用清晰度列表，`available` 表示当前身份能否真正拿到该清晰度的流 |
| `dash.video[]` | array | DASH 视频流，字段含 `id`/`baseUrl`/`backupUrl`/`bandwidth`/`mimeType`/`codecs`/`width`/`height`/`frameRate`/`codecid` |
| `dash.audio[]` | array | DASH 音频流，字段同上（音频流 `id` 为音频质量码，通常不在 qn 表中，`qualityName` 会显示为 `未知清晰度(...)`） |
| `durl` | array \| null | 仅 `format=durl` 时存在，元素含 `order`/`length`/`size`/`url`/`backupUrl` |
| `best.video` | object \| null | 服务端挑好的最佳视频流 |
| `best.audio` | object \| null | 服务端挑好的最佳音频流（`bandwidth` 最大者） |

**`best.video` 选择规则**

1. 优先 `id === qn`；
2. 否则取 `id <= qn` 中 `id` 最大的一档（降级到最接近的清晰度）；
3. 否则取全列表中 `id` 最大的一档；
4. 同一清晰度存在多条不同编码的流时，按 `7(avc) > 12(hevc) > 13(av1)` 优先。

> DASH 直链带时效签名，且对 `Referer` 有校验，请尽早使用并携带 `Referer: https://www.bilibili.com/`。

**错误**

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `-400` | 视频标识无法解析 |
| 404 | `-404` | 视频不存在（仅提供 aid 时需先解析 bvid，解析失败返回此码） |
| 502 | `-502` | 上游异常 / 网络失败 / 签名密钥获取失败 |

### `GET /api/video/:id/qualities`

获取可用清晰度列表。内部按 4K 发一次播放地址请求，取上游回传的 `accept_quality` 并标注各项是否真的存在对应流。

**路径参数**

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 同 `/api/video/:id` |

**查询参数**

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `cid` | number | `0` | 指定分 P 的 cid；不传则自动取第一 P |

**curl**

```bash
curl "http://127.0.0.1:8787/api/video/BV1GJ411x7h7/qualities"
```

**返回示例**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "cid": 279786,
    "count": 5,
    "qualities": [
      { "qn": 120, "description": "4K 超清", "available": false },
      { "qn": 80, "description": "1080P", "available": false },
      { "qn": 64, "description": "720P", "available": false },
      { "qn": 32, "description": "480P", "available": true },
      { "qn": 16, "description": "360P", "available": true }
    ]
  }
}
```

> 上游探测失败时返回空数组（`count: 0`），不抛错；`cid` 仍会回显。

### `GET /api/video/:id/danmaku`

获取弹幕。走 B 站 protobuf 分段弹幕接口，每段 6 分钟，按段号递增请求直到某段为空 / 非 200 / 解析不出数据。支持 JSON 与标准 XML 两种输出。

**路径参数**

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 同 `/api/video/:id` |

**查询参数**

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `format` | string | `json` | `json` 返回 JSON 信封；`xml` 返回 B 站标准 XML |
| `segment` | number | `0` | 指定分段号（从 1 开始）；传了就只拉这一段 |
| `maxSegments` | number | `100` | 最多拉取的分段数（`min=1`，`max=1000`），每段约 6 分钟 |
| `cid` | number | `0` | 指定分 P 的 cid；不传则自动取第一 P |

**curl**

```bash
# JSON
curl "http://127.0.0.1:8787/api/video/BV1GJ411x7h7/danmaku?format=json&maxSegments=2"

# XML
curl "http://127.0.0.1:8787/api/video/BV1GJ411x7h7/danmaku?format=xml&maxSegments=1"
```

**返回示例（`format=json`）**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "bvid": "BV1GJ411x7h7",
    "cid": 279786,
    "count": 2,
    "danmaku": [
      {
        "id": 123456789012345,
        "progress": 12345,
        "mode": 1,
        "fontsize": 25,
        "color": 16777215,
        "midHash": "a1b2c3d4",
        "content": "前方高能",
        "ctime": 1542038100,
        "pool": 0,
        "weight": 10
      },
      {
        "id": 123456789012346,
        "progress": 67890,
        "mode": 5,
        "fontsize": 25,
        "color": 16711680,
        "midHash": "e5f6a7b8",
        "content": "顶部弹幕",
        "ctime": 1542038120,
        "pool": 0,
        "weight": 5
      }
    ]
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | number | 弹幕 ID |
| `progress` | number | 出现时间（毫秒） |
| `mode` | number | 1~3 滚动、4 底部、5 顶部、6 逆向、7 高级、8 代码、9 BAS |
| `fontsize` | number | 字号 |
| `color` | number | RGB 整数颜色值（如 `16777215` = 白） |
| `midHash` | string | 发送者 uid 的哈希 |
| `content` | string | 弹幕文本 |
| `ctime` | number | 发送时间戳（秒） |
| `pool` | number | 弹幕池 |
| `weight` | number | 权重 |

**返回示例（`format=xml`）**

`Content-Type` 为 `application/xml; charset=utf-8`，并带 `Content-Disposition: inline; filename="<bvid 或 cid>.xml"`。响应体**不是** JSON 信封。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<i>
    <d p="12.345,1,25,16777215,1542038100,0,a1b2c3d4,123456789012345">前方高能</d>
    <d p="67.890,5,25,16711680,1542038120,0,e5f6a7b8,123456789012346">顶部弹幕</d>
</i>
```

`p` 属性为 8 段，依次是：`时间秒(3位小数),mode,fontsize,color,ctime,pool,midHash,弹幕id`。

> 实现说明：protobuf 解析为手写 varint（`src/bili/danmaku.ts`），不引入 protobuf 运行时依赖。数据不做合并 / 过滤，原样输出；截断或损坏的数据会被优雅截断，已解析出的条目照常返回。

**错误**

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `-400` | 视频标识无法解析、cid 无法确定 |
| 502 | `-502` | 上游异常 |

### `GET /api/video/:id/collection`

获取该视频所属合集及其全部分集。通过视频详情中的 `ugc_season` 展开。

**路径参数**

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 同 `/api/video/:id` |

**查询参数**：无

**curl**

```bash
curl "http://127.0.0.1:8787/api/video/BV1GJ411x7h7/collection"
```

**返回示例**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "info": {
      "type": "collection",
      "id": 123456,
      "title": "示例合集",
      "cover": "https://i0.hdslb.com/bfs/archive/xxxxxxxx.jpg",
      "count": 12,
      "mid": 486906719,
      "upperName": "示例UP主"
    },
    "videos": [
      {
        "bvid": "BV1GJ411x7h7",
        "aid": 170001,
        "title": "第 1 集 示例标题",
        "cover": "https://i0.hdslb.com/bfs/archive/xxxxxxxx.jpg",
        "duration": 213,
        "play": 1234567,
        "danmaku": 45678,
        "ownerName": "示例UP主",
        "ownerMid": 486906719,
        "pubdate": 1542038078,
        "url": "https://www.bilibili.com/video/BV1GJ411x7h7"
      }
    ]
  }
}
```

> 合集内作者字段取自上游的 `arc.author`；`info.count` 优先取上游 `ep_count`，缺失时以实际展开到的分集数为准。

**错误**

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `-400` | 视频标识无法解析 |
| 404 | `-404` | 该视频**不属于任何合集** |
| 502 | `-502` | 上游异常 |

---

## UP 主

### `GET /api/user/:mid`

获取 UP 主信息。采用多源兜底：主源 `card`（含投稿数 / 粉丝数），备源 `acc/info`（含等级 / 性别，风控下静默降级）、`relation/stat`（关注数）、`upstat`（获赞数）。任一备源失败都不影响整体。

**路径参数**

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mid` | string | 是 | UP 主 UID（纯数字或 `space.bilibili.com` 链接） |

**查询参数**：无

**curl**

```bash
curl "http://127.0.0.1:8787/api/user/486906719"
```

**返回示例**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "mid": 486906719,
    "name": "示例UP主",
    "face": "https://i1.hdslb.com/bfs/face/xxxxxxxx.jpg",
    "sign": "个人签名文案",
    "level": 6,
    "sex": "男",
    "follower": 1234567,
    "following": 321,
    "video": 258919,
    "likes": 9876543,
    "url": "https://space.bilibili.com/486906719"
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `follower` | number | 粉丝数 |
| `following` | number | 关注数 |
| `video` | number | 投稿视频数 |
| `likes` | number | 获赞数 |

> 备源缺失的字段以 `0` 兜底（`level` / `sex` 在未登录 / 风控下可能为空值）。所有源都拿不到昵称时视为该 UP 主不存在。

**错误**

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `-400` | `:mid` 无法解析出 UID |
| 404 | `-404` | UP 主不存在 |

### `GET /api/user/:mid/videos`

获取 UP 主投稿列表（分页）。走 WBI 签名的空间投稿接口。

> ⚠️ **该接口有较严的账号级风控**，详见 [README 的「已知限制」](../README.md#已知限制)。服务已实现完整设备指纹 + `bili_ticket` 链路，并在 `-412` 时自动换一套全新指纹重试一次；仍失败返回 429。

**路径参数**

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mid` | string | 是 | UP 主 UID |

**查询参数**

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `page` | number | `1` | 页码（`min=1`） |
| `pageSize` | number | `30` | 每页条数（`min=1`，`max=50`） |
| `keyword` | string | — | 关键词过滤（上游支持） |
| `order` | string | `pubdate` | 排序：`pubdate`（最新）或 `click`（按播放） |

**curl**

```bash
curl "http://127.0.0.1:8787/api/user/486906719/videos?page=1&pageSize=5&order=pubdate"
```

**返回示例**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "items": [
      {
        "bvid": "BV1GJ411x7h7",
        "aid": 170001,
        "title": "示例投稿标题",
        "cover": "https://i0.hdslb.com/bfs/archive/xxxxxxxx.jpg",
        "duration": 268,
        "play": 45678,
        "danmaku": 321,
        "ownerName": "示例UP主",
        "ownerMid": 486906719,
        "pubdate": 1710000000,
        "url": "https://www.bilibili.com/video/BV1GJ411x7h7"
      }
    ],
    "total": 258919,
    "page": 1,
    "pageSize": 5,
    "pageCount": 51784,
    "hasMore": true
  }
}
```

> 上游该接口的时长字段是 `"04:28"` 文本，服务端已统一解析为**秒数**（示例中 `duration: 268`）。

**⚠️ 软拦截告警（`meta.warning`）**

B 站对该接口的风控有两种形态：明确的 `-412`，以及**返回 `code=0` 但列表为空、`total=0` 的「软拦截」**。后者与「该 UP 主确实没有投稿」在响应结构上完全一致，无法区分。

因此，当 `items` 为空、`total=0`、`page=1` 且未传 `keyword` 时，响应体会**额外携带 `meta.warning`**：

```json
{
  "code": 0,
  "message": "ok",
  "data": { "items": [], "total": 0, "page": 1, "pageSize": 30, "pageCount": 0, "hasMore": false },
  "meta": {
    "warning": "返回空列表且 total=0。B 站对该接口存在「软拦截」：风控时会返回 code=0 但列表为空，与「该 UP 主确实没有投稿」在响应结构上无法区分。若该 UP 主确实有投稿，请稍后重试或在服务端配置 BILI_COOKIE。"
  }
}
```

> 这里刻意**不改判为错误**，以免对真的没有投稿的 UP 主误报；但调用方必须检查 `meta.warning`，不要把一个空的 `items` 直接当成「该 UP 主没有投稿」。可参考的实测对照：`mid=486906719` 实际有 258919 个投稿，但被软拦截时同样会返回 `total=0`。

**错误**

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `-400` | `:mid` 无法解析 |
| 429 | `-412` | 账号级风控 `request was banned`，换指纹重试后仍失败；`message` 提示配置 `BILI_COOKIE` |
| 502 | `-502` | 上游异常 |

---

## 搜索

### `GET /api/search/video`

视频搜索。走 WBI 签名的搜索接口。

> ⚠️ **该接口存在 IP 级限流**：短时间内连续请求会触发 `v_voucher` 风控应答，此时接口会明确报错而不是返回空列表。

**路径参数**：无

**查询参数**

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `keyword` | string | **必填** | 搜索关键词 |
| `page` | number | `1` | 页码（`min=1`） |
| `pageSize` | number | `20` | 每页条数（`min=1`，`max=50`） |
| `order` | string | `totalrank` | 排序：`totalrank`（综合）/ `click`（播放）/ `pubdate`（最新）/ `danmaku`（弹幕）/ `stow`（收藏） |

**curl**

```bash
curl "http://127.0.0.1:8787/api/search/video?keyword=%E7%BD%97%E7%BF%94&page=1&pageSize=5"
```

**返回示例**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "items": [
      {
        "bvid": "BV1GJ411x7h7",
        "aid": 170001,
        "title": "示例视频标题",
        "cover": "https://i0.hdslb.com/bfs/archive/xxxxxxxx.jpg",
        "duration": 754,
        "play": 1234567,
        "danmaku": 45678,
        "ownerName": "示例UP主",
        "ownerMid": 486906719,
        "pubdate": 1542038078,
        "url": "https://www.bilibili.com/video/BV1GJ411x7h7"
      }
    ],
    "total": 1000,
    "page": 1,
    "pageSize": 5,
    "pageCount": 200,
    "hasMore": true
  }
}
```

> 搜索结果的标题带 `<em class="keyword">` 高亮标签，服务端已清理为纯文本；封面已补全为 `https://`。

**错误**

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `-400` | 缺少 `keyword` |
| **429** | `-412` | 命中风控（响应只有 `v_voucher`，无结果集）。`message` 会提示配置 `BILI_COOKIE` |
| 502 | `-502` | 上游异常 |

> 等价别名：`GET /api/search?keyword=...` 与 `GET /api/search/video` 行为一致（该别名未列入服务自描述的 `endpoints` 清单）。

### `GET /api/search/user`

UP 主搜索。

> ⚠️ **未登录状态下高概率被要求风控验证**。上游会返回 `code=0` 但 `data` 里只有一个 `v_voucher`，没有任何结果。服务**显式识别这种应答并抛出 HTTP 429 + `code=-412`**，而不是返回一个看起来成功的空列表。配置 `BILI_COOKIE` 后可大幅改善。

**路径参数**：无

**查询参数**

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `keyword` | string | **必填** | 搜索关键词 |
| `page` | number | `1` | 页码（`min=1`） |
| `pageSize` | number | `20` | 每页条数（`min=1`，`max=50`） |
| `order` | string | `totalrank` | 排序，同视频搜索 |

**curl**

```bash
curl "http://127.0.0.1:8787/api/search/user?keyword=%E5%93%94%E5%93%A9&pageSize=5"
```

**返回示例（正常）**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "items": [
      {
        "mid": 486906719,
        "name": "示例UP主",
        "face": "https://i1.hdslb.com/bfs/face/xxxxxxxx.jpg",
        "sign": "个人签名文案",
        "fans": 1234567,
        "videos": 258919,
        "level": 6,
        "url": "https://space.bilibili.com/486906719"
      }
    ],
    "total": 1000,
    "page": 1,
    "pageSize": 5,
    "pageCount": 200,
    "hasMore": true
  }
}
```

**返回示例（命中风控）**

```json
{
  "code": -412,
  "message": "B 站要求风控验证（UP 主搜索响应仅含 v_voucher，未返回结果集）。未登录状态下搜索接口容易被拦截，请在服务端配置 BILI_COOKIE（登录态 Cookie）后重试。",
  "data": null
}
```

HTTP 状态为 `429`。

**错误**

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `-400` | 缺少 `keyword` |
| **429** | `-412` | 命中风控，已显式识别并报错 |
| 502 | `-502` | 上游异常 |

---

## 收藏夹

### `GET /api/favlist/:mediaId`

获取收藏夹内容（分页）。

**路径参数**

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mediaId` | string | 是 | 收藏夹 ID（纯数字，或含 `fid=` / `favlist/` 的链接） |

**查询参数**

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `page` | number | `1` | 页码（`min=1`） |
| `pageSize` | number | `20` | 每页条数（`min=1`，`max=50`） |

**curl**

```bash
curl "http://127.0.0.1:8787/api/favlist/123456?page=1&pageSize=5"
```

**返回示例**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "info": {
      "type": "favlist",
      "id": 123456,
      "title": "示例收藏夹",
      "cover": "https://i0.hdslb.com/bfs/archive/xxxxxxxx.jpg",
      "count": 88,
      "mid": 486906719,
      "upperName": "示例UP主"
    },
    "videos": [
      {
        "bvid": "BV1GJ411x7h7",
        "aid": 170001,
        "title": "示例视频标题",
        "cover": "https://i0.hdslb.com/bfs/archive/xxxxxxxx.jpg",
        "duration": 213,
        "play": 1234567,
        "danmaku": 45678,
        "ownerName": "示例UP主",
        "ownerMid": 486906719,
        "pubdate": 1542038078,
        "url": "https://www.bilibili.com/video/BV1GJ411x7h7"
      }
    ],
    "page": 1,
    "pageSize": 5,
    "pageCount": 18,
    "total": 88,
    "hasMore": true
  }
}
```

> 收藏夹内失效稿件可能缺少 `bvid`（以空串表示），`url` 也为空串。

**错误**

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `-400` | `:mediaId` 无法解析出收藏夹 ID |
| 404 | `-404` | 收藏夹不存在或为空 |
| 502 | `-502` | 上游异常 |

---

## 公共数据结构

### `Paged<T>`

分页接口（投稿列表、视频搜索、UP 主搜索）统一使用：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | T[] | 当前页数据 |
| `total` | number | 总条数 |
| `page` | number | 当前页码 |
| `pageSize` | number | 每页条数 |
| `pageCount` | number | 总页数（`ceil(total / pageSize)`） |
| `hasMore` | boolean | 是否还有下一页 |

### `VideoBrief`

投稿列表、合集、收藏夹、视频搜索统一使用：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bvid` | string | BV 号 |
| `aid` | number | av 号 |
| `title` | string | 标题（已清理高亮标签） |
| `cover` | string | 封面（已补全为 `https://`） |
| `duration` | number | 时长（秒） |
| `play` | number | 播放量 |
| `danmaku` | number | 弹幕数 |
| `ownerName` | string | UP 主昵称 |
| `ownerMid` | number | UP 主 UID |
| `pubdate` | number | 发布时间戳（秒） |
| `url` | string | 标准视频页链接 |

### `QualityOption`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `qn` | number | 清晰度代码 |
| `description` | string | 中文描述 |
| `available` | boolean | 当前身份下是否真的能拿到该清晰度的流 |

### `CollectionInfo`

合集与收藏夹共用：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | `"collection"` 或 `"favlist"` |
| `id` | number | 合集 season_id / 收藏夹 media_id |
| `title` | string | 标题 |
| `cover` | string | 封面 |
| `count` | number | 内容总数 |
| `mid` | number | 所属 UP 主 UID |
| `upperName` | string | 所属 UP 主昵称 |

### `SearchedUser`

UP 主搜索结果专用：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `mid` | number | UID |
| `name` | string | 昵称（已清理高亮标签） |
| `face` | string | 头像 |
| `sign` | string | 个性签名 |
| `fans` | number | 粉丝数 |
| `videos` | number | 投稿数 |
| `level` | number | 等级 |
| `url` | string | 空间链接 |
