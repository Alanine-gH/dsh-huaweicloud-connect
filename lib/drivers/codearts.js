/**
 * CodeArts 驱动器（CLI 授权模式优先）。
 *
 * ## 两套凭据，能力不同
 *
 * 2026-10-26 实测交叉对比（决定性的那张表）：
 *
 * | 凭据              | maas_type:benefit        | 不带 maas_type        |
 * |-------------------|--------------------------|-----------------------|
 * | App 的 STS        | `benefit not found`      | `TM.00001041`         |
 * | IAM 长期 AK/SK    | `benefit not found`      | **✅ 正常返回文本**    |
 *
 * 也就是说：
 *
 * - `maas_type: benefit` 这个签名头指向的是**「免费权益」通道**，该通道对本账号
 *   不可用（`InferHub.4004.200 benefit not found`）。早期版本把它硬签进请求，
 *   于是永远打到一条不存在的权益线上。
 * - IAM 长期 AK/SK 走的是**按量/CLI 通道**，只要不声明 benefit 就能正常对话。
 * - App 的 STS 即使不带 benefit 也过不去（`TM.00001041`），因为它只能走 benefit 通道。
 *
 * 所以本驱动**优先用华为云 IAM 的长期 AK/SK**（即官方 CLI 授权方式，
 * `CODEARTS_CLI_AK` / `CODEARTS_CLI_SK`），App 的 `state.vscdb` 仅作为降级来源。
 *
 * ## 为什么 AK/SK 模式更好
 *
 * - **不过期**：App 的 STS 只有约 1 小时，过期就得打开客户端续期；
 * - **不需要客户端在跑**：完全脱离 CodeArts Agent 进程；
 * - **签名域相同**：实测同一个 `snap-access` 网关，纯 AK/SK 签名即可通过。
 *
 * 一条硬约束仍然保留：**绝不刷新**。任何时候都不替用户续期 App 登录态——
 * refresh_token 轮换会把用户的客户端登出。
 *
 * @module dsh-huaweicloud-connect/drivers/codearts
 */

import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { signRequest } from "../apig-sign.js";

export const product = "codearts";
export const displayName = "CodeArts";
export const providerId = "huaweicloud-codearts";
export const envOverride = "HUAWEI_CODEARTS_AUTH_FILE";

/** CLI 授权方式的环境变量名（官方「CLI 授权指导」页给出的就是这个）。 */
export const cliEnvKeys = Object.freeze({ accessKey: "CODEARTS_CLI_AK", secretKey: "CODEARTS_CLI_SK" });

/** 主域名。备份域 `.cn` 暂不自动切换（见 spec §4 的 domain-switch 行为）。 */
const SNAP_APIG = "https://snap-access.cn-north-4.myhuaweicloud.com";
const CHAT_URL = `${SNAP_APIG}/api/v2/chat/completions`;
const MODELS_URL = `${SNAP_APIG}/v1/model/builtin`;

/** 凭据库绝对路径（VS Code globalStorage）。 */
function stateDbPath() {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "codearts-agent", "User", "globalStorage", "state.vscdb");
}

/**
 * 已知的 `credentials.csv` 位置（华为云 IAM 控制台「下载访问密钥」的产物）。
 *
 * 只在环境变量缺失时兜底扫描——不遍历全盘，只试几个约定位置。
 *
 * **顺序有讲究**：`.dsh` 下那份排第一。它由用户/本插件手工落位、权限被收窄到
 * 仅当前用户，比浏览器下载目录里那份明文密钥更安全。Downloads 保留是为了
 * 「刚下载完、还没搬走」的场景能直接用。
 */
function credentialCsvCandidates() {
  const home = homedir();
  const downloads = join(home, "Downloads");
  const dshHome = process.env.DSH_HOME ?? join(home, ".dsh");
  return [
    join(dshHome, ".huaweicloud-connect", "credentials.csv"),
    join(downloads, "credentials.csv"),
    join(downloads, "credentials (1).csv"),
    join(home, ".codearts", "credentials.csv"),
  ];
}

/**
 * 解析华为云 IAM 导出的 credentials.csv。
 *
 * 表头固定为 `User Name,Access Key Id,Secret Access Key`。**不按列序硬取**，
 * 按表头名字定位，避免不同导出批次列序变化时取错字段（把 SK 当 AK 用是很隐蔽的错）。
 *
 * @param {string} text CSV 文本
 * @returns {{accessKey:string, secretKey:string, user?:string}|undefined}
 */
export function parseCredentialCsv(text) {
  const lines = String(text ?? "").trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return undefined;

  /**
   * 去引号。
   *
   * 华为云导出的 CSV 会把字段整体包一层双引号（`"kongshuo2006"`），
   * 这是**合法 CSV**，引号不属于值本身。不过滤的话账号名会显示成
   * `"kongshuo2006"`，看着像程序出错。这里只剥掉首尾成对的引号，不动内部字符。
   */
  const unquote = (cell) => {
    const value = String(cell ?? "").trim();
    return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).trim() : value;
  };

  const header = lines[0].split(",").map((cell) => unquote(cell).toLowerCase());
  const iAk = header.findIndex((cell) => cell === "access key id");
  const iSk = header.findIndex((cell) => cell === "secret access key");
  const iUser = header.findIndex((cell) => cell === "user name");
  if (iAk === -1 || iSk === -1) return undefined;
  const cells = lines[1].split(",").map(unquote);
  const accessKey = cells[iAk];
  const secretKey = cells[iSk];
  if (typeof accessKey !== "string" || typeof secretKey !== "string") return undefined;
  if (accessKey.length === 0 || secretKey.length === 0) return undefined;
  return { accessKey, secretKey, ...(iUser !== -1 && cells[iUser] ? { user: cells[iUser] } : {}) };
}

/**
 * 读 CLI 模式（长期 AK/SK）凭据。
 *
 * 优先级：
 * 1. `CODEARTS_CLI_AK` + `CODEARTS_CLI_SK` 环境变量（官方推荐，最少暴露面）
 * 2. `HUAWEICLOUD_SDK_AK` + `HUAWEICLOUD_SDK_SK`（华为云通用变量，顺带认）
 * 3. 约定位置的 `credentials.csv`
 *
 * 找不到返回 undefined（让凭据层继续降级到 App STS），**不抛错**——
 * 没配 CLI 只是「没用上更优的方式」，不算故障。
 *
 * @returns {Promise<object|undefined>}
 */
export async function readCliCredential() {
  const fromEnv = (akKey, skKey, source) => {
    const accessKey = process.env[akKey];
    const secretKey = process.env[skKey];
    if (typeof accessKey === "string" && accessKey.length > 0 && typeof secretKey === "string" && secretKey.length > 0) {
      return { accessKey: accessKey.trim(), secretKey: secretKey.trim(), source };
    }
    return undefined;
  };

  const fromVars =
    fromEnv(cliEnvKeys.accessKey, cliEnvKeys.secretKey, "env:CODEARTS_CLI") ??
    fromEnv("HUAWEICLOUD_SDK_AK", "HUAWEICLOUD_SDK_SK", "env:HUAWEICLOUD_SDK");

  const shaped = (found, source) => ({
    kind: "aksk",
    mode: "cli",
    accessKey: found.accessKey,
    secretKey: found.secretKey,
    // CLI 模式是长期密钥，没有 STS，也没有过期时间
    securityToken: undefined,
    expiresAt: undefined,
    account: found.user,
    token: found.accessKey,
    baseUrl: SNAP_APIG,
    sourcePath: source,
  });

  if (fromVars !== undefined) return shaped(fromVars, fromVars.source);

  for (const path of credentialCsvCandidates()) {
    let text;
    try {
      text = await readFile(path, { encoding: "utf8" });
    } catch {
      continue;
    }
    const parsed = parseCredentialCsv(text);
    if (parsed !== undefined) return shaped(parsed, path);
  }
  return undefined;
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
 * 实测/推断的上下文窗口。
 *
 * ## `output` 是**上游硬约束**，写大了每个请求都会 400
 *
 * 2026-10-26 实测（CLI 授权，真实请求）：DSH 会把这里的 `output` 直接作为
 * `max_tokens` 发出去，超过上游允许值就返回
 * `InferHub.001001005.400 The request param is invalid`。
 *
 * 那个错误码**不在 DSH 的可重试集合里**（只有 EMPTY_RESPONSE / RATE_LIMIT /
 * SERVER / TIMEOUT / TRANSPORT），所以它会**立即失败、不重试**，
 * 紧接着 model-failover 判定模型不可用并熔断，切到下一个模型；
 * 下一个模型若同样超标，就再熔断一次 —— 用户看到的是一连串「模型熔断」。
 *
 * 逐档实测（deepseek-v4.1-flash）：
 *
 *   65536   OK（finish_reason: stop）
 *   81920   400 InferHub.001001005
 *   98304+  400
 *   131072  400
 *   384000  400   ← 曾经的取值，错得最离谱
 *
 * glm-5.3：65536 OK / 131072 400。
 *
 * 所以上限一律取 **65536**（实测可用且留有余量），宁可保守也不要让
 * 每个请求都必然被拒。历史上的 384000 / 393216 / 131072 都是错的值。
 */
export const CONTEXT_WINDOWS = {
  // deepseek 系列：窗口 1M，但**输出**上限实测只到 65536
  "deepseek-v4.1-flash": { context: 1_000_000, output: 65_536 },
  "deepseek-v4-flash-0731": { context: 1_000_000, output: 65_536 },
  "deepseek-v4-pro-0813": { context: 1_000_000, output: 65_536 },
  "glm-5.3-flash": { context: 202_752, output: 65_536 },
  "glm-5.3": { context: 202_752, output: 65_536 },
  // 以下为保守推断值（未逐个实测输出上限），统一压到已验证安全的 65536
  "glm-5.2": { context: 202_752, output: 65_536 },
  "GLM-5.2": { context: 202_752, output: 65_536 },
  "glm-5.2-sft-harmony": { context: 202_752, output: 65_536 },
  "kimi-k3": { context: 262_144, output: 65_536 },
  "openpangu-2.0-pro": { context: 524_288, output: 65_536 },
  "openpangu-2.0-flash": { context: 524_288, output: 65_536 },
};

const DEFAULT_CONTEXT = 202_752;
/** 未知模型的输出上限。也用 65536 —— 32_768 虽更保守，但会让回复被截断。 */
const DEFAULT_OUTPUT = 65_536;

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

/**
 * CodeArts 网关的「伪并发」限流错误。
 *
 * ## 文案是错的，别信它
 *
 * 上游回的是「并发会话数已达上限(3个)，请关闭部分会话后重试。（TM.00001041）」，
 * 但这**不是**真实并发会话数占满。实测（2026-10-26，串行发送、单请求、间隔 5~8 秒）：
 *
 * - 同一个 token、同一个模型，`InferHub.4004.200 benefit not found`（HTTP 200）
 *   与 `TM.00001041`（HTTP 400）**交替出现**：12 次里 3 次 200 / 9 次 400。
 * - 所有请求耗时 120~190ms，**没有任何慢请求** —— 没有真实会话在跑。
 * - CodeArts Agent 进程数 = 0，客户端根本没开，照样复现。
 * - 本驱动的 `throughGate` 串行化**已经在生效**，仍然报错 —— 排队绕不过它。
 *
 * 所以它是一个**网关侧的节奏/配额限流**，只是用了「并发会话」这条文案。
 * 真正的含义是「这一下打发不出去，等一下再来」。
 *
 * ## 为什么必须单独识别（这是踩过的坑）
 *
 * 早期版本把它归到 `UPSTREAM_ERROR`（DSH 的不可重试类）。后果是连锁的：
 *
 * 1. model-failover 立刻判定当前模型「不可用」并熔断，切到下一个模型；
 * 2. 下一个模型的第一次请求同样撞上这个限流，于是再熔断；
 * 3. 几个模型瞬间全被熔断，**整轮对话直接失败**。
 *
 * 用户看到的是一串 `400: 并发会话数已达上限(3个)`，而实际上一次正常的
 * 「等 10 秒重试」就能过去。所以这里必须给 **`RATE_LIMITED`** —— 它是可重试类，
 * 会走退避重试而不是熔断。
 *
 * @param {string|undefined} code 上游错误码
 * @param {string} message 上游错误文案
 */
export function isQuotaThrottle(code, message) {
  const haystack = `${code ?? ""} ${message ?? ""}`;
  return /TM\.00001041|并发会话数已达上限|并发会话数/i.test(haystack);
}

/**
 * 上游常见的「账号权益」错误。
 *
 * 实测（2026-10-26）：CodeArts 在权益失效时对**每一个**模型都回
 * `InferHub.4004.200 benefit not found`（HTTP 200 + 错误体，SSE 首帧）。
 * 此时目录接口 `/v1/model/builtin` 仍然正常，所以插件会显示「已登录、N 个模型」，
 * 但实际一个都发不出去 —— 用户很容易以为是插件坏了。
 */
export function isEntitlementProblem(code, message) {
  const haystack = `${code ?? ""} ${message ?? ""}`;
  return /benefit not found|InferHub\.4004|权益|no available channel|ModelArts\.81010/i.test(haystack);
}

/** 把上游错误体压成一句人话；token 过期 / 权益缺失 / 伪并发限流各自单独给提示。 */
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

  // 伪并发限流：文案照抄上游，但要明确告诉用户「关会话没用、等一会儿会自动重试」，
  // 否则用户会真的去关 CodeArts 窗口，然后发现毫无变化。
  if (isQuotaThrottle(code, message)) {
    return {
      message:
        `CodeArts 网关临时限流（上游文案写的是「${message}」，但这不是真的并发会话占满：` +
        `实测串行单请求、客户端未开也会出现）。插件会自动退避重试，通常十几秒内恢复；` +
        `若持续超过 1 分钟，请检查华为云账号的模型权益。${suffix}`,
      reasonCode: "RATE_LIMITED",
      status: 429,
    };
  }

  // 权益缺失：这不是「模型消失」，也不是插件故障，用户需要去控制台处理
  if (isEntitlementProblem(code, message)) {
    return {
      message:
        `CodeArts 账号没有该模型的对话权益（${message}）。` +
        `这不是插件故障：目录接口仍能列出模型，但每个对话请求都会被拒绝。` +
        `请到华为云 ModelArts / CodeArts 控制台确认模型权益是否开通或是否已到期${suffix}`,
      reasonCode: "ENTITLEMENT_MISSING",
      status: 403,
    };
  }

  /**
   * 参数校验失败（`InferHub.001001005.400`「The request param is invalid」）。
   *
   * 典型触发：`max_tokens` 超过上游允许值（实测 deepseek-v4.1-flash 上限在
   * 65536~81920 之间）。这类错误**必须归为可重试的限流类**，否则会连锁熔断：
   *
   *   不可重试 → 立即失败 → model-failover 判定模型不可用 → 切下一个模型
   *   → 下一个模型同样参数超标 → 再熔断 → 用户看到一串「模型熔断」
   *
   * 真正该修的是上层参数（见 CONTEXT_WINDOWS 的 output 上限），但请求参数
   * 由 DSH 组装，插件无法逐次改写；把这里判成 RATE_LIMITED 至少能让 DSH
   * 走退避重试，而不是把整条模型链路烧掉。
   *
   * 代价：如果是真正无法恢复的参数错误，会重试到上限才失败（约 5 次）。
   * 相比「一次失败就把所有模型熔断」，这个代价是值得的。
   */
  if (/InferHub\.001001005|request param is invalid|参数.{0,6}invalid/i.test(`${code ?? ""} ${message ?? ""}`)) {
    return {
      message:
        `CodeArts 拒绝了请求参数（${message}）。常见原因是 max_tokens 超过该模型允许值` +
        `（实测上限约 65536）。插件按可重试处理以免连锁熔断；若反复出现，` +
        `请在模型设置里调低最大输出 token。${suffix}`,
      reasonCode: "RATE_LIMITED",
      status: 429,
    };
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
 * ## `maas_type: benefit` 是个陷阱，只有 STS 才签
 *
 * 早期注释说「`maas_type: benefit` 必须签进去，不签会报 `InferHub.002002009.404`」。
 * 2026-10-26 实测推翻了它的普适性：
 *
 * - 这个头声明「我要走**免费权益**通道」；
 * - 本账号该通道不可用，于是**任何**带它的请求都回 `InferHub.4004.200 benefit not found`
 *   —— 即使 HTTP 状态是 200（错误藏在 SSE 首帧里）；
 * - **不带**它时，IAM 长期 AK/SK 能正常对话（实测 `finish_reason: stop` + 正文）。
 *
 * 所以按凭据类型分开：
 *
 * - `aksk`（CLI 模式）：**不签** `maas_type`，走按量通道；
 * - `plaintext`（App STS）：仍然签——它只能走 benefit 通道，不签反而会掉进
 *   `TM.00001041`（实测 STS + 不签 = TM）。
 *
 * 这是「同一个头，两套凭据行为相反」的典型情况，不能写成单一常量。
 *
 * @param {object} credential
 */
function chatHeaderGroups(credential) {
  const signHeaders = { "Content-Type": "application/json" };
  if (credential?.kind !== "aksk") signHeaders.maas_type = "benefit";
  return {
    signHeaders,
    postHeaders: {
      "Chat-Id": traceId(),
      "Session-Id": traceId(),
      lang: "zh-cn",
    },
  };
}

/**
 * CodeArts 对话请求的串行闸门。
 *
 * ## 它能做什么，不能做什么
 *
 * 早期这里写着「CodeArts 免费账号只允许 3 个并发会话，超了回 TM.00001041」。
 * **那个解释是错的**，2026-10-26 的实测推翻了它（详见 {@link isQuotaThrottle}）：
 * 串行单请求、客户端未开、间隔 5~8 秒，照样能复现 TM.00001041，而请求耗时
 * 只有 120~190ms —— 根本没有并发，也没有长跑会话。
 *
 * 所以闸门**不是** TM.00001041 的解药。真正修好它的是把该错误归为可重试的
 * `RATE_LIMITED`，让 DSH 退避重试而不是熔断切模型。
 *
 * 那就把闸门删掉？不删，换成它真正正当的理由：
 *
 * 1. DSH 一轮对话会并发发多个请求（主回复 / 会话标题 / 上下文压缩），
 *    对一个**共享配额**的网关，排一下队能减少无谓碰撞；
 * 2. 它让失败是**串行暴露**的：第一个请求的限流结果能立刻被看到，
 *    而不是三个请求一起撞墙、一起触发熔断。
 *
 * 代价是并发请求会排队（慢）。`CHAT_GAP_MS` 刻意保持很小——既然「3 个槽」
 * 是伪命题，就没有理由留 1.2 秒的大空档去「等槽位释放」。
 */
const CHAT_GAP_MS = 300;

/** 相邻请求最小间隔；导出给测试用。 */
export const CHAT_GATE_GAP_MS = CHAT_GAP_MS;

/** 队列尾；每个新请求挂在它后面。 */
let chatQueue = Promise.resolve();
/** 上一次请求开始的时间，用于保证相邻请求间隔 ≥ CHAT_GAP_MS。 */
let lastChatStartedAt = 0;

/**
 * 把一次请求排进闸门，保证同时只有一个在飞，且相邻间隔 ≥ CHAT_GAP_MS。
 *
 * 导出是为了让测试能锁住这个时序行为——它很容易被无意改坏，
 * 而坏了的表现是「并发时偶发撞限流」，很难复现。
 *
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function throughGate(task) {
  const run = async () => {
    const wait = Math.max(0, lastChatStartedAt + CHAT_GAP_MS - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastChatStartedAt = Date.now();
    return task();
  };
  const result = chatQueue.then(run, run);
  // 队列尾吞掉错误，否则一次失败会让后续所有请求连带 reject
  chatQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * 偷看流首帧，判断这是不是一个「HTTP 200 + 内嵌错误」的伪成功。
 *
 * ## 为什么要拆
 *
 * CodeArts 在权益失效 / 模型不支持时，**不会**给 4xx，而是给 HTTP 200，
 * 然后 SSE 第一帧直接是错误体：
 *
 *   data:{"error_code":"InferHub.4004.200","error_msg":"benefit not found",...}
 *
 * 如果原样把这条流交给 pi-ai，用户看到的是 DSH 侧的
 * `Stream ended without finish_reason`（TRANSPORT）—— 一个和真实原因毫无关系的
 * 报错，而且会被当成传输故障参与重试，最后触发模型熔断。
 *
 * 所以这里把首帧读出来分类，然后**把首帧接回流的最前面**，不丢数据。
 *
 * @param {ReadableStream<Uint8Array>} stream 上游原始流
 * @returns {Promise<{error: null|{code:string,message:string}, stream: AsyncIterable<Uint8Array|string>, status: number}>}
 */
async function inspectStreamHead(stream) {
  const reader = stream.getReader();
  let first;
  try {
    first = await reader.read();
  } catch (error) {
    // 连首帧都读不到：当作传输问题，原样抛给上层重试
    return { error: null, stream: emptyThenThrow(error), status: 200 };
  }
  if (first.done === true) {
    // 空流：也是「没有给 finish_reason」的同类问题，明确报出来
    return { error: { code: "TM.EMPTY_STREAM", message: "上游返回了空响应（没有任何 SSE 帧）" }, stream: emptyStream(), status: 200 };
  }

  const head = typeof first.value === "string" ? first.value : new TextDecoder().decode(first.value);
  const upstream = extractInlineError(head);
  if (upstream !== undefined) {
    return { error: upstream, stream: emptyStream(), status: 200 };
  }

  // 不是错误：把首帧原样接回去，保证不丢内容
  return { error: null, stream: prependChunk(first.value, reader), status: 200 };
}

/**
 * 从 SSE 首帧里抽内嵌错误（两种形状都认）。
 *
 * - `{"error_code":"InferHub.4004.200","error_msg":"benefit not found"}`
 * - `{"error":{"code":"...","message":"..."}}`
 *
 * 判定规则很保守：**必须出现错误字段，且不能同时出现 `choices`**。
 * 后者是关键——正常的 chunk 里也会带 `"error": null`，不能因此误判成失败。
 */
export function extractInlineError(head) {
  const text = String(head ?? "");
  if (text.length === 0) return undefined;
  if (/"choices"\s*:/.test(text)) return undefined;

  const flatCode = text.match(/"error_code"\s*:\s*"([^"]+)"/);
  if (flatCode !== null) {
    const flatMsg = text.match(/"error_msg"\s*:\s*"([^"]+)"/);
    return { code: flatCode[1], message: flatMsg === null ? "" : flatMsg[1] };
  }

  const nestedCode = text.match(/"error"\s*:\s*\{[^}]*?"code"\s*:\s*"([^"]+)"/);
  if (nestedCode !== null) {
    const nestedMsg = text.match(/"error"\s*:\s*\{[^}]*?"message"\s*:\s*"([^"]+)"/);
    return { code: nestedCode[1], message: nestedMsg === null ? "" : nestedMsg[1] };
  }
  return undefined;
}

/** 把已读出的首帧塞回流的开头。 */
async function* prependChunk(firstValue, reader) {
  try {
    yield firstValue;
    while (true) {
      const { done, value } = await reader.read();
      if (done === true) return;
      yield value;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/** 空流。 */
async function* emptyStream() {
  /* 无内容 */
}

/** 读首帧就失败时，把错误在迭代时才抛出（保持流形态）。 */
async function* emptyThenThrow(error) {
  throw error;
}

/**
 * 发一次对话请求。
 *
 * 经过 {@link throughGate} 串行化。**注意**：`TM.00001041` 已证实不是真实
 * 并发占满（见 {@link isQuotaThrottle}），串行化保留是为了减少无谓的碰撞，
 * 但它**不是**该错误的解药——真正的处理是把它归为可重试的限流。
 *
 * @param {object} credential
 * @param {object} body 已归一化的 OpenAI 请求体
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function chat(credential, body, opts = {}) {
  const payload = { ...body, stream: true };
  const bodyText = JSON.stringify(payload);

  return throughGate(async () => {
    const { signHeaders, postHeaders } = chatHeaderGroups(credential);

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

    // HTTP 200 也可能是错误（内嵌在 SSE 首帧里），必须拆开看
    const inspected = await inspectStreamHead(response.body);
    if (inspected.error !== null) {
      // 用与 4xx 完全相同的归纳路径，保证 reasonCode 一致
      const info = summarizeError(200, JSON.stringify({
        error_code: inspected.error.code,
        error_msg: inspected.error.message,
      }));
      throw new UpstreamError(info.message, {
        status: info.status,
        reasonCode: info.reasonCode,
        body: JSON.stringify(inspected.error),
      });
    }

    return { status: response.status, headers: {}, stream: inspected.stream };
  });
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
