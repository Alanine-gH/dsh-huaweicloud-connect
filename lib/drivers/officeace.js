/**
 * OfficeAce 驱动器。
 *
 * 上游事实（见 ref/officeace-spec.md）：
 * - 直连华为云模型网关，不经 relayclaw 中转。
 * - 鉴权是 APIG「APP 认证」：`Authorization: Basic base64(app_key:app_secret)`，
 *   这个值在本地明文文件里**已经算好**，直接取用即可。
 * - 端点 `{api_base}/models`、`{api_base}/chat/completions`，OpenAI 兼容 SSE。
 *
 * 两条硬约束：
 * 1. **绝不刷新登录态**。OfficeAce 的 refresh_token 是一次性轮换的，插件自己续期
 *    会与 App 抢，触发 `STS5.1806` 把用户登出。这里只读、只提示过期。
 * 2. 华为网关限流时会用 **HTTP 200 + `data:{"error":…}` 伪错误帧**，必须在第一帧
 *    识别并转成真正的错误，否则前端会拿到一个「没有内容却正常结束」的回复。
 *
 * @module dsh-huaweicloud-connect/drivers/officeace
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const product = "officeace";
export const displayName = "OfficeAce";
export const providerId = "huaweicloud-officeace";
export const envOverride = "HUAWEI_OFFICEACE_AUTH_FILE";

/** 本地凭据：routing_state 下按用户目录放的 models.json。 */
function routingRoot() {
  return join(homedir(), ".office-claw", ".jiuwenclaw", "config", "routing_state", "users");
}

/** 兜底：模型目录缓存（每模型 baseUrl）。 */
function modelCatalogRoot() {
  return join(homedir(), ".office-claw", "users");
}

/**
 * 候选凭据路径。routing_state/users 下按 userId 分目录，
 * 正常只有一个；多个时按目录名排序取全部，由 locate() 挑第一个可读的。
 */
export async function candidates() {
  const root = routingRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    out.push(join(root, entry.name, "models.json"));
  }
  return out.sort();
}

/**
 * 解析凭据文件。取 `defaults[]` 里第一条同时带 api_base 与 Authorization 的配置。
 *
 * 形态（节选）：
 *   { defaults: [ { model_name, model_client_config: {
 *       api_base, api_key: "huawei-maas-session", custom_headers: { Authorization: "Basic …" } } } ] }
 */
export function parseAuth(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { kind: "unrecognized" };
  }
  const list = Array.isArray(doc?.defaults) ? doc.defaults : [];
  for (const item of list) {
    const config = item?.model_client_config;
    const apiBase = config?.api_base;
    const authorization = config?.custom_headers?.Authorization ?? config?.custom_headers?.authorization;
    if (typeof apiBase !== "string" || apiBase.length === 0) continue;
    if (typeof authorization !== "string" || authorization.length === 0) continue;
    return {
      kind: "plaintext",
      // OfficeAce 的「token」就是 Basic 头，名字保持 token 以便复用凭据层
      token: authorization,
      baseUrl: apiBase.replace(/\/+$/, ""),
      modelName: typeof config?.model_name === "string" ? config.model_name : item?.model_name,
      account: typeof item?.user_id === "string" ? item.user_id : undefined,
      // 有意不给 expiresAt / refresh：本驱动不刷新
    };
  }
  return { kind: "unrecognized" };
}

/** App 内置上下文元数据（API 不返回，见 spec §3.2）。 */
const CONTEXT_WINDOWS = {
  "deepseek-v4.1-flash": 1_000_000,
  "deepseek-v4.1-flash-0930": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-flash-0731": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  glm: 202_752,
  "glm-5": 202_752,
  "glm-5.1": 202_752,
  "glm-5.2": 202_752,
  "glm-5.3": 202_752,
  "glm-5.2-harmony": 202_752,
  "glm-5.2-zx": 202_752,
  "glm-5.2-a3": 202_752,
  "glm.5.2-arkts-spark": 202_752,
  "kimi-k2.6": 262_144,
  "qwen3-32b": 131_072,
  "qwen3-30b-a3b": 131_072,
  "openpangu-2.0-pro": 131_072,
  "openpangu-2.0-flash": 131_072,
};

const DEFAULT_CONTEXT_WINDOW = 131_072;
const DEFAULT_MAX_TOKENS = 32_768;

/**
 * 目录里的模型 → DSH 需要的模型描述。
 *
 * `reasoning` 只是"**可能**有推理能力"的粗筛，真正给不给档位由
 * `reasoning.js` 的 `resolveReasoning` 决定：它按「上游声明 → 本地探测 →
 * 内置基线」的优先级解析，并在探测发现上游不校验参数时一票否决。
 *
 * 这里不用太细的正则：`deepseek-v4-pro` 实测已下线（404 Invalid model），
 * `qwen3-*` 实测接受任意 reasoning_effort 值（non-validating），两者都不该
 * 凭模型名就给档位——那两件事交给探测与基线表判断。
 */
function toModelInfo(id) {
  return {
    id,
    name: prettify(id),
    contextWindow: CONTEXT_WINDOWS[id] ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    input: ["text"],
    reasoning: /^(deepseek-v4|glm|kimi-k2)/i.test(id),
  };
}

/** `deepseek-v4.1-flash` → `DeepSeek-V4.1-Flash` 这类展示名。 */
function prettify(id) {
  const known = {
    "deepseek-v4.1-flash": "DeepSeek-V4.1-Flash",
    "deepseek-v4-flash": "DeepSeek-V4-Flash",
    "deepseek-v4-pro": "DeepSeek-V4-Pro",
    "openpangu-2.0-pro": "OpenPangu-2.0-Pro",
    "openpangu-2.0-flash": "OpenPangu-2.0-Flash",
    "kimi-k2.6": "Kimi-K2.6",
  };
  if (known[id] !== undefined) return known[id];
  return id;
}

/** 兜底目录：App 未登录或首次启动时仍让分组可见（选中会报错，但比空分组好提示）。 */
export const fallbackModels = [
  "deepseek-v4.1-flash",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5.3",
  "glm-5.2",
  "glm-5.1",
  "kimi-k2.6",
  "qwen3-32b",
  "qwen3-30b-a3b",
].map(toModelInfo);

/** 统一的上游错误。 */
export class UpstreamError extends Error {
  constructor(message, { status = 502, reasonCode = "UPSTREAM_ERROR", body } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.reasonCode = reasonCode;
    this.body = body;
  }
}

/** 把上游错误体压成一句人话。 */
function summarizeError(status, text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) return `OfficeAce 上游返回 HTTP ${status}`;
  try {
    const json = JSON.parse(trimmed);
    const message = json?.error?.message ?? json?.error_msg ?? json?.message;
    const code = json?.error?.code ?? json?.error_code ?? json?.code;
    if (typeof message === "string" && message.length > 0) {
      return code === undefined ? message : `${message}（${code}）`;
    }
  } catch {
    /* 非 JSON，按原文 */
  }
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/** 认证类错误单独给原因码，方便 UI 提示「打开 OfficeAce 重新登录」。 */
function reasonForStatus(status) {
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 429) return "RATE_LIMITED";
  return "UPSTREAM_ERROR";
}

/**
 * 拉模型目录。
 * @param {object} credential 来自凭据层
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function listModels(credential, opts = {}) {
  const url = `${credential.baseUrl}/models`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: credential.token,
      Accept: "application/json",
    },
    signal: opts.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new UpstreamError(summarizeError(response.status, text), {
      status: response.status,
      reasonCode: reasonForStatus(response.status),
      body: text,
    });
  }
  const json = await response.json();
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  const ids = rows
    .map((row) => (typeof row === "string" ? row : row?.id))
    .filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return fallbackModels;
  return ids.map(toModelInfo);
}

/**
 * 把上游 SSE 的第一帧做一次伪错误检查。
 *
 * 华为网关限流时返回 HTTP 200 + `data:{"error":{...}}`，如果直接透传，
 * 上层只会看到「流正常结束但没内容」。这里把第一帧缓冲到能判定为止。
 */
function guardPseudoErrorStream(stream) {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let decided = false;
  let pending = [];

  const flush = function* (text) {
    if (text.length > 0) yield text;
  };

  async function* run() {
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      if (decided) {
        yield text;
        continue;
      }
      buffer += text;
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) {
        // 第一帧还没收全，继续等；但设上限，避免无限缓冲
        if (buffer.length > 64 * 1024) {
          decided = true;
          yield buffer;
          buffer = "";
        }
        continue;
      }
      const firstFrame = buffer.slice(0, boundary);
      const error = extractErrorFromFrame(firstFrame);
      if (error !== undefined) {
        throw new UpstreamError(error.message, { status: error.status, reasonCode: error.reasonCode, body: firstFrame });
      }
      decided = true;
      yield buffer;
      buffer = "";
    }
    if (buffer.length > 0) yield buffer;
  }
  return run();
}

/** 从一帧 SSE 文本里提取上游错误。 */
function extractErrorFromFrame(frame) {
  for (const line of frame.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]" || payload.length === 0) continue;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    const error = json?.error;
    if (error !== undefined && error !== null) {
      const message = typeof error === "string" ? error : (error.message ?? error.error_msg ?? JSON.stringify(error));
      const code = typeof error === "object" && error !== null ? (error.code ?? error.error_code) : undefined;
      const status = /rate|limit|throttl|429/i.test(`${code ?? ""} ${message}`) ? 429 : 502;
      return {
        status,
        message: code === undefined ? String(message) : `${message}（${code}）`,
        reasonCode: status === 429 ? "RATE_LIMITED" : "UPSTREAM_ERROR",
      };
    }
  }
  return undefined;
}

/**
 * 发一次对话请求。
 *
 * @param {object} credential
 * @param {object} body 已归一化的 OpenAI 请求体
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{status: number, headers: Record<string,string>, stream: AsyncIterable<Uint8Array>}>}
 */
export async function chat(credential, body, opts = {}) {
  const url = `${credential.baseUrl}/chat/completions`;
  const payload = JSON.stringify({ ...body, stream: true });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: credential.token,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: payload,
    signal: opts.signal,
  });

  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => "");
    throw new UpstreamError(summarizeError(response.status, text), {
      status: response.status,
      reasonCode: reasonForStatus(response.status),
      body: text,
    });
  }

  return {
    status: response.status,
    headers: {},
    stream: guardPseudoErrorStream(response.body),
  };
}

/** 给宿主做诊断用：不消耗额度。 */
export async function diagnose(credential) {
  if (credential === undefined) {
    return { signedIn: false, hint: "未找到 OfficeAce 登录态；请先打开 OfficeAce 并登录一次" };
  }
  try {
    const models = await listModels(credential);
    return { signedIn: true, baseUrl: credential.baseUrl, modelCount: models.length };
  } catch (error) {
    return {
      signedIn: true,
      baseUrl: credential.baseUrl,
      error: { code: error?.reasonCode ?? "UPSTREAM_ERROR", message: String(error?.message ?? error) },
      hint: error?.reasonCode === "AUTH_FAILED" ? "OfficeAce 登录态已失效；请打开 OfficeAce 重新登录" : undefined,
    };
  }
}

/** 供外部确认状态文件是否还在（不读内容）。 */
export async function hasStateFile() {
  for (const path of await candidates()) {
    try {
      const info = await stat(path);
      if (info.isFile() && info.size > 0) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export const driver = {
  product,
  displayName,
  providerId,
  envOverride,
  candidates,
  parseAuth,
  fallbackModels,
  listModels,
  chat,
  diagnose,
};
