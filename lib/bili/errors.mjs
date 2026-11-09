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
   * @param {{status?: number, biliCode?: number, retryable?: boolean, data?: unknown,
   *   biliMessage?: string|null, hint?: string, pauseMs?: number}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
    this.status = extra.status;
    this.biliCode = extra.biliCode;
    this.retryable = extra.retryable === true;
    this.data = extra.data;
    // 平台原话与操作提示分开保留：工具层可以只投影需要给模型看的字段，
    // 但排障与 check 必须还能拿到 B 站说了什么。
    this.biliMessage = extra.biliMessage ?? null;
    this.hint = extra.hint ?? null;
    this.pauseMs = extra.pauseMs;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      biliCode: this.biliCode,
      biliMessage: this.biliMessage,
      hint: this.hint,
      retryable: this.retryable,
    };
  }
}

export function isBiliError(error) {
  return error instanceof BiliError;
}

/**
 * B站业务码 → 稳定错误码。
 *
 * 只收录“需要模型/用户采取行动”的那些；其余业务码仍会保留 B 站原话，
 * 见 fromBiliCode 的 platform message 回退。
 *
 * `pauseMs` 只对账号写入限流生效；`hint` 是给模型看的动作建议，
 * 不替代平台原话（message 优先使用平台返回的 message）。
 */
const CODE_MAP = {
  [-101]: { code: 'AUTH_REQUIRED', message: '未登录或登录已过期，请重新扫码登录' },
  [-111]: { code: 'PERMISSION_DENIED', message: 'CSRF 校验失败（bili_jct 缺失或与 SESSDATA 不匹配）' },
  [-352]: { code: 'RISK_CONTROLLED', message: '触发 B站风控校验（-352），请降低频率、稍后再试' },
  [-400]: { code: 'INVALID_ARGUMENT', message: '请求参数不合法' },
  [-403]: { code: 'PERMISSION_DENIED', message: '没有权限执行该操作' },
  [-404]: { code: 'NOT_FOUND', message: '目标不存在' },
  [-412]: { code: 'RATE_LIMITED', message: '请求被限流（-412），请稍后再试' },
  [-509]: { code: 'RATE_LIMITED', message: '请求过于频繁（-509），请稍后再试' },
  [-799]: { code: 'RATE_LIMITED', message: '请求过于频繁（-799），请稍后再试' },

  // 评论
  [12001]: { code: 'INVALID_ARGUMENT', message: '已经存在评论主题' },
  [12002]: { code: 'CONTENT_UNAVAILABLE', message: '评论区已关闭' },
  [12003]: { code: 'PERMISSION_DENIED', message: '该评论区禁止回复' },
  [12004]: { code: 'PERMISSION_DENIED', message: '禁止对该评论点赞或点踩' },
  [12006]: { code: 'NOT_FOUND', message: '没有该评论' },
  [12009]: { code: 'INVALID_ARGUMENT', message: '评论主体的 type 不合法' },
  [12011]: { code: 'INVALID_ARGUMENT', message: '不合法的赞或踩' },
  [12015]: { code: 'PERMISSION_DENIED', message: '需要评论验证码', hint: '请在网页端完成验证码后再评论，不要自动重试。' },
  [12016]: { code: 'INVALID_ARGUMENT', message: '评论内容包含敏感信息' },
  [12022]: { code: 'NOT_FOUND', message: '评论已经被删除了' },
  [12025]: { code: 'INVALID_ARGUMENT', message: '评论字数过多' },
  [12035]: { code: 'PERMISSION_DENIED', message: '该账号被 UP 主列入评论黑名单' },
  [12045]: { code: 'PERMISSION_DENIED', message: '购买后即可发表评论' },
  [12051]: { code: 'INVALID_ARGUMENT', message: '重复评论，请勿刷屏' },
  [12052]: { code: 'CONTENT_UNAVAILABLE', message: '评论区已关闭' },

  // 私信发送（web_im/send_msg）
  [10005]: { code: 'UPSTREAM_ERROR', message: '消息 key 不存在，发送结果需要核对' },
  [21007]: { code: 'INVALID_ARGUMENT', message: '消息过长，无法发送' },
  [21015]: { code: 'PERMISSION_DENIED', message: '只有绑定手机号的账号才能发送消息' },
  [21020]: { code: 'RATE_LIMITED', message: '发送消息频率过快，请稍后再发', pauseMs: 5 * 60 * 1000 },
  [21026]: { code: 'INVALID_ARGUMENT', message: '不能给自己发送消息' },
  [21028]: { code: 'UPSTREAM_ERROR', message: '系统升级，暂时无法发送' },
  [21035]: { code: 'UNSUPPORTED', message: '该类消息暂时无法发送' },
  [21037]: { code: 'INVALID_ARGUMENT', message: '图片格式不合法' },
  [21041]: { code: 'INVALID_ARGUMENT', message: '消息已超期，不能撤回' },
  [21042]: { code: 'INVALID_ARGUMENT', message: '消息已经撤回' },
  [21046]: { code: 'RATE_LIMITED', message: '发消息频率太高，请在 24 小时后再试', pauseMs: 24 * 60 * 60 * 1000 },
  [21047]: {
    code: 'DM_RESTRICTED',
    message: '对方主动回复或关注你前，最多发送 1 条消息',
    hint: '对方主动回复或关注你前，最多发送 1 条消息。这不是网络错误，请等待对方回复或关注，不要让模型自动重试。',
  },
  [25003]: { code: 'PERMISSION_DENIED', message: '对方隐私设置，暂无法发送聊天消息' },
  [25005]: { code: 'PERMISSION_DENIED', message: '你已拉黑对方，请先移出黑名单再聊天' },
  [700013]: { code: 'CONTENT_UNAVAILABLE', message: '粉丝团已解散，无法执行该操作' },
  [700014]: { code: 'PERMISSION_DENIED', message: '你已不在此粉丝团中，无法执行该操作' },

  // 动态
  [4100001]: { code: 'INVALID_ARGUMENT', message: '动态参数错误' },
  [4126021]: { code: 'PERMISSION_DENIED', message: '账号未绑定手机，无法发布动态' },
  [500404]: { code: 'NOT_FOUND', message: '动态已经删除过' },
  [500406]: { code: 'PERMISSION_DENIED', message: '动态不是自己的，不能删除' },
  [4120015]: { code: 'UPSTREAM_ERROR', message: '定时动态系统异常，请稍后重试' },
};

/**
 * 把一次 bilibili JSON 响应里的 code 映射成 BiliError。
 *
 * 关键约定：B 站自己返回的 `message`（或旧接口的 `msg`）永远优先保留，
 * 即使这个 code 没有登记在 CODE_MAP 里。以前只保留稳定码，导致 21047
 * 这类“平台说得很清楚、但代码没登记”的错误在工具输出里只剩一个错误码。
 *
 * @param {number} code
 * @param {string} [message]
 * @param {unknown} [data]
 */
export function fromBiliCode(code, message, data) {
  const hit = CODE_MAP[code];
  const platformMessage = typeof message === 'string' && message.trim() ? message.trim() : null;
  const stable = hit?.code ?? 'UPSTREAM_ERROR';
  const base = platformMessage || hit?.message || `B站接口返回 code ${code}`;
  // 未登记的 code 把数字带上，便于按 code 搜索；已登记的走可读文案。
  const text = hit ? base : `${base}（code ${code}）`;
  const retryable = hit?.retryable ?? (stable === 'RATE_LIMITED' || stable === 'RISK_CONTROLLED');
  return new BiliError(stable, text, {
    biliCode: code,
    retryable,
    data,
    biliMessage: platformMessage,
    hint: hit?.hint,
    pauseMs: hit?.pauseMs,
  });
}
