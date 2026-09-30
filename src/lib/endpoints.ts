/**
 * 对外 API 契约清单 —— 全部 JSON 接口的 method/path/desc/query 定义。
 *
 * 原先内联在 src/index.ts，拆出来是因为它同时是多个模块的数据源：
 * - 首页与 /api 的服务自描述（index.ts 从这里 import）；
 * - 接口公开策略系统（src/lib/policy.ts）：策略 KV 的键以这里的 path 模板为准，
 *   请求路径按模板（如 /api/video/:id）归一后再查策略；
 * - /ui 控制台与 /adm 管理后台的接口列表展示。
 *
 * 注意：新增/修改接口路径时必须同步更新这里，否则策略系统将匹配不到新接口
 * （匹配不到的路径不受策略管控，按默认公开处理）。
 */

/** 单条接口定义。path 使用 Hono 风格模板段（`:xxx` 匹配任意单段） */
export interface EndpointDef {
  method: string;
  path: string;
  desc: string;
  /** 可选查询参数说明；空字符串表示无参数 */
  query?: string;
}

export const ENDPOINTS: EndpointDef[] = [
  { method: 'GET', path: '/api/video/:id', desc: '视频详情（支持 BV 号 / av 号 / 视频链接）', query: 'qualities=1 附带可用清晰度探测；pages=0 省略分P' },
  { method: 'GET', path: '/api/video/:id/pages', desc: '分 P 列表', query: '' },
  { method: 'GET', path: '/api/video/:id/playurl', desc: '播放地址（DASH 音视频流 / durl）', query: 'qn=80 清晰度；cid= 指定分P' },
  { method: 'GET', path: '/api/video/:id/qualities', desc: '可用清晰度列表', query: 'cid= 指定分P' },
  { method: 'GET', path: '/api/video/:id/danmaku', desc: '弹幕，format=json 返回数组，format=xml 返回标准 XML', query: 'format=json|xml；segment= 指定分段；maxSegments= 最大分段数' },
  { method: 'GET', path: '/api/video/:id/collection', desc: '该视频所属合集及全部视频', query: '' },
  { method: 'GET', path: '/api/user/:mid', desc: 'UP 主信息', query: '' },
  { method: 'GET', path: '/api/user/:mid/videos', desc: 'UP 主投稿列表', query: 'page=1；pageSize=30；keyword=；order=pubdate|click' },
  { method: 'GET', path: '/api/search/video', desc: '视频搜索', query: 'keyword=必填；page=1；pageSize=20；order=totalrank|click|pubdate|danmaku|stow' },
  { method: 'GET', path: '/api/search/user', desc: 'UP 主搜索', query: 'keyword=必填；page=1；pageSize=20' },
  { method: 'GET', path: '/api/favlist/:mediaId', desc: '收藏夹内容', query: 'page=1；pageSize=20' },
  { method: 'GET', path: '/api/health', desc: '健康检查', query: '' },
];
