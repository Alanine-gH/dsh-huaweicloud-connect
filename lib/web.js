/**
 * Host 侧同源 Web 路由：给插件设置卡片提供数据与写操作。
 *
 * 三条路由，形状对齐 dsh-workbuddy-connect 已验证的实现：
 *   GET  /plugins/dsh-huaweicloud-connect/status          只读，状态文档
 *   POST /plugins/dsh-huaweicloud-connect/visibility     写，必须带 probeKey
 *
 * 安全约定（两条都来自 workbuddy 的教训，不要简化）：
 * 1. **所有路由都要过回环闸**：本机任意进程都能打 127.0.0.1，绑定回环不是信任边界。
 * 2. **写路由必须校验进程内下发的 probeKey**，且走 HTTP header 而不是 body ——
 *    DNS-rebinding 防护 ≠ 授权状态变更，回环检查挡不住同机恶意网页。
 *
 * @module dsh-huaweicloud-connect/web
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import { resolveReasoning } from "./reasoning.js";

export const STATUS_PATH = "/plugins/dsh-huaweicloud-connect/status";
export const VISIBILITY_PATH = "/plugins/dsh-huaweicloud-connect/visibility";
export const KEY_PATH = "/plugins/dsh-huaweicloud-connect/key";
export const PROBE_PATH = "/plugins/dsh-huaweicloud-connect/probe";

/** 回环主机名白名单。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** 从 Host 头剥离端口，IPv6 方括号感知。 */
function hostnameOf(hostHeader) {
  const raw = String(hostHeader ?? "").trim().toLowerCase();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end === -1 ? raw : raw.slice(0, end + 1);
  }
  const colon = raw.lastIndexOf(":");
  return colon === -1 ? raw : raw.slice(0, colon);
}

/** Origin 也必须是回环（浏览器发起的请求会带）。 */
function isLoopbackOrigin(originHeader) {
  const raw = String(originHeader ?? "").trim();
  if (raw.length === 0) return true; // 非浏览器调用方不带 Origin
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** 定时安全比较，避免按字节提前返回泄露信息。 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 一条请求是否来自本机界面。 */
export function isTrustedRequest(req) {
  return LOOPBACK_HOSTS.has(hostnameOf(req.headers?.host)) && isLoopbackOrigin(req.headers?.origin);
}

/** 统一 JSON 响应，带 no-store 防缓存。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/** 读 body，带上限。 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * 组装一个产品的 status 片段。
 *
 * 字段命名刻意与 workbuddy 对齐（status / reasonCode / models[] / visibility），
 * 这样客户端可以共用同一套渲染逻辑，也让用户看到的心智模型一致。
 *
 * 注意 `runtime.snapshot()` 是异步的（要读显隐文件），所以本函数也是异步的。
 *
 * @param {object} runtime
 * @returns {Promise<object>}
 */
async function productStatus(runtime) {
  const { store, catalog, visibility, account } = await runtime.snapshot();
  const { driver } = runtime;
  const base = { id: driver.product, displayName: driver.displayName, providerId: driver.providerId };

  if (!store.signedIn) {
    return { ...base, status: "signed-out", ...(store.reasonCode ? { reasonCode: store.reasonCode } : {}), ...(store.reason ? { reason: store.reason } : {}) };
  }

  // 探测结果按 modelId 建索引，供 resolveReasoning 查"这个模型实测支持哪些档位"
  const probeState = typeof runtime.probeState === "function" ? runtime.probeState() : undefined;
  const observedByModel = new Map((probeState?.entries ?? []).map((entry) => [entry.modelId, entry]));

  const models = catalog.visible.map((model) => {
    const observed = observedByModel.get(model.id);
    const resolved = resolveReasoning(model, observed);
    return {
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: model.input,
      // 始终下发布尔值，不要用「字段缺失」表示未隐藏 —— 客户端要能无脑读
      hidden: model.hidden === true,
      // 推理能力：客户端据此渲染「思考强度」档位
      ...(resolved.reasoning === true
        ? {
            reasoning: true,
            thinkingLevels: Object.entries(resolved.thinkingLevelMap ?? {})
              .filter(([, wire]) => wire !== null)
              .map(([level]) => level),
          }
        : { reasoning: false }),
    };
  });

  return {
    ...base,
    status: "signed-in",
    ...(store.account ? { account: store.account } : {}),
    ...(store.sourcePath ? { sourcePath: store.sourcePath } : {}),
    ...(typeof store.expiresAt === "number" ? { expiresAt: store.expiresAt } : {}),
    ...(store.expired === true ? { expired: true } : {}),
    // 客户端「明细」页要显示接入点
    ...(store.baseUrl ? { baseUrl: store.baseUrl } : {}),
    // 目录来源：live=刚拉的、saved=上次成功的、fallback=内置兜底
    catalogSource: catalog.source,
    // 客户端「状态」页显示「模型列表更新于 …」
    ...(typeof catalog.fetchedAt === "number" ? { catalogFetchedAt: catalog.fetchedAt } : {}),
    ...(catalog.error ? { catalogError: catalog.error } : {}),
    modelCount: catalog.total,
    ...(catalog.hiddenCount > 0 ? { hiddenCount: catalog.hiddenCount } : {}),
    models,
    visibility,
    ...(account === undefined ? {} : { visibilityAccount: account }),
    // 探测进度：客户端「推理档位」页显示已探测多少、结果如何
    ...(probeState === undefined ? {} : { probeState }),
  };
}

/**
 * GET /status 的 handler。
 * @param {object} deps
 * @param {() => Array<object>} deps.runtimes 已启动的运行时
 * @param {() => string} [deps.probeKey] 写路由用的进程内 key
 * @param {string} [deps.version]
 */
export function createStatusHandler(deps) {
  return async (req, res) => {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { error: "request-not-trusted" });
      return;
    }
    try {
      const runtimes = deps.runtimes();
      // 逐个 await：任何一个产品取快照失败都不能让整份文档失败
      const products = [];
      for (const runtime of runtimes) {
        try {
          products.push(await productStatus(runtime));
        } catch (error) {
          products.push({
            id: runtime.driver.product,
            displayName: runtime.driver.displayName,
            providerId: runtime.driver.providerId,
            status: "error",
            reason: String(error?.message ?? error),
            reasonCode: "SNAPSHOT_FAILED",
          });
        }
      }
      sendJson(res, 200, {
        version: deps.version ?? "0.1.0",
        products,
        // 只告诉客户端「写路由可用」，key 本身走 /key 端点取，不进 body。
        // 注意 deps.probeKey 是**函数**，判断存在性而不是比较 undefined。
        ...(typeof deps.probeKey === "function" ? { hasProbeKey: true } : {}),
      });
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  };
}

/**
 * POST /visibility 的 handler：写模型显隐。
 *
 * 请求头必须带 `x-huaweicloud-connect-key`（值取自 status 响应里描述的进程内 key）。
 * 之所以走 header：body 会被 DNS-rebinding 场景下的伪造页面直接构造，header 不行。
 */
export function createVisibilityHandler(deps) {
  return async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { error: "request-not-trusted" });
      return;
    }

    const expected = deps.probeKey();
    const provided = String(req.headers["x-huaweicloud-connect-key"] ?? "");
    if (expected === undefined || expected.length === 0 || !safeEqual(expected, provided)) {
      sendJson(res, 401, { error: "invalid-key" });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "invalid-json" });
      return;
    }

    const { product, modelId, visible, models, all } = payload ?? {};
    if (typeof product !== "string" || product.length === 0) {
      sendJson(res, 400, { error: "missing-product" });
      return;
    }
    const runtime = deps.runtimes().find((row) => row.driver.product === product);
    if (runtime === undefined) {
      sendJson(res, 404, { error: "unknown-product" });
      return;
    }

    try {
      const account = runtime.account();
      const hidden =
        all !== undefined
          ? await runtime.visibility.replace(account, Array.isArray(models) ? models : [], all === true)
          : await runtime.visibility.set(account, String(modelId), visible !== false);

      // 立刻让模型选择器生效
      runtime.invalidate();
      sendJson(res, 200, { product, hidden });
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  };
}

/**
 * POST /probe 的 handler：探测某模型支持的推理档位。
 *
 * **会发真实请求**（每次 1 个 token，但会计入并发与额度），所以：
 * - 必须带写 key（同 /visibility 的 header 校验）
 * - body 里必须显式 `consent: true`，否则 400 —— 与 workbuddy 的
 *   `PROBE_CONSENT_FIELD` 同思路，不让界面「顺手」消耗用户额度
 */
export function createProbeHandler(deps) {
  return async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { error: "request-not-trusted" });
      return;
    }
    const expected = deps.probeKey();
    const provided = String(req.headers["x-huaweicloud-connect-key"] ?? "");
    if (expected === undefined || expected.length === 0 || !safeEqual(expected, provided)) {
      sendJson(res, 401, { error: "invalid-key" });
      return;
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "invalid-json" });
      return;
    }
    if (body?.consent !== true) {
      sendJson(res, 400, {
        error: "consent-required",
        message: "探测会发送真实请求，请显式传 consent: true",
      });
      return;
    }

    const product = String(body.product ?? "");
    const modelId = String(body.modelId ?? "");
    const runtime = deps.runtimes().find((row) => row.driver.product === product);
    if (runtime === undefined) {
      sendJson(res, 404, { error: "unknown-product" });
      return;
    }
    if (typeof runtime.probeReasoning !== "function") {
      sendJson(res, 501, { error: "probe-unsupported" });
      return;
    }

    try {
      const result = await runtime.probeReasoning(modelId);
      sendJson(res, 200, { product, modelId, ...result });
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  };
}

/**
 * GET /key 的 handler：把进程内写路由 key 以 **纯文本** 下发。
 *
 * 为什么单独一条路由而不是塞进 status 的 body：
 * status 文档会被日志、devtools、页面源码看到，写 key 不该走那条路。
 * 单独端点返回 text/plain，客户端只读不解析，暴露面最小。
 * 它仍然要过回环闸——否则同机任意进程都能拿到写权限。
 */
export function createKeyHandler(deps) {
  return async (req, res) => {
    const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
    if (req.method !== "GET") {
      sendText(res, 405, "method not allowed", headers);
      return;
    }
    if (!isTrustedRequest(req)) {
      sendText(res, 403, "request-not-trusted", headers);
      return;
    }
    sendText(res, 200, deps.probeKey(), headers);
  };
}

/** 纯文本响应。与 sendJson 分开，避免为了一个字符串去 JSON.stringify。 */
function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

/** 生成进程内写路由 key。每次 Host 启动重新生成，页面刷新即失效。 */
export function createProbeKey() {
  const key = randomBytes(24).toString("base64url");
  return () => key;
}

/**
 * 把路由挂到 webServer 上。
 * @param {object} ctx 必须是已注入 webServer 的上下文（用 ctx.inject(["webServer"], ...)）
 * @param {object} deps
 */
export function registerWebRoutes(ctx, deps) {
  const probeKey = createProbeKey();

  ctx.effect(() => {
    const disposeStatus = ctx.webServer.register({
      kind: "exact",
      path: STATUS_PATH,
      handler: createStatusHandler({ ...deps, probeKey }),
    });
    const disposeVisibility = ctx.webServer.register({
      kind: "exact",
      path: VISIBILITY_PATH,
      handler: createVisibilityHandler({ ...deps, probeKey }),
    });
    const disposeKey = ctx.webServer.register({
      kind: "exact",
      path: KEY_PATH,
      handler: createKeyHandler({ ...deps, probeKey }),
    });
    const disposeProbe = ctx.webServer.register({
      kind: "exact",
      path: PROBE_PATH,
      handler: createProbeHandler({ ...deps, probeKey }),
    });
    return () => {
      disposeStatus();
      disposeVisibility();
      disposeKey();
      disposeProbe();
    };
  }, "dsh-huaweicloud-connect: Web routes");

  return probeKey;
}
