/**
 * @deepseek-ai/dsh-llm 的离线替身。
 *
 * 只实现被 dsh-workbuddy-connect（已验证可用）与本插件真实调用到的那几个函数，
 * 签名取自 DSH 0.2.1-rc.2 的实际用法。**这不是生产代码**，只服务于
 * testbed 里的离线端到端测试；真实运行时这些由 DSH 宿主提供。
 */

/** 默认重试策略：真实内核在这里给默认值，测试台照抄语义即可。 */
export function resolveRetryPolicy(value, label) {
  if (value !== undefined && value !== null) return value;
  return {
    label,
    mode: "normal",
    maxRetries: 3,
    retryableCodes: ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"],
    backoff: { initialDelayMs: 500, maxDelayMs: 8000, jitterRatio: 0.1 },
  };
}

/** 附件访问解析器：真实实现要把宿主路径翻译成进程路径。测试台只透传引用。 */
export function resolveImageAttachmentAccess(attachments, toProcessPath, ref) {
  return { attachments, toProcessPath, ref };
}

/** 供测试台断言用：错误分类常量（与内核同名，避免插件行为漂移）。 */
export const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED";
export const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
export const INVALID_CREDENTIAL_CODE = "INVALID_CREDENTIAL";
export const QUOTA_EXCEEDED_CODE = "QUOTA_EXCEEDED";

export class LlmError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "LlmError";
    this.code = code;
  }
}

export function isQuotaExceededError() {
  return false;
}

export function isContextWindowExceededError() {
  return false;
}
