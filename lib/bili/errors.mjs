/**
 * Bilibili 错误分类。
 *
 * 工具层只关心 `code` 和 `retryable`：模型能读懂 code，调度/重试能读懂 retryable。
 * 不要把 SESSDATA / bili_jct 等凭据放进 message 或 data。
 */
export class BiliError extends Error {
  /**
   * @param {string} code 稳定的错误码
   * @param {string} message 面向人和模型的可读描述
   * @param {{status?: number, biliCode?: number, retryable?: boolean, data?: unknown}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
    this.status = extra.status;
    this.biliCode = extra.biliCode;
    this.retryable = extra.retryable === true;
    this.data = extra.data;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      biliCode: this.biliCode,
      retryable: this.retryable,
    };
  }
}

export function isBiliError(error) {
  return error instanceof BiliError;
}

/** B站业务码 → 稳定错误码。只收录“需要模型/用户采取行动”的那些。 */
const CODE_MAP = {
  [-101]: ['AUTH_REQUIRED', '未登录或登录已过期，请重新扫码登录'],
  [-111]: ['PERMISSION_DENIED', 'CSRF 校验失败（bili_jct 缺失或与 SESSDATA 不匹配）'],
  [-352]: ['RISK_CONTROLLED', '触发 B站风控校验（-352），请降低频率、稍后再试'],
  [-400]: ['INVALID_ARGUMENT', '请求参数不合法'],
  [-403]: ['PERMISSION_DENIED', '没有权限执行该操作'],
  [-404]: ['NOT_FOUND', '目标不存在'],
  [-412]: ['RATE_LIMITED', '请求被限流（-412），请稍后再试'],
  [-509]: ['RATE_LIMITED', '请求过于频繁（-509），请稍后再试'],
  [-799]: ['RATE_LIMITED', '请求过于频繁（-799），请稍后再试'],
};

/**
 * 把一次 bilibili JSON 响应里的 code 映射成 BiliError。
 * @param {number} code
 * @param {string} [message]
 * @param {unknown} [data]
 */
export function fromBiliCode(code, message, data) {
  const hit = CODE_MAP[code];
  const [stable, fallback] = hit ?? ['UPSTREAM_ERROR', message || `B站接口返回 code ${code}`];
  const retryable = stable === 'RATE_LIMITED' || stable === 'RISK_CONTROLLED';
  return new BiliError(stable, hit ? fallback : `${fallback}（code ${code}）`, {
    biliCode: code,
    retryable,
    data,
  });
}
