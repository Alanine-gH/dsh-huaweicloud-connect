/**
 * dsh-huaweicloud-connect · Host 半边。
 *
 * 三段式（沿用 dsh-workbuddy-connect 已验证的结构）：
 *
 *   PiAiAdapter(pi-ai)  ↔  本机回环 shim（OpenAI 兼容 + 每进程随机 Bearer）
 *                       ↔  华为云私有 HTTP（CodeArts 走 AK/SK 签名，OfficeAce 走 Basic）
 *
 * 厂商差异全部收敛在 drivers/ 里，pi-ai 那一侧只看见一个干净的 OpenAI endpoint。
 *
 * @module dsh-huaweicloud-connect
 */

import z from "@deepseek-ai/schemastery";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { join } from "node:path";

import { createShim } from "./shim.js";
import { createCredentialStore, CredentialError, dshHome } from "./credentials.js";
import { createVisibilityStore } from "./visibility.js";
import { registerWebRoutes } from "./web.js";
import { createProbeStore, probeModel, resolveReasoning } from "./reasoning.js";

import * as codearts from "./drivers/codearts.js";
import * as officeace from "./drivers/officeace.js";

/** Cordis 插件名，必须与 cordis.patch.yml 里的 id 一致。 */
export const name = "llm-huaweicloud";

/** 硬依赖：llm 服务就绪后才 apply。 */
export const inject = ["llm"];

/** 插件版本，供 status 文档下发。 */
/**
 * 插件版本，供 status 文档下发。
 *
 * 从 package.json 读，不再写死常量 —— 之前手改版本号时漏了这里，
 * status 文档一直报 0.1.0，排查时把人带偏了。
 */
export const VERSION = await (async () => {
  try {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    // lib/ 的上一级就是包根
    const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** 配置面（0.2.x 用 Config + Settings slot，不用已移除的 settings.installSection）。 */
export const Config = z.object({
  enableCodeArts: z.boolean().default(true).description("接入华为云 CodeArts（码道）"),
  enableOfficeAce: z.boolean().default(true).description("接入华为云 OfficeAce（果办）"),
  authFileCodeArts: z.string().default("").description("CodeArts 凭据库路径（留空自动探测 state.vscdb）"),
  authFileOfficeAce: z.string().default("").description("OfficeAce 凭据文件路径（留空自动探测 models.json）"),
  pollIntervalSeconds: z.number().default(30).description("登录态轮询间隔（秒）"),
});

const STREAM_IDLE_TIMEOUT_MS = 300_000;

/** 图片预算档（profile 上必需的三件套）。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20 * 1024 * 1024,
  requestImagePixelBudget: 4 * 1024 * 1024,
  requestImageMaxBytes: 1024 * 1024,
};

/** pi-ai 的 auth 面：本 provider 不用存量凭据（token 来自 shim），全部回答「没有」。 */
const INERT_AUTH = {
  credentials: {
    async read() {
      return undefined;
    },
    async list() {
      return [];
    },
    async modify() {
      return undefined;
    },
  },
};

/** 订阅/积分制，单价无从得知，如实报 0，不编造。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * 自动探测相邻两个模型之间的间隔。
 *
 * 上游限流是 1 次/秒，而单个模型探测要发 9 个请求（baseline + sentinel + 7 档）。
 * 留 2.5 秒确保不撞限流——撞了会判 unknown，白烧额度还得重测。
 */
const AUTO_PROBE_INTERVAL_MS = 2500;

/**
 * 连续多少个模型探测失败就暂停后台探测。
 *
 * 单个模型探测失败是正常的（模型下线、上游抖动），但连续失败说明是
 * 系统性问题——CodeArts 并发占满、凭据过期、上游不可用。继续跑只是
 * 白烧请求，还会拖慢启动后的前几分钟。
 */
const AUTO_PROBE_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 模型描述：把驱动器给的模型行翻成 pi-ai descriptor。
 *
 * 注意 `baseUrl` 每次重建——shim 端口在启动时才确定，缓存住会拿到未监听的地址。
 *
 * `reasoning` / `thinkingLevelMap` 由 {@link resolveReasoning} 决定：
 * 上游并非所有模型都支持 `reasoning_effort`，且支持的档位逐模型不同（实测
 * glm-5.3 只有 low/high/max，deepseek-v4-pro 完全不支持）。写死 true 会让
 * 选择器给出上游会拒绝的档位，写死 false 则所有模型都没得选——所以必须
 * 按"声明 → 本地探测结果 → 不给"的优先级解析。
 */
function toPiModel(model, baseUrl, providerId, observed) {
  const reasoning = resolveReasoning(model, observed);
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    input: Array.isArray(model.input) && model.input.includes("image") ? ["text", "image"] : ["text"],
    reasoning: reasoning.reasoning,
    ...(reasoning.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: reasoning.thinkingLevelMap }),
    cost: NO_COST,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: { maxTokensField: "max_tokens" },
  };
}

/** 产品描述表。两个产品各自独立 provider id、独立 shim、独立凭据 store。 */
function products() {
  return [
    {
      driver: codearts,
      providerId: codearts.providerId,
      displayName: codearts.displayName,
      configKey: "enableCodeArts",
      authFileKey: "authFileCodeArts",
    },
    {
      driver: officeace,
      providerId: officeace.providerId,
      displayName: officeace.displayName,
      configKey: "enableOfficeAce",
      authFileKey: "authFileOfficeAce",
    },
  ];
}

/** 凭据是否「现在就能用」：有过期字段且已过期 → 不可用。 */
function usableNow(credential) {
  if (credential === undefined) return false;
  const expiresAt = credential.expiresAt;
  return !(typeof expiresAt === "number" && expiresAt <= Date.now());
}

/**
 * 起一个产品的完整链路：凭据 store → 目录 → shim → adapter → 注册。
 *
 * @returns {Promise<{ok: boolean, sync?: () => Promise<void>, close?: () => void, status?: () => object}>}
 */
async function startProduct(ctx, product, config) {
  const { driver, providerId, displayName } = product;
  const { logger } = ctx;

  const resolveExplicitPath = async () => {
    const value = config?.[product.authFileKey];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };

  const store = createCredentialStore({
    product: driver.product,
    displayName,
    envOverride: driver.envOverride,
    candidates: driver.candidates,
    parseAuth: driver.parseAuth,
    readCredential: driver.readCredential,
    resolveExplicitPath,
    // 华为云两产品都刻意不做刷新：refresh_token 轮换会把用户 App 登出
    refresh: undefined,
    // 不落 at-rest 副本：凭据本来就在 App 的明文库里，多存一份只是扩大暴露面
    persistCopy: false,
    logger,
  });

  /** 当前目录快照（为空时分组隐藏）。 */
  let models = [];
  let visible = false;
  let lastHint;
  /**
   * 自动探测是否正在跑。
   *
   * 不用"跑过一次就永久跳过"的标记：探测可能中途因并发占满而暂停，
   * 下次 sync（每 30 秒）应该能续上。用 running 标志防止并发重入即可。
   */
  let autoProbeRunning = false;
  /** 本产品是否已关闭；后台探测靠它及时停下。 */
  let closed = false;

  const catalog = {
    current: () => models,
    set(next) {
      models = Array.isArray(next) ? next : [];
    },
  };

  /**
   * 推理档位探测结果的本地缓存。
   *
   * 按产品分文件、按账号分桶：换账号登录时订阅等级可能不同，档位能力也可能
   * 不同，所以缓存键里必须带账号。
   */  const probeStore = createProbeStore({
    file: join(dshHome(), ".huaweicloud-connect", `reasoning-probes-${driver.product}.json`),
  });

  /** 当前账号标识；凭据未就绪时用 undefined，缓存层会落到 anonymous 桶。 */
  let accountKey = store.status().account;

  /**
   * 造一个探测用的 send 函数。
   *
   * 抽出来是因为自动探测与手动探测要用同一套逻辑——两处实现分叉过一次，
   * 自动那条忘了处理 UpstreamError，导致全部判 unknown。
   */
  const makeProbeSender = (credential, modelId) => async (effort, signal) => {
    const body = {
      model: modelId,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    };
    if (effort !== undefined) body.reasoning_effort = effort;
    try {
      const response = await driver.chat(credential, body, { signal });
      // driver.chat 返回的 stream 是**异步可迭代**（不是 WebStream），
      // 只能 for await 取首块。用 getReader() 会拿到 undefined。
      let head = "";
      for await (const chunk of response.stream) {
        head = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        break; // 只要第一块：错误信息一定在开头
      }
      return { status: response.status, head };
    } catch (error) {
      // 关键：上游对非法 reasoning_effort 回的是 **HTTP 400 + 错误体**，
      // driver.chat 会把它抛成 UpstreamError。这不是传输失败，必须把
      // 状态码与 body 交回 classifyAttempt，否则永远判 unknown。
      const status = typeof error?.status === "number" ? error.status : 0;
      const detail = String(error?.body ?? error?.message ?? error);
      return { status, head: detail };
    }
  };

  /**
   * 探测单个模型并落缓存。
   * @returns {Promise<{validation:string, efforts:string[], requests:number} | {unavailable:string}>}
   */
  const probeOne = async (credential, model) => {
    const outcome = await probeModel({ send: makeProbeSender(credential, model.id) });
    if (outcome.validation === "unknown") return { unavailable: outcome.reason ?? "probe inconclusive" };
    probeStore.set(driver.product, accountKey, model, outcome.validation, outcome.efforts);
    return { validation: outcome.validation, efforts: outcome.efforts, requests: outcome.requests };
  };

  /**
   * 对单个模型做档位探测（供设置界面手动触发）。
   */
  const probeReasoning = async (modelId) => {
    const model = catalog.current().find((row) => row.id === modelId);
    if (model === undefined) return { state: "unavailable", reason: `unknown model: ${modelId}` };

    const credential = await store.resolve({ allowExpired: true });
    if (credential === undefined) return { state: "unavailable", reason: "no credential" };

    const result = await probeOne(credential, model);
    if (result.unavailable !== undefined) {
      return { state: "unavailable", reason: result.unavailable };
    }
    invalidate();
    return { state: "ok", validation: result.validation, efforts: result.efforts, requests: result.requests };
  };

  /**
   * 后台把「还没探测过」的模型补测一轮。
   *
   * 为什么需要：内置基线只覆盖少数已验证模型，其余十几个模型如果不测，
   * 界面上就全归到「未探测」，用户会误以为它们都不支持思考强度。
   *
   * 约束：
   * - **串行 + 间隔**：上游限流是 1 次/秒，并行会全部撞 429 而判 unknown
   * - **只测未探测的**：有缓存就不重测，避免每次启动都烧额度
   * - **不阻塞启动**：放在 sync 之后的后台任务里，失败只记日志
   * - **遇到系统性故障就停**：连续 3 个模型都探测失败说明上游不可用
   *   （并发占满、凭据过期等），继续跑只是白烧请求
   * - **可续跑**：中途暂停后，下一次 sync 会接着测剩下的
   */
  const autoProbePending = async () => {
    if (autoProbeRunning) return;
    autoProbeRunning = true;

    try {
      const credential = await store.resolve({ allowExpired: true }).catch(() => undefined);
      if (credential === undefined) {
        logger?.info?.(`dsh-huaweicloud-connect: ${displayName} 无凭据，跳过后台探测`);
        return;
      }

      const pending = catalog
        .current()
        .filter((model) => model.reasoning === true)
        .filter((model) => probeStore.get(driver.product, accountKey, model) === undefined);
      if (pending.length === 0) {
        logger?.info?.(`dsh-huaweicloud-connect: ${displayName} 档位已全部探测过，跳过`);
        return;
      }

      logger?.info?.(`dsh-huaweicloud-connect: ${displayName} 开始后台探测 ${pending.length} 个模型的推理档位`);
      let probed = 0;
      let failed = 0;

      for (const model of pending) {
        if (closed) return;
        try {
          const result = await probeOne(credential, model);
          if (result.unavailable === undefined) {
            probed += 1;
            failed = 0;
            invalidate();
            logger?.info?.(`dsh-huaweicloud-connect: ${displayName} ${model.id} → ${result.validation} (${result.efforts.join(",") || "无档位"})`);
          } else {
            failed += 1;
            logger?.warn?.(`dsh-huaweicloud-connect: ${displayName} ${model.id} 探测未得结论：${result.unavailable}`);
            // 连续失败说明是系统性问题（并发占满/凭据失效/上游挂了），不是单个模型的特性
            if (failed >= AUTO_PROBE_MAX_CONSECUTIVE_FAILURES) {
              logger?.warn?.(`dsh-huaweicloud-connect: ${displayName} 连续 ${failed} 个模型探测失败，暂停后台探测`);
              return;
            }
          }
        } catch (error) {
          failed += 1;
          logger?.warn?.(`dsh-huaweicloud-connect: ${displayName} 探测 ${model.id} 异常`, error);
          if (failed >= AUTO_PROBE_MAX_CONSECUTIVE_FAILURES) return;
        }
        // 上游限流 1 次/秒；每次探测本身要发 9 个请求，留足间隔
        await new Promise((resolve) => setTimeout(resolve, AUTO_PROBE_INTERVAL_MS));
      }
      logger?.info?.(`dsh-huaweicloud-connect: ${displayName} 探测结束，${probed} 个拿到档位，${failed} 个未得结论`);
    } finally {
      autoProbeRunning = false;
    }
  };

  const shim = createShim({
    logger,
    listModels: async () =>
      catalog.current().map((model) => ({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: providerId,
      })),
    normalizeOptions: () => ({
      // pi-ai 会发 developer 角色与对象形态 tool_choice，两类上游普遍不认
      developerToSystem: true,
      stringToolChoice: true,
    }),
    dispatch: async ({ body, signal }) => {
      let credential;
      try {
        credential = await store.resolve();
      } catch (error) {
        const message = error instanceof CredentialError ? error.message : String(error?.message ?? error);
        throw Object.assign(new Error(message), { status: 401, reasonCode: error?.code ?? "SIGNED_OUT" });
      }
      if (credential === undefined) {
        throw Object.assign(new Error(`${displayName} 尚未登录；请先打开 ${displayName} 客户端并登录`), {
          status: 401,
          reasonCode: "SIGNED_OUT",
        });
      }
      return driver.chat(credential, body, { signal });
    },
  });

  // 模型 baseUrl 带 shim 的临时端口，必须先等端口就绪
  await shim.ready;

  const visibility = createVisibilityStore({ product: driver.product, logger: ctx.logger });

  /** 目录来源：live=刚拉的、saved=上次成功的、fallback=内置兜底 */
  let catalogSource = "fallback";
  let catalogError;
  let catalogFetchedAtMs;

  const buildModels = () =>
    catalog
      .current()
      .filter((model) => model.hidden !== true)
      .map((model) =>
        toPiModel(model, `${shim.baseUrl()}/v1`, providerId, probeStore?.get(product, accountKey, model)));

  const piProvider = {
    ...createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: `${displayName} 登录态`,
          async resolve({ credential }) {
            const key = credential?.key;
            return typeof key === "string" && key.length > 0 ? { auth: { apiKey: key }, source: displayName } : undefined;
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };

  const profile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, `dsh-huaweicloud-connect ${driver.product} retryPolicy`),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider,
  };

  let profiles = new Map([[providerId, profile]]);

  /** 目录为空时返回空列表，DSH 因此隐藏整个分组。 */
  class ProductAdapter extends PiAiAdapter {
    async listModels(p) {
      if (!visible) return [];
      return super.listModels(p);
    }
  }

  const adapter = new ProductAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => shim.token(),
  });

  const invalidate = () => {
    profiles = new Map([[providerId, profile]]);
    ctx.emit("llm/adapters-updated");
  };

  const release = ctx.llm.registerAdapter([providerId], adapter);
  ctx.effect(() => () => {
    try {
      release();
    } finally {
      shim.close();
    }
  });

  /** 刷新目录与可见性。 */
  const sync = async () => {
    let credential;
    try {
      credential = await store.resolve({ allowExpired: true });
    } catch (error) {
      // 凭据存在但读不了：隐藏分组，并把原因留给 status()/日志
      logger?.warn?.(`dsh-huaweicloud-connect: ${displayName} 登录态读取失败`, error);
      lastHint = String(error?.message ?? error);
      if (visible) {
        visible = false;
        catalog.set([]);
        invalidate();
      }
      return;
    }

    if (credential === undefined) {
      lastHint = `未找到 ${displayName} 登录态`;
      if (visible) {
        visible = false;
        catalog.set([]);
        invalidate();
      }
      return;
    }

    if (!usableNow(credential)) {
      lastHint = `${displayName} 登录态已过期；请打开 ${displayName} 客户端让它自动续期`;
      if (visible) {
        visible = false;
        catalog.set([]);
        invalidate();
      }
      return;
    }

    let next;
    try {
      next = await driver.listModels(credential);
    } catch (error) {
      // 目录拉取失败：保留上次已知可用目录，不因为一次网络抖动让分组消失
      lastHint = String(error?.message ?? error);
      catalogError = { code: error?.reasonCode ?? "UPSTREAM_ERROR", message: String(error?.message ?? error) };
      logger?.warn?.(`dsh-huaweicloud-connect: ${displayName} 模型目录拉取失败`, error);
      return;
    }

    if (!Array.isArray(next) || next.length === 0) {
      lastHint = `${displayName} 模型目录为空`;
      return;
    }

    // 应用显隐：只影响选择器可见性，不影响正在进行的会话
    const account = store.accountKey();
    const hidden = new Set(await visibility.hidden(account));
    const decorated = next.map((model) => ({ ...model, hidden: hidden.has(model.id) }));

    const changed =
      !visible ||
      decorated.length !== models.length ||
      decorated.some((model, index) => model.id !== models[index]?.id || model.hidden !== models[index]?.hidden);

    catalog.set(decorated);
    catalogSource = "live";
    catalogError = undefined;
    catalogFetchedAtMs = Date.now();
    lastHint = undefined;
    if (changed) {
      visible = true;
      invalidate();
    }
  };

  return {
    ok: true,
    sync,
    close: () => {
      closed = true;
      shim.close();
    },
    invalidate,
    driver,
    visibility,
    /** 探测单模型的推理档位（会发真实请求，需用户授权后调用）。 */
    probeReasoning,
    /** 后台补测还没探测过的模型（启动后调一次）。 */
    autoProbePending,
    /** 探测结果的缓存快照，给设置界面显示。 */
    probeState: () => probeStore.describe(driver.product, accountKey),

    /** 当前账号标识，供 Web 层按账号分桶。 */
    account: () => store.accountKey(),

    /** status 文档片段。Web 层依赖这个形状，客户端按它渲染。 */
    async snapshot() {
      const status = store.status();
      const account = store.accountKey();
      const hidden = new Set(await visibility.hidden(account));
      const all = models;
      // 接入点要显示在客户端「明细」页，所以必须真的读一次凭据拿 baseUrl
      let endpoint;
      try {
        const live = await store.resolve({ allowExpired: true });
        if (typeof live?.baseUrl === "string") endpoint = live.baseUrl;
      } catch {
        // 读不到就留空，客户端显示「—」。这里不能抛——明细页不该因为读不到凭据就整页崩
      }
      return {
        store: {
          signedIn: status.signedIn === true,
          ...(status.account ? { account: status.account } : {}),
          ...(status.sourcePath ? { sourcePath: status.sourcePath } : {}),
          ...(typeof status.expiresAt === "number" ? { expiresAt: status.expiresAt } : {}),
          ...(typeof status.expiresAt === "number" && status.expiresAt <= Date.now() ? { expired: true } : {}),
          ...(status.lastError ? { reason: status.lastError.message, reasonCode: status.lastError.code } : {}),
          ...(lastHint !== undefined && !status.signedIn ? { reason: lastHint } : {}),
          ...(endpoint === undefined ? {} : { baseUrl: endpoint }),
        },
        catalog: {
          visible: all.map((model) => ({ ...model, hidden: hidden.has(model.id) })),
          total: all.length,
          hiddenCount: all.filter((model) => hidden.has(model.id)).length,
          source: catalogSource,
          ...(catalogFetchedAtMs === undefined ? {} : { fetchedAt: catalogFetchedAtMs }),
          ...(catalogError === undefined ? {} : { error: catalogError }),
        },
        visibility: await visibility.describe(account),
        account,
      };
    },

    /** 诊断用（CLI 用）。 */
    status: () => ({ ...store.status(), visible, modelCount: models.length, hint: lastHint }),
  };
}

/**
 * Cordis 入口。
 * @param {object} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  let stopped = false;
  const started = [];

  const pollIntervalMs = Math.max(15_000, Number(config?.pollIntervalSeconds ?? 30) * 1000);

  // 设置卡片依赖这三条同源路由。**必须在 apply 的同步阶段注册**：
  // ctx.inject 记录「我要等 webServer」，回调要等 slot 声明者就绪才触发；
  // 若放进异步流程里，注入请求会晚于本次 apply 的注册窗口，路由永远挂不上
  // （症状：插件在插件页显示「运行中」，但卡片报 404）。
  ctx.inject(["webServer"], (webCtx) => {
    try {
      registerWebRoutes(webCtx, { runtimes: () => started, version: VERSION });
      ctx.logger.info("dsh-huaweicloud-connect: 设置界面路由已挂载");
    } catch (error) {
      ctx.logger.error("dsh-huaweicloud-connect: 设置界面路由挂载失败", error);
    }
  });

  void (async () => {
    for (const product of products()) {
      if (config?.[product.configKey] === false) {
        ctx.logger.info(`dsh-huaweicloud-connect: ${product.displayName} 已在配置里关闭，跳过`);
        continue;
      }
      try {
        const runtime = await startProduct(ctx, product, config);
        started.push(runtime);
        ctx.logger.info(`dsh-huaweicloud-connect: ${product.displayName} provider 已注册 (${product.providerId})`);
      } catch (error) {
        // 单个产品失败不能拖垮另一个：这里收敛到本产品
        ctx.logger.error(`dsh-huaweicloud-connect: ${product.displayName} provider 注册失败`, error);
      }
    }

    if (stopped) return;
    for (const runtime of started) await runtime.sync();

    // 后台补测还没探测过的模型。
    //
    // 为什么要有这一步：内置基线只覆盖少数已验证模型（deepseek-v4.1-flash、
    // glm-5.3），其余十几个模型不测就会在界面上全归到"未探测"，用户会误以为
    // 它们都不支持思考强度。实测下来 glm-5.1/5.2、kimi-k2.6、DeepSeek-V4-Flash
    // 等其实都能探测。
    //
    // 放在 sync 之后、不 await：探测要跑几十秒，不能拖慢启动。
    void (async () => {
      for (const runtime of started) {
        if (stopped) return;
        try {
          await runtime.autoProbePending?.();
        } catch (error) {
          ctx.logger.warn("dsh-huaweicloud-connect: 后台探测失败", error);
        }
      }
    })();

    const timer = setInterval(() => {
      void (async () => {
        if (stopped) return;
        for (const runtime of started) {
          try {
            await runtime.sync();
          } catch (error) {
            ctx.logger.warn("dsh-huaweicloud-connect: 目录同步失败", error);
          }
        }
      })();
    }, pollIntervalMs);
    timer.unref?.();

    ctx.effect(() => () => {
      stopped = true;
      clearInterval(timer);
      for (const runtime of started) runtime.close?.();
    });
  })().catch((error) => {
    ctx.logger.error("dsh-huaweicloud-connect: 启动失败", error);
  });

  /** 诊断入口：`dsh plugin --profile <p> exec dsh-huaweicloud-connect status` 会用到。 */
  ctx.on?.("dispose", () => {
    stopped = true;
  });

  /** 供测试与 CLI 读取当前运行时列表。 */
  ctx.__huaweicloudRuntimes = started;
}
