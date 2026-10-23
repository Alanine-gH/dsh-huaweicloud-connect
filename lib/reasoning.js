/**
 * 推理档位（reasoning_effort）能力探测与缓存。
 *
 * ## 为什么需要探测
 *
 * 华为上游**不是**所有模型都支持 `reasoning_effort`，而且支持的档位逐模型不同。
 * 实测（2026-10-18，OfficeAce 网关）：
 *
 *   deepseek-v4-flash    low, medium, high, xhigh, max
 *   deepseek-v4-pro      无
 *   glm-5.2              none, minimal, low, medium, high, max
 *   glm-5.1              low, medium, high, max
 *   glm-5               无
 *   kimi-k2.6            low, high, xhigh, max
 *   qwen3-32b            全档
 *   qwen3-30b-a3b        全档
 *   openpangu-2.0-pro    无
 *   openpangu-2.0-flash  无
 *
 * 所以不能写死一张表：新模型会加进来，老模型的档位也可能变。做法与
 * dsh-workbuddy-connect 一致——**探测 + 本地缓存**，缓存带模型指纹，
 * 模型描述变了就重新探测。
 *
 * ## 探测方法（照 workbuddy 的三段隔离法）
 *
 * 上游会用 `ModelArts.81001` + `reasoning_effort must be none or low or ...`
 * 明确拒绝非法值，所以：
 *
 * 1. **baseline**：不带 `reasoning_effort` 发一次。失败就判 `unknown`——
 *    此时任何后续失败都不能归因于档位参数。
 * 2. **sentinel**：带一个必定非法的值。如果上游接受，说明它不校验该参数，
 *    那么逐档测试的"接受"全是假阳性，判 `non-validating`，不给控制项。
 * 3. **逐档扫描**：只对"被明确拒绝"的档位记为不支持，其余记为支持。
 *
 * `max_tokens: 1` 把每次探测的消耗压到最低。每次探测都是一次真实请求，
 * 会占用额度/并发，因此必须由用户显式授权（与 workbuddy 的
 * `PROBE_CONSENT_FIELD` 同思路），且结果缓存复用。
 *
 * @module dsh-huaweicloud-connect/reasoning
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 逐档扫描的候选值。
 *
 * 顺序无关，但保持稳定便于比对缓存。`none` 在最前：它是"关闭思考"，
 * 与其它档位语义不同，个别模型（glm 系列）会明确拒绝它。
 */
export const EFFORT_CANDIDATES = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 已实测的档位基线（2026-10-18，OfficeAce 网关）。
 *
 * 用途：**首次启动就能给出档位**，不必让用户先跑一遍探测。探测仍然保留，
 * 因为新模型会加进来、老模型的档位也可能变；探测结果优先于此表。
 *
 * 记录依据是 {@link probeModel} 对真实上游跑出来的 `validating` 结论，
 * 与我手工逐档验证的结果一致：
 *
 * - `deepseek-v4.1-flash` — 全 7 档
 * - `glm-5.3` — 只有 low/high/max（该模型始终思考，`none` 被明确拒绝）
 *
 * 刻意**不收录**的两类：
 *
 * - `non-validating`（如 qwen3-32b）：上游接受 `totally_bogus_xyz`、`99999`
 *   这类任意值并返回 200，说明它根本不校验该参数。给它档位只会误导用户，
 *   所以宁可没有。
 * - 探测失败/模型下线（如 deepseek-v4-pro 现在回 404 Invalid model）。
 */
export const VERIFIED_EFFORTS = {
  "deepseek-v4.1-flash": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  "glm-5.3": ["low", "high", "max"],
};

/**
 * pi-ai `thinkingLevelMap` 认识的层级名。
 *
 * pi-ai 的层级集合与上游档位名不完全一致：它有 `off` 但没有 `none`，
 * 有 `minimal`。映射规则见 {@link buildThinkingLevelMap}。
 */
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 上游档位名 → pi-ai 层级名（只用于判断 pi 有没有这一层）。
 *
 * 唯一需要翻译的是 `none` → `off`：上游用 `none` 表示「不思考」，
 * pi-ai 用 `off`。
 */
function toPiLevel(effort) {
  if (effort === "none") return "off";
  return effort;
}

/**
 * pi-ai 层级名 → 上游拼写（`thinkingLevelMap` 的 value 必须是这个）。
 *
 * **`value` 不是 pi 的层级名，是要发给上游的字符串。**
 *
 * 这是踩过的最贵的坑：早期版本写成 `map[level] = level`，于是 `off` 的
 * value 是 `"off"`，pi-ai 原样发出 `reasoning_effort: "off"`；而华为上游只认
 * `none`，于是每一个模型都回 400：
 *
 *   parameter check failed, reasoning_effort must be none or low or medium
 *   or high or xhigh or max
 *
 * 表现是「所有模型都不能用」，而不是「off 这一档不好用」——因为它是
 * `defaultEffort`，每个请求都会带上。
 */
function toWireSpelling(level) {
  if (level === "off") return "none";
  return level;
}

/**
 * 由「上游支持的档位集合」构造 pi-ai 的 `thinkingLevelMap`。
 *
 * 形状：`{ [pi层级]: 上游拼写 | null }`。`null` 表示该层级不可用——
 * pi-ai 要求显式给 `null` 而不是省略，选择器才知道"这一档不支持"。
 *
 * 另一条规则照 `dsh-workbuddy-connect` 的 `reasoningFields`：
 * **`minimal` 永远给 `null`**。pi-ai 认这个层级，但 DSH 的选择器对它的处理
 * 与其它档不同，workbuddy 实测后决定一律不开。
 *
 * @param {string[]} efforts 上游实测支持的档位名（上游拼写）
 * @returns {Record<string, string|null>} pi 层级 → 上游拼写或 null
 */
export function buildThinkingLevelMap(efforts) {
  const supported = new Set(efforts.map(toPiLevel));
  const map = {};
  for (const level of PI_LEVELS) {
    if (level === "minimal" || !supported.has(level)) {
      map[level] = null;
      continue;
    }
    // 必须是上游拼写，不是 pi 层级名 —— 见 toWireSpelling 的说明
    map[level] = toWireSpelling(level);
  }
  return map;
}

/** 缓存文件里的一条记录。 */
function makeRecord(modelId, fingerprint, validation, efforts, account, reason, now = Date.now()) {
  return {
    modelId,
    fingerprint,
    validation,
    efforts: [...efforts],
    ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
    account,
    probedAt: now,
  };
}

/**
 * 模型指纹：参与"这个模型的档位可能变了"判断的字段。
 *
 * 只取真正影响能力声明的字段。名字变了不该触发重探，所以不含 `name`。
 */
export function fingerprintModel(model) {
  return JSON.stringify([
    model.id,
    model.contextWindow ?? null,
    model.maxTokens ?? null,
    model.reasoning === true,
  ]);
}

/**
 * 判断一次尝试的结果类型。
 *
 * 上游的错误形状：HTTP 200 + SSE 里内嵌 `data:{"error":{...}}` 也算失败
 * （OfficeAce 有这个行为，见 `guardPseudoErrorStream`），所以不能只看状态码。
 *
 * @returns {"accept"|"reject-effort"|"unknown"}
 */
export function classifyAttempt(status, head) {
  if (status === 0) return "unknown";
  const text = String(head ?? "");

  // 明确点名 reasoning_effort 的拒绝
  if (/reasoning_effort/i.test(text) && /(invalid|非法|must be|可选值|validation)/i.test(text)) {
    return "reject-effort";
  }
  // 中文模型的能力型拒绝：不点名参数名，只说明"该模型始终思考/不支持关闭"。
  // 实测来自 glm-5.3：「该模型始终思考，不支持关闭思考；请使用 low、high 或 max。」
  // 这类信息同样是"这个档位不被接受"，必须算 reject-effort，否则会被判成 unknown
  // 而让整次探测作废（glm 系列就永远拿不到档位表）。
  if (/(不支持关闭思考|始终思考|不支持的档位|请使用\s*(low|high|max|none|medium|minimal|xhigh))/i.test(text)) {
    return "reject-effort";
  }
  // 限流/并发/鉴权/未知模型等：与档位无关，不能作为能力结论
  if (/rate limit|Too many requests|APIG\.0[34]|AUTH_FAILED|ModelArts\.81101/i.test(text)) return "unknown";
  if (/unknown model|ModelArts\.81102|does not exist/i.test(text)) return "unknown";

  // CodeArts 的并发上限：`TM.00001041 并发会话数已达上限(3个)`。
  //
  // 这是**实测踩过的坑**：CodeArts 客户端开着时会占满 3 个免费并发槽，
  // 探测请求全部被拒。这类拒绝与 reasoning_effort 无关，必须判 unknown。
  // 早期版本没识别它，导致 sentinel 也被「拒绝」→ 误判成 non-validating，
  // 一票否决后 CodeArts 的所有模型永远拿不到档位。
  if (/TM\.\d+|并发会话数已达上限|concurrent session/i.test(text)) return "unknown";

  // 成功：SSE 里出现 choices 或普通 200 无 error
  if (status === 200) {
    // 上游有两套错误形状，**两套都必须认**：
    //
    //   1. `{"error":{"code":...,"message":...}}`（OfficeAce 网关）
    //   2. `{"error_code":"InferHub.4004.200","error_msg":"benefit not found"}`
    //      （CodeArts / 华为 InferHub）
    //
    // 早期只认第 1 种，于是 CodeArts 的 `benefit not found` 落到下面这行被
    // 判成 **accept** —— 结果 baseline 与 sentinel 双双"通过"，整批 CodeArts
    // 模型被写成 `non-validating`（界面上显示"上游不校验该参数"），
    // 而真相是上游对每个请求都在报错。
    //
    // 这是「失败被当成成功」这一类的错，代价最大：它不报错，只是给出
    // 一个看起来合理的错误结论。
    if (/"error"\s*:|"error_code"|"error_msg"/.test(text) && !/choices/.test(text)) return "unknown";
    return "accept";
  }
  return "unknown";
}

/**
 * 从响应头块里抽出上游错误码与消息，供日志与界面说明原因。
 *
 * 认上面那两套形状。抽不到就返回 undefined，不编造。
 *
 * @param {string} head 响应首块（可能是 SSE 行）
 * @returns {{code:string, message:string} | undefined}
 */
export function extractUpstreamError(head) {
  const text = String(head ?? "");
  if (text.length === 0) return undefined;

  // 形状 2：华为 `error_code` / `error_msg`
  const flatCode = text.match(/"error_code"\s*:\s*"([^"]+)"/);
  if (flatCode !== null) {
    const flatMsg = text.match(/"error_msg"\s*:\s*"([^"]+)"/);
    return { code: flatCode[1], message: flatMsg === null ? "" : flatMsg[1] };
  }

  // 形状 1：`"error": { "code": ..., "message": ... }`
  const nestedCode = text.match(/"error"\s*:\s*\{[^}]*?"code"\s*:\s*"([^"]+)"/);
  if (nestedCode !== null) {
    const nestedMsg = text.match(/"error"\s*:\s*\{[^}]*?"message"\s*:\s*"([^"]+)"/);
    return { code: nestedCode[1], message: nestedMsg === null ? "" : nestedMsg[1] };
  }

  return undefined;
}

/**
 * 相邻两次探测请求之间的间隔（毫秒）。
 *
 * **CodeArts 必须给足间隔** —— 实测（2026-10-18）：连发时前 2 个请求成功，
 * 第 3 个起就回 `TM.00001041 并发会话数已达上限(3个)`，等约 20 秒才恢复。
 * 它的「3 个并发」是**服务端按会话计**，不是按本机进程：每个请求在上游建一个
 * 会话，即使 `max_tokens: 1` 很快结束，会话也要等上游超时才回收。
 *
 * 所以默认给 10 秒：单个模型探测 9 个请求 → 约 90 秒；7 个模型约 10 分钟。
 * 慢，但不会把槽位撞满导致后续全部判 unknown。
 *
 * OfficeAce 的限流是 1 次/秒（`ModelArts.81101`），2.5 秒就够——但它只 1 个
 * 槽位，撞了也只是这一个模型失败，不影响别的。保守起见两端都用同一间隔。
 */
export const PROBE_REQUEST_INTERVAL_MS = 10_000;

/**
 * 探测一个模型支持的档位。
 *
 * @param {object} options
 * @param {(effort: string|undefined, signal: AbortSignal) => Promise<{status:number, head:string}>} options.send
 * @param {string[]} [options.candidates]
 * @param {number} [options.timeoutMs]
 * @param {() => string} [options.sentinel] 生成必定非法的档位值
 * @param {number} [options.intervalMs] 相邻请求间隔；传 0 可关闭（仅测试用）
 * @returns {Promise<{validation:string, efforts:string[], requests:number, reason?:string}>}
 */
export async function probeModel(options) {
  const candidates = options.candidates ?? EFFORT_CANDIDATES;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? PROBE_REQUEST_INTERVAL_MS;
  const sentinel = options.sentinel ?? (() => `probe_sentinel_${Math.random().toString(36).slice(2, 14)}`);
  let requests = 0;

  const attempt = async (effort) => {
    requests += 1;
    // 第一个请求不等，之后每个请求前都等 intervalMs
    if (intervalMs > 0 && requests > 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await options.send(effort, controller.signal);
    } catch (error) {
      return { status: 0, head: `transport: ${String(error)}` };
    } finally {
      clearTimeout(timer);
    }
  };

  // 1. baseline：不带参数必须成功，否则整次探测无法归因
  const baseline = await attempt(undefined);
  if (classifyAttempt(baseline.status, baseline.head) !== "accept") {
    return { validation: "unknown", efforts: [], requests, reason: failureReason("baseline", baseline) };
  }

  // 2. sentinel：上游必须拒绝它，否则说明该参数不被校验
  const sentinelAttempt = await attempt(sentinel());
  const sentinelClass = classifyAttempt(sentinelAttempt.status, sentinelAttempt.head);
  if (sentinelClass === "accept") {
    return { validation: "non-validating", efforts: [], requests };
  }
  if (sentinelClass !== "reject-effort") {
    return { validation: "unknown", efforts: [], requests, reason: failureReason("sentinel", sentinelAttempt) };
  }

  // 3. 逐档扫描
  const accepted = [];
  for (const effort of candidates) {
    const result = await attempt(effort);
    const kind = classifyAttempt(result.status, result.head);
    if (kind === "accept") {
      accepted.push(effort);
      continue;
    }
    if (kind === "reject-effort") continue;
    // 限流等外部干扰：本次结论不可靠，整体判 unknown，不要写半截结果
    return { validation: "unknown", efforts: [], requests, reason: failureReason(`level ${effort}`, result) };
  }

  return { validation: "validating", efforts: accepted, requests };
}

/**
 * 把一次失败尝试描述成可读原因，供日志与界面说明"为什么测不出"。
 *
 * 带上游错误码很关键：只说「baseline 200」看不出问题，而
 * 「baseline 200 InferHub.4004.200 benefit not found」直接指向权益问题。
 *
 * @param {string} stage 哪一步失败（baseline / sentinel / level low …）
 * @param {{status:number, head:string}} attempt
 */
function failureReason(stage, attempt) {
  const upstream = extractUpstreamError(attempt.head);
  if (upstream === undefined) return `${stage} ${attempt.status}`;
  const detail = upstream.message.length > 0 ? ` ${upstream.message}` : "";
  return `${stage} ${attempt.status} ${upstream.code}${detail}`;
}

// ── 缓存 ───────────────────────────────────────────────────────────────

/**
 * 探测结果缓存的格式版本。
 *
 * **改判定逻辑时必须提升它**，否则旧的误判会一直留在缓存里。
 *
 * 这是踩过的坑：v0.7.1 把 CodeArts 的并发上限错误（`TM.00001041`）误判成
 * `non-validating` 并写入缓存；v0.7.2 修好了判定逻辑，但缓存指纹没变，
 * 新代码读到旧记录就认为「已探测」而跳过——误判永久生效。
 * 提升版本号后，旧缓存整体作废，全部重探。
 *
 * 版本历史：
 * - 1：初版
 * - 2：识别 CodeArts 并发上限（TM.*）为 unknown
 * - 3：识别华为 `error_code`/`error_msg` 形状的错误体。
 *      v2 只认 `"error":{...}`，于是 CodeArts 的
 *      `InferHub.4004.200 benefit not found` 被判成成功，导致整批模型被
 *      写成 `non-validating`（界面显示"上游不校验该参数"）—— 错的结论。
 */
const PROBE_CACHE_VERSION = 3;

/**
 * 探测结果的本地缓存。
 *
 * 按产品 + 账号分桶：同一台机器上换账号登录，档位可能不同（订阅等级不同），
 * 所以不能只按模型 id 存。
 *
 * 写入用"写临时文件 + rename"保证原子性：探测可能被中断，半截文件会让下次
 * 启动读到坏 JSON。
 */
export function createProbeStore({ file }) {
  /** @type {{version:number, buckets:Record<string, Record<string, object>>}} */
  let doc = { version: PROBE_CACHE_VERSION, buckets: {} };

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    // 版本不匹配 → 整体作废。判定逻辑变了，旧结论不可信。
    if (parsed?.version === PROBE_CACHE_VERSION && typeof parsed.buckets === "object" && parsed.buckets !== null) {
      doc = parsed;
    }
  } catch {
    /* 文件不存在或坏了：从空开始，下一次写入会覆盖 */
  }

  const bucketOf = (product, account) => `${product}::${account ?? "anonymous"}`;

  return {
    /** 读一条记录；指纹不匹配视为没有（模型描述变了要重探）。 */
    get(product, account, model) {
      const bucket = doc.buckets[bucketOf(product, account)];
      if (bucket === undefined) return undefined;
      const record = bucket[model.id];
      if (record === undefined) return undefined;
      if (record.fingerprint !== fingerprintModel(model)) return undefined;
      return record;
    },

    /** 写一条记录并落盘。`reason` 用于界面说明"为什么测不出"，可省略。 */
    set(product, account, model, validation, efforts, reason) {
      const key = bucketOf(product, account);
      if (doc.buckets[key] === undefined) doc.buckets[key] = {};
      doc.buckets[key][model.id] = makeRecord(
        model.id,
        fingerprintModel(model),
        validation,
        efforts,
        account,
        reason,
      );
      persist();
      return doc.buckets[key][model.id];
    },

    /** 整个桶的快照，给状态文档用。 */
    describe(product, account) {
      const bucket = doc.buckets[bucketOf(product, account)] ?? {};
      const entries = Object.values(bucket).map((record) => ({
        modelId: record.modelId,
        validation: record.validation,
        efforts: [...record.efforts],
        ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
        probedAt: record.probedAt,
      }));
      return { probed: entries.length, entries };
    },

    /** 清空某产品（换账号时用）。 */
    clear(product) {
      for (const key of Object.keys(doc.buckets)) {
        if (key.startsWith(`${product}::`)) delete doc.buckets[key];
      }
      persist();
    },
  };

  function persist() {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(doc, null, 2), "utf8");
      renameSync(temp, file);
    } catch {
      /* 写缓存失败不影响功能，下次重探即可 */
    }
  }
}

/**
 * 从缓存/声明解析一个模型的 reasoning 字段。
 *
 * 优先级（与 workbuddy 一致）：
 * 1. 上游目录**声明**了 supportedEfforts → 直接用，永远优先于观测
 * 2. 缓存里 `validating` 的观测结果 → 用观测到的档位
 * 3. 都没有 → 不给控制项（宁可没有，也不要给假的）
 *
 * `non-validating` 刻意不产生控制项：上游接受任何值，逐档"接受"全是假阳性。
 */
export function resolveReasoning(model, observed) {
  if (model.reasoning !== true) return { reasoning: false };

  const declared = Array.isArray(model.supportedEfforts) ? model.supportedEfforts : undefined;
  if (declared !== undefined && declared.length > 0) {
    return { reasoning: true, thinkingLevelMap: buildThinkingLevelMap(declared) };
  }

  // 本地探测结果优先于内置基线：探测是针对当前账号、当前上游的实测
  if (observed?.validation === "validating" && observed.efforts.length > 0) {
    return { reasoning: true, thinkingLevelMap: buildThinkingLevelMap(observed.efforts) };
  }
  // non-validating 观测必须压过基线：上游不校验参数时，基线的档位也不可信
  if (observed?.validation === "non-validating") {
    return { reasoning: false };
  }

  // 没探测过就用内置基线，让首次启动也有档位可调
  const verified = VERIFIED_EFFORTS[model.id];
  if (Array.isArray(verified) && verified.length > 0) {
    return { reasoning: true, thinkingLevelMap: buildThinkingLevelMap(verified) };
  }

  return { reasoning: false };
}
