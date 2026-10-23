/**
 * CodeArts Agent 驱动器。
 *
 * 上游事实（见 ref/codearts-spec.md）：
 * - 登录态落在 VS Code 系的 `state.vscdb`（SQLite）里，key `huaweicloud.codearts-snap`，
 *   JSON 路径 `userInfoKey.originData`，含 accessKey / secretKey / securityToken / expiresAt。
 *   这条是**明文**，用 `node:sqlite` 只读直取即可，不需要 DPAPI。
 * - 请求必须走华为 APIG 的 `SDK-HMAC-SHA256` 签名 + `X-Security-Token`。
 * - 因此本驱动**不能**走「纯 Bearer」路线，必须由 shim 统一签名。
 *
 * 一条硬约束：**绝不刷新**。CodeArts 的 refresh_token 与 DPoP 私钥都在 App 手里，
 * 插件自己续期会把用户的 App 登录态刷失效。STS 约 1 小时，过期只能提示用户
 * 打开 CodeArts Agent 让 App 自己续期。
 *
 * @module dsh-huaweicloud-connect/drivers/codearts
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { signRequest } from "../apig-sign.js";

export const product = "codearts";
export const displayName = "CodeArts";
export const providerId = "huaweicloud-codearts";
export const envOverride = "HUAWEI_CODEARTS_AUTH_FILE";

/** 主域名。备份域 `.cn` 暂不自动切换（见 spec §4 的 domain-switch 行为）。 */
const SNAP_APIG = "https://snap-access.cn-north-4.myhuaweicloud.com";
const CHAT_URL = `${SNAP_APIG}/api/v2/chat/completions`;
const MODELS_URL = `${SNAP_APIG}/v1/model/builtin`;

/** 凭据库绝对路径（VS Code globalStorage）。 */
function stateDbPath() {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "codearts-agent", "User", "globalStorage", "state.vscdb");
}

/** 候选：只有一条，但保留列表形态与凭据层契约一致。 */
export async function candidates() {
  return [stateDbPath()];
}

/** 从 VS Code 的 sqlite 里读 ItemTable。 */
async function readItem(dbPath, key) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (error) {
    throw Object.assign(new Error("当前 Node 运行时没有 node:sqlite，无法读取 CodeArts 登录态"), {
      code: "SQLITE_UNAVAILABLE",
      cause: error,
    });
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw Object.assign(new Error(`CodeArts 凭据库打不开: ${dbPath}`), { code: "SQLITE_OPEN_FAILED", cause: error });
  }
  try {
    const row = db.prepare("select value from ItemTable where key = ?").get(key);
    return typeof row?.value === "string" ? row.value : undefined;
  } catch (error) {
    throw Object.assign(new Error(`CodeArts 凭据表读取失败: ${key}`), { code: "SQLITE_QUERY_FAILED", cause: error });
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 读并解析凭据。返回凭据层能吃的规范化对象；未登录时抛 NOT_FOUND。
 *
 * 注意：本驱动不用 `parseAuth(text)`（凭据是 sqlite 二进制），走 `readCredential` 钩子。
 */
export async function readCredential(dbPath) {
  let info;
  try {
    info = await stat(dbPath);
  } catch {
    throw Object.assign(new Error(`CodeArts 凭据库不存在: ${dbPath}`), { code: "NOT_FOUND" });
  }
  if (!info.isFile() || info.size === 0) {
    throw Object.assign(new Error(`CodeArts 凭据库为空: ${dbPath}`), { code: "NOT_FOUND" });
  }

  let raw;
  try {
    raw = await readItem(dbPath, "huaweicloud.codearts-snap");
  } catch (error) {
    throw Object.assign(new Error(String(error?.message ?? "读取 CodeArts 登录态失败")), {
      code: error?.code === "SQLITE_UNAVAILABLE" ? "ENCRYPTED_UNSUPPORTED" : "UNREADABLE",
      cause: error,
    });
  }
  if (raw === undefined) {
    throw Object.assign(new Error("CodeArts 尚未登录（凭据库里没有 huaweicloud.codearts-snap）"), { code: "NOT_FOUND" });
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("CodeArts 登录态不是合法 JSON"), { code: "UNRECOGNIZED" });
  }

  const origin = doc?.userInfoKey?.originData;
  const ak = origin?.accessKey;
  const sk = origin?.secretKey;
  const sts = origin?.securityToken;
  if (typeof ak !== "string" || typeof sk !== "string" || typeof sts !== "string" || ak.length === 0 || sk.length === 0) {
    throw Object.assign(new Error("CodeArts 登录态缺少 accessKey/secretKey/securityToken"), { code: "UNRECOGNIZED" });
  }

  const expiresAtRaw = origin?.expiresAt;
  const expiresAt = typeof expiresAtRaw === "string" ? Date.parse(expiresAtRaw) : undefined;

  return {
    kind: "plaintext",
    accessKey: ak,
    secretKey: sk,
    securityToken: sts,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
    account: origin?.account?.id ?? origin?.domainId,
    // 供 shim 侧使用的「token」占位：CodeArts 的真正鉴权是签名，不含 bearer
    token: sts,
    baseUrl: SNAP_APIG,
    sourcePath: dbPath,
  };
}

/**
 * 模型上下文窗口快照。
 *
 * 数据来源与重要修正（2026-10-18 实测）：
 * - `/v1/model/builtin` 返回的 7 个模型（GLM-5.2 / glm-5.3 / openpangu-* / kimi-k2.6-vl / Qwen3-VL）
 *   **全部不能用于对话**，逐个实测返回 `InferHub.4005.200 unsupported model`。
 * - IDE 真正下发并使用的是 `inferhub-provider`，kernel 日志 `provider models update body`
 *   只列 5 个（同样都不含可用模型），但 `model-cache-hook` 记录了客户端实际缓存过的 8 个。
 * - 实测唯一确认可对话的是 `deepseek-v4.1-flash`（HTTP 200 + 正常 SSE）。
 *
 * 因此模型目录以「实测可用集」为准，builtin 仅作为参考信息保留在诊断里，
 * 不再直接当作可选模型——否则用户会选到一个必然报错的模型。
 */
/**
 * 实测/推断的上下文窗口（2026-10-23 目录接口核对后补全）。
 *
 * 来源标注：
 * - `deepseek-v4.1-flash` 等：早期真实请求验证
 * - `GLM-5.2` / `kimi-k3` / `glm-5.2-sft-harmony`：2026-10-23 目录接口收录，
 *   窗口为保守推断值（未逐个实测），后续有实测再更新
 */
export const CONTEXT_WINDOWS = {
  "deepseek-v4.1-flash": { context: 1_000_000, output: 384_000 },
  "deepseek-v4-flash-0731": { context: 1_000_000, output: 384_000 },
  "deepseek-v4-pro-0813": { context: 1_000_000, output: 393_216 },
  "glm-5.3-flash": { context: 202_752, output: 65_536 },
  "glm-5.3": { context: 202_752, output: 65_536 },
  "glm-5.2": { context: 202_752, output: 131_072 },
  "GLM-5.2": { context: 202_752, output: 131_072 },
  "glm-5.2-sft-harmony": { context: 202_752, output: 131_072 },
  "kimi-k3": { context: 262_144, output: 65_536 },
  "openpangu-2.0-pro": { context: 524_288, output: 131_072 },
  "openpangu-2.0-flash": { context: 524_288, output: 131_072 },
};

const DEFAULT_CONTEXT = 202_752;
const DEFAULT_OUTPUT = 32_768;

/** 已知支持图片的模型（其余一律只声明文本，避免「接受附件后被上游拒」）。 */
export const IMAGE_MODELS = new Set(["kimi-k2.6-vl", "Qwen3-VL-235B"]);

function toModelInfo(id, name, extras = {}) {
  const limits = CONTEXT_WINDOWS[id];
  return {
    id,
    name: typeof name === "string" && name.length > 0 ? name : id,
    // 目录里没给窗口大小的模型用保守默认值；有实测记录的优先
    contextWindow: limits?.context ?? DEFAULT_CONTEXT,
    maxTokens: limits?.output ?? DEFAULT_OUTPUT,
    input: IMAGE_MODELS.has(id) || extras.supportsImages === true ? ["text", "image"] : ["text"],
    reasoning: true,
    // 目录来源的元数据：hidden 影响选择器可见性（官方 UI 不列但接口能调通的
    // 模型仍然收录，是否露出交给用户）；desc/ratio 供设置页展示
    ...(extras.hidden === true ? { hidden: true } : {}),
    ...(extras.desc !== undefined ? { desc: extras.desc } : {}),
    ...(extras.ratio !== undefined ? { ratio: extras.ratio } : {}),
  };
}

/**
 * 兜底目录：客户端从未运行过时也至少给出已验证可用的那一个。
 *
 * 刻意只放 `deepseek-v4.1-flash`——它是唯一实测返回 200 + 正常 SSE 的模型。
 * 宁可只给一个，也不要给一串「选了必然报 unsupported model」的选项。
 */
export const fallbackModels = ["deepseek-v4.1-flash"].map((id) => toModelInfo(id));

/** 统一错误类型（与 officeace 驱动保持同形）。 */
export class UpstreamError extends Error {
  constructor(message, { status = 502, reasonCode = "UPSTREAM_ERROR", body } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.reasonCode = reasonCode;
    this.body = body;
  }
}

/** 32 位 hex（UUID 去掉横线）。 */
function traceId() {
  return randomUUID().replace(/-/g, "");
}

/**
 * 构造一次签名请求并发出。
 *
 * 关键区分（来自已跑通的参考实现 `deepseek-harness-codearts` 逐行核对）：
 * - `signHeaders`：**参与签名**，服务端会用它们重算 CanonicalHeaders
 * - `postHeaders`：**签名之后**再加，服务端不校验
 *
 * 为什么必须这么分：华为网关只对 SignedHeaders 里列出的头做校验，把不参与签名的头
 * （如 `Agent-Type`、`X-Language`、`Chat-Id`）混进签名会让两边对不上；反之
 * `maas_type: benefit` 必须签进去，否则报 `InferHub.002002009.404`。
 */
async function signedFetch({ url, method, bodyText, credential, signHeaders, postHeaders, signal }) {
  const signed = signRequest({
    method,
    url,
    headers: signHeaders,
    bodyText,
    accessKey: credential.accessKey,
    secretKey: credential.secretKey,
    securityToken: credential.securityToken,
  });
  const outgoing = { ...signed.headers, Authorization: signed.authorization };
  for (const [name, value] of Object.entries(postHeaders ?? {})) outgoing[name] = value;
  return fetch(url, { method, headers: outgoing, body: bodyText, signal });
}

/** 把上游错误体压成一句人话；token 过期单独给提示。 */
function summarizeError(status, text) {
  const trimmed = String(text ?? "").trim();
  let code;
  let message = trimmed;
  try {
    const json = JSON.parse(trimmed);
    code = json?.error_code ?? json?.code;
    message = json?.error_msg ?? json?.message ?? trimmed;
  } catch {
    /* 非 JSON */
  }
  const suffix = code === undefined ? "" : `（${code}）`;
  if (code === "APIG.0602" || /security token (has )?expired/i.test(String(message))) {
    return { message: `CodeArts 登录态已过期，请打开 CodeArts Agent 让它自动续期后重试${suffix}`, reasonCode: "TOKEN_EXPIRED", status: 401 };
  }
  if (status === 401 || status === 403) {
    return { message: `${message}${suffix}`, reasonCode: "AUTH_FAILED", status };
  }
  return { message: `${message}${suffix}`, reasonCode: status === 429 ? "RATE_LIMITED" : "UPSTREAM_ERROR", status };
}

/**
 * 拉模型目录。
 *
 * 策略（2026-10-18 实测修正）：
 * `/v1/model/builtin` 仍然请求——它是**登录态与签名链路是否正常的探针**，
 * 顺带确认账号能看到什么。但它返回的 7 个模型逐个实测都不能用于对话
 * （`InferHub.4005.200 unsupported model`），所以**不把它们当作可选模型**。
 *
 * 可选模型来自实测可用集 + 客户端实际缓存集。这个取舍是有意的：
 * 把 7 个「列得出来但必然报错」的模型塞进选择器，比不列更糟。
 *
 * @param {object} credential
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function listModels(credential, opts = {}) {
  // 拉真实目录。失败时抛错，让 UI 如实显示原因——不能静默退回写死列表，
  // 那会让用户以为一切正常。
  let response;
  try {
    response = await signedFetch({
      url: MODELS_URL,
      method: "GET",
      credential,
      // 只签 Content-Type；目录接口的 Agent-Type / X-Language 不参与签名
      signHeaders: { "Content-Type": "application/json" },
      postHeaders: {
        "Agent-Type": "PromptCenter",
        "X-Language": "zh-cn",
        Accept: "application/json",
      },
      signal: opts.signal,
    });
  } catch (error) {
    throw new UpstreamError(String(error?.message ?? error), { status: 502, reasonCode: "PROBE_FAILED" });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const info = summarizeError(response.status, text);
    throw new UpstreamError(info.message, { status: info.status, reasonCode: info.reasonCode, body: text });
  }

  const json = await response.json().catch(() => undefined);
  const raw = Array.isArray(json?.builtinModels) ? json.builtinModels : [];
  if (raw.length === 0) {
    // 目录空属于异常：宁可让上层走 fallback，也不能返回空数组——
    // 空数组会让模型选择器整个消失。
    throw new UpstreamError("模型目录返回为空", { status: 502, reasonCode: "EMPTY_CATALOG" });
  }

  const models = raw
    .filter((m) => m?.enable === true && typeof m?.model_id === "string" && m.model_id.length > 0)
    .map((m) =>
      toModelInfo(m.model_id, m.model_name, {
        // 官方明确不给展示的模型（如 Qwen3-VL / kimi-k2.6-vl）仍然收录，
        // 但标记 hidden：接口里 enable=true 说明能调通，只是官方 UI 不列——
        // 是否露出交给用户在插件设置里决定。
        supportsImages: m.supports_images === true,
        hidden: m.display_enabled !== true,
        desc: typeof m.model_desc === "string" ? m.model_desc : undefined,
        ratio: m.credit?.[0]?.ratio_display,
      }),
    );
  return models.length > 0 ? models : fallbackModels;
}

/**
 * 对话请求的头，分成「参与签名」与「签名后追加」两组。
 *
 * 依据：已跑通的参考实现 `deepseek-harness-codearts` 的 `lib/llm-adapter.js`
 * 实际只发签名头 + Content-Type + Chat-Id + Session-Id + lang；kernel 日志里那套
 * `x-ot-*` 头并非必需。少发头能同时降低伪造标记被风控的概率。
 *
 * `maas_type: benefit` 必须签进去：不签会报 `InferHub.002002009.404`。
 */
function chatHeaderGroups() {
  return {
    signHeaders: {
      "Content-Type": "application/json",
      maas_type: "benefit",
    },
    postHeaders: {
      "Chat-Id": traceId(),
      "Session-Id": traceId(),
      lang: "zh-cn",
    },
  };
}

/**
 * 发一次对话请求。
 *
 * @param {object} credential
 * @param {object} body 已归一化的 OpenAI 请求体
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function chat(credential, body, opts = {}) {
  const payload = { ...body, stream: true };
  const bodyText = JSON.stringify(payload);
  const { signHeaders, postHeaders } = chatHeaderGroups();

  const response = await signedFetch({
    url: CHAT_URL,
    method: "POST",
    credential,
    bodyText,
    signHeaders,
    postHeaders,
    signal: opts.signal,
  });

  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => "");
    const info = summarizeError(response.status, text);
    throw new UpstreamError(info.message, { status: info.status, reasonCode: info.reasonCode, body: text });
  }

  return { status: response.status, headers: {}, stream: response.body };
}

/** 诊断：只发 `GET /v1/model/builtin`，不消耗对话额度。 */
export async function diagnose(credential) {
  if (credential === undefined) {
    return { signedIn: false, hint: "未找到 CodeArts 登录态；请先打开 CodeArts Agent 并登录" };
  }
  const expired = typeof credential.expiresAt === "number" && credential.expiresAt <= Date.now();
  if (expired) {
    return {
      signedIn: true,
      expiresAt: credential.expiresAt,
      expired: true,
      hint: "CodeArts 的 STS 已过期（约 1 小时有效期）；请打开 CodeArts Agent 让它自动续期",
    };
  }
  try {
    const models = await listModels(credential);
    return { signedIn: true, expiresAt: credential.expiresAt, modelCount: models.length };
  } catch (error) {
    return {
      signedIn: true,
      expiresAt: credential.expiresAt,
      error: { code: error?.reasonCode ?? "UPSTREAM_ERROR", message: String(error?.message ?? error) },
    };
  }
}

export const driver = {
  product,
  displayName,
  providerId,
  envOverride,
  candidates,
  readCredential,
  fallbackModels,
  listModels,
  chat,
  diagnose,
};
