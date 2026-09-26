/**
 * 统一错误类型与 HTTP 错误响应工具。
 */

/** 业务/上游错误。status 为返回给调用方的 HTTP 状态码 */
export class BiliError extends Error {
  readonly code: number;
  readonly status: number;
  readonly detail?: unknown;

  constructor(message: string, opts: { code?: number; status?: number; detail?: unknown } = {}) {
    super(message);
    this.name = 'BiliError';
    this.code = opts.code ?? -1;
    this.status = opts.status ?? 502;
    this.detail = opts.detail;
  }
}

/** 400 参数错误 */
export function badRequest(message: string): BiliError {
  return new BiliError(message, { code: -400, status: 400 });
}

/** 404 资源不存在 */
export function notFound(message: string): BiliError {
  return new BiliError(message, { code: -404, status: 404 });
}

/** 502 上游异常 */
export function upstreamError(message: string, detail?: unknown): BiliError {
  return new BiliError(message, { code: -502, status: 502, detail });
}

/**
 * B 站返回的业务错误码 -> 建议的 HTTP 状态码
 * 参考：-400 请求错误 / -403 权限不足 / -404 不存在 / -412 风控 / -509 超频
 */
export function biliCodeToStatus(code: number): number {
  switch (code) {
    case -400:
      return 400;
    case -401:
    case -403:
      return 403;
    case -404:
      return 404;
    case -412:
      return 429;
    case -509:
      return 429;
    case -799:
      return 429;
    default:
      return 502;
  }
}
