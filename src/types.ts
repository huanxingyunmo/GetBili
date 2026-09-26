/**
 * 项目共享类型定义 —— 所有业务模块的**接口契约**。
 * 修改此文件前请先确认所有引用方，任意字段变更都属于破坏性变更。
 */

/** Worker 环境变量绑定（见 wrangler.toml / .dev.vars） */
export interface Env {
  /** 可选：B 站登录态 Cookie 串，如 "SESSDATA=xxx; bili_jct=xxx" */
  BILI_COOKIE?: string;
  /** 可选：自定义 User-Agent */
  BILI_UA?: string;
  /** CORS 允许来源，默认 "*" */
  CORS_ORIGIN?: string;
  /** 上游请求超时（毫秒字符串），默认 "15000" */
  REQUEST_TIMEOUT_MS?: string;
  /** 未登录时是否附加 try_look=1 以预览高清晰度，默认 "true" */
  TRY_LOOK?: string;
}

/** B 站通用响应信封 */
export interface BiliEnvelope<T> {
  code: number;
  message?: string;
  ttl?: number;
  data: T;
}

/** 清晰度选项 */
export interface QualityOption {
  qn: number;
  description: string;
  /** 是否存在该清晰度的实际流地址 */
  available: boolean;
}

/** 视频简要信息 —— 搜索结果 / 投稿列表 / 合集 / 收藏夹统一使用 */
export interface VideoBrief {
  bvid: string;
  aid: number;
  title: string;
  cover: string;
  /** 时长（秒） */
  duration: number;
  /** 播放量 */
  play: number;
  /** 弹幕数 */
  danmaku: number;
  ownerName: string;
  ownerMid: number;
  /** 发布/投稿时间戳（秒） */
  pubdate: number;
  /** 标准视频页链接 */
  url: string;
}

/** 分 P 信息 */
export interface VideoPart {
  cid: number;
  page: number;
  title: string;
  duration: number;
  from: string;
}

/** 视频统计信息 */
export interface VideoStat {
  view: number;
  danmaku: number;
  reply: number;
  favorite: number;
  coin: number;
  share: number;
  like: number;
  nowRank?: number;
  hisRank?: number;
}

/** 视频 UP 主信息（内嵌） */
export interface VideoOwner {
  mid: number;
  name: string;
  face: string;
}

/** 视频详情 */
export interface VideoDetail {
  bvid: string;
  aid: number;
  /** 默认第一 P 的 cid */
  cid: number;
  title: string;
  desc: string;
  cover: string;
  /** 总时长（秒） */
  duration: number;
  pubdate: number;
  ctime: number;
  /** 标准视频页链接 */
  url: string;
  /** 0 正常，其余为异常状态 */
  state: number;
  stat: VideoStat;
  owner: VideoOwner;
  dimension: { width: number; height: number; rotate: number };
  pages: VideoPart[];
  pageCount: number;
  tname: string;
  dynamic: string;
  /** 分 P 数量 */
  videos: number;
  /** 所属合集（不属于任何合集时为 null） */
  collection: { id: number; title: string; cover: string; count: number } | null;
  /** 是否为互动视频 */
  isInteraction: boolean;
}

/** DASH 流信息 */
export interface DashStream {
  id: number;
  /** 清晰度名称 */
  qualityName: string;
  baseUrl: string;
  backupUrl: string[];
  bandwidth: number;
  mimeType: string;
  codecs: string;
  width: number;
  height: number;
  frameRate: string;
  codecid: number;
}

/** 播放地址结果 */
export interface PlayUrlResult {
  bvid: string;
  cid: number;
  /** 请求时指定的清晰度 */
  requestQn: number;
  /** 实际返回的清晰度 */
  qn: number;
  qualityName: string;
  /** dash / durl */
  format: string;
  timelength: number;
  /** 可用清晰度列表 */
  acceptQuality: QualityOption[];
  dash: {
    duration: number;
    video: DashStream[];
    audio: DashStream[];
  } | null;
  /** 仅当 format=durl 时存在（部分老视频/番剧） */
  durl: { order: number; length: number; size: number; url: string; backupUrl: string[] }[] | null;
  /** 服务端按默认策略挑选的最佳音视频流，便于直接使用 */
  best: {
    video: DashStream | null;
    audio: DashStream | null;
  };
}

/** 弹幕条目 */
export interface DanmakuItem {
  id: number;
  /** 出现时间（毫秒） */
  progress: number;
  /** 1~3 滚动、4 底部、5 顶部、6 逆向、7 高级、8 代码、9 BAS */
  mode: number;
  fontsize: number;
  /** RGB 整数颜色值 */
  color: number;
  midHash: string;
  content: string;
  ctime: number;
  pool: number;
  weight: number;
}

/** UP 主信息 */
export interface UploaderInfo {
  mid: number;
  name: string;
  face: string;
  sign: string;
  level: number;
  sex: string;
  follower: number;
  following: number;
  /** 投稿视频数 */
  video: number;
  /** 获赞数 */
  likes: number;
  /** 个人空间链接 */
  url: string;
}

/** 分页结果 */
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  hasMore: boolean;
}

/** 合集 / 收藏夹信息 */
export interface CollectionInfo {
  type: 'collection' | 'favlist';
  id: number;
  title: string;
  cover: string;
  count: number;
  mid: number;
  upperName: string;
}
