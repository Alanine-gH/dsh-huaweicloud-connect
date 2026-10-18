/**
 * dsh-huaweicloud-connect · Web 半边（设置界面）。
 *
 * 契约全部对齐 DSH 0.2.1-rc.2 与 dsh-workbuddy-connect 已验证的实现：
 * - `window.__ModuleLoader__.load({ id, factory })`，id = 包名
 * - 只注册一个 slot：`plugins.bundle.config`，key = 包名
 *   （0.1.6+ 把 `settings.plugin.item` 换成了 Plugins 页的 keyed slot）
 * - 每个贡献都要 guard **两层**：外层 catch 同步抛出，内层 catch 延迟回调抛出。
 *   `slots.inject` 的回调是在 apply() 返回之后才执行的，外层 try/catch 接不住，
 *   漏掉内层会直接触发 DSH 的红色 "Failed to load plugins"。
 *
 * 数据通道：同源 fetch `/plugins/dsh-huaweicloud-connect/status`（只读）
 * 与 `/visibility`（写，需 header 携带进程内 key）。
 *
 * @module dsh-huaweicloud-connect/client
 */

window.__ModuleLoader__.load({
  id: "dsh-huaweicloud-connect",
  factory: (require) => {
    const { useCallback, useEffect, useMemo, useRef, useState } = require("react");
    const { jsx, jsxs, Fragment } = require("react/jsx-runtime");

    // ── 常量：与 Host 半边共享 ────────────────────────────────────────────
    const STATUS_PATH = "/plugins/dsh-huaweicloud-connect/status";
    const VISIBILITY_PATH = "/plugins/dsh-huaweicloud-connect/visibility";
    const KEY_HEADER = "x-huaweicloud-connect-key";
    const BUNDLE_NAME = "dsh-huaweicloud-connect";
    const POLL_INTERVAL_MS = 60_000;

    // ── 文案 ─────────────────────────────────────────────────────────────
    const zh = {
      title: "华为云模型接入",
      intro: "直接使用华为云 CodeArts（码道）与 OfficeAce（果办）客户端里的模型，自动跟随客户端登录状态",
      loading: "正在读取登录状态…",
      refresh: "刷新",
      refreshing: "刷新中…",
      signedOut: "未登录",
      signedOutHint: "请先打开 {app} 客户端并登录一次，本插件会自动跟随",
      signedInAs: "已登录",
      accountLabel: "账号",
      noAccount: "（未提供账号标识）",
      expiresAt: "凭据有效期至",
      expired: "已过期",
      neverExpires: "长期有效",
      catalogHeading: "模型",
      catalogLive: "实时",
      catalogSaved: "上次获取",
      catalogFallback: "内置兜底",
      catalogError: "获取失败：{message}",
      modelCount: "共 {count} 个模型，已隐藏 {hidden} 个",
      visibilityHeading: "在模型选择器中显示",
      showAll: "全选",
      hideAll: "全不选",
      perAccount: "按账号分别记忆显隐",
      contextWindow: "上下文 {size}",
      outputTokens: "输出 {size}",
      supportsImage: "支持图片",
      textOnly: "仅文本",
      expiredHint: "{app} 的登录态已过期，请打开客户端让它自动续期",
      errorBanner: "读取失败：{message}",
      retry: "重试",
      saving: "保存中…",
    };

    const en = {
      title: "Huawei Cloud Models",
      intro: "Use models from the CodeArts and OfficeAce desktop clients, following their sign-in automatically",
      loading: "Loading sign-in status…",
      refresh: "Refresh",
      refreshing: "Refreshing…",
      signedOut: "Not signed in",
      signedOutHint: "Sign in once in the {app} client; this plugin follows it automatically",
      signedInAs: "Signed in",
      accountLabel: "Account",
      noAccount: "(no account identifier)",
      expiresAt: "Credential valid until",
      expired: "expired",
      neverExpires: "no expiry",
      catalogHeading: "Models",
      catalogLive: "live",
      catalogSaved: "cached",
      catalogFallback: "built-in fallback",
      catalogError: "Failed to fetch: {message}",
      modelCount: "{count} models, {hidden} hidden",
      visibilityHeading: "Show in model picker",
      showAll: "Show all",
      hideAll: "Hide all",
      perAccount: "Remember visibility per account",
      contextWindow: "context {size}",
      outputTokens: "output {size}",
      supportsImage: "supports images",
      textOnly: "text only",
      expiredHint: "The {app} credential has expired; open the client so it can renew",
      errorBanner: "Failed to read: {message}",
      retry: "Retry",
      saving: "Saving…",
    };

    // ── 工具 ─────────────────────────────────────────────────────────────
    const NUMBER_FORMAT = new Intl.NumberFormat();

    /** 把 token 数格式化成 200K / 1M 这种可读形式。 */
    function formatTokens(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
      if (value >= 1_000_000) {
        const millions = value / 1_000_000;
        return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
      }
      if (value >= 1000) {
        const thousands = value / 1000;
        return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(0)}K`;
      }
      return NUMBER_FORMAT.format(value);
    }

    /** 剩余时长的人话描述。 */
    function remainingText(expiresAt, now) {
      if (typeof expiresAt !== "number") return null;
      const ms = expiresAt - now;
      if (ms <= 0) return "expired";
      const minutes = Math.floor(ms / 60_000);
      if (minutes < 60) return `${minutes} 分钟`;
      const hours = Math.floor(minutes / 60);
      if (hours < 48) return `${hours} 小时`;
      return `${Math.floor(hours / 24)} 天`;
    }

    // ── 样式 ─────────────────────────────────────────────────────────────
    // 用 CSS-in-JS 内联对象，不依赖全局样式表：插件卡片要和宿主主题一致，
    // 而宿主的 CSS 变量在插件作用域里未必可见，所以用 currentColor + opacity
    // 这类继承来的属性，避免硬编码颜色。
    const cardStyle = {
      display: "flex",
      flexDirection: "column",
      gap: 10,
      padding: 12,
      border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
      borderRadius: 10,
    };
    const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 };
    const buttonStyle = {
      cursor: "pointer",
      padding: "3px 10px",
      borderRadius: 6,
      border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
      background: "transparent",
      color: "inherit",
      font: "inherit",
      opacity: 0.85,
    };
    const listStyle = { display: "flex", flexDirection: "column", gap: 6, listStyle: "none", margin: 0, padding: 0 };
    const pageListStyle = { display: "flex", flexDirection: "column", gap: 12, listStyle: "none", margin: 0, padding: 0 };
    const mutedStyle = { opacity: 0.65, fontSize: "0.9em" };

    // ── 数据获取 ─────────────────────────────────────────────────────────
    /**
     * 拉状态文档。
     *
     * `readSeq` 竞态防护：序号必须在**请求开始时**取，不是响应到达时取。
     * 否则 60s 轮询的慢响应会在手动刷新之后才返回，把新状态覆盖回旧状态。
     * 这个 bug 静默发生、几乎无法复现，是从 workbuddy 学到的。
     */
    function useStatusDocument() {
      const [doc, setDoc] = useState(undefined);
      const [error, setError] = useState(undefined);
      const [refreshing, setRefreshing] = useState(false);
      const seqRef = useRef(0);
      const mountedRef = useRef(true);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      const load = useCallback(async () => {
        const seq = ++seqRef.current;
        setRefreshing(true);
        try {
          const response = await fetch(STATUS_PATH, { headers: { accept: "application/json" } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const next = await response.json();
          if (!mountedRef.current || seq !== seqRef.current) return;
          setDoc(next);
          setError(undefined);
        } catch (cause) {
          if (!mountedRef.current || seq !== seqRef.current) return;
          setError(String(cause?.message ?? cause));
        } finally {
          if (mountedRef.current && seq === seqRef.current) setRefreshing(false);
        }
      }, []);

      useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
        return () => clearInterval(timer);
      }, [load]);

      return { doc, error, refreshing, reload: load };
    }

    /**
     * 写显隐。
     *
     * key 走 HTTP header 而不是 body：DNS-rebinding 场景下伪造页面能自由构造
     * body，但受同源策略约束无法设置自定义 header。
     */
    function useVisibilityWriter(probeKeyProvider) {
      const [pending, setPending] = useState(false);

      const write = useCallback(
        async (product, body) => {
          const key = probeKeyProvider();
          if (typeof key !== "string" || key.length === 0) {
            throw new Error("missing-key");
          }
          setPending(true);
          try {
            const response = await fetch(VISIBILITY_PATH, {
              method: "POST",
              headers: { "content-type": "application/json", [KEY_HEADER]: key },
              body: JSON.stringify({ product, ...body }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
          } finally {
            setPending(false);
          }
        },
        [probeKeyProvider],
      );

      return { write, pending };
    }

    /**
     * 拿写路由的进程内 key。
     *
     * status 响应只带 `hasProbeKey: true`（不把 key 塞进 body），真正的 key 通过
     * 一个专用只读端点取。这里沿用最简方案：Host 把 key 放在一个同名 cookie
     * 不合适（同源页面都能读），所以改为 Host 在 status 响应头下发。
     */
    function useProbeKey() {
      const [key, setKey] = useState(undefined);
      useEffect(() => {
        let cancelled = false;
        void (async () => {
          try {
            const response = await fetch(`${STATUS_PATH}/key`, { headers: { accept: "text/plain" } });
            if (!response.ok) return;
            const text = (await response.text()).trim();
            if (!cancelled && text.length > 0) setKey(text);
          } catch {
            /* 拿不到就只读，写操作会被 401 挡下 */
          }
        })();
        return () => {
          cancelled = true;
        };
      }, []);
      return useCallback(() => key, [key]);
    }

    // ── 组件 ─────────────────────────────────────────────────────────────

    /** 单个模型行：勾选框 + 元信息。 */
    function ModelRow({ model, onToggle, disabled }) {
      const inputId = `hc-model-${model.id}`;
      const supportsImage = Array.isArray(model.input) && model.input.includes("image");
      return jsxs("li", {
        style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
        children: [
          jsxs("label", {
            htmlFor: inputId,
            style: { display: "flex", alignItems: "center", gap: 8, cursor: disabled ? "default" : "pointer" },
            children: [
              jsx("input", {
                id: inputId,
                type: "checkbox",
                checked: model.hidden !== true,
                disabled,
                onChange: (event) => onToggle(model.id, event.target.checked),
              }),
              jsx("span", { children: model.name ?? model.id }),
            ],
          }),
          jsx("span", { style: mutedStyle, children: `${formatTokens(model.contextWindow)} · ${supportsImage ? "🖼" : ""}` }),
        ],
      });
    }

    /** 一个产品（CodeArts 或 OfficeAce）的卡片。 */
    function ProductCard({ product, t, locale, onWrite, writePending }) {
      const now = Date.now();
      const signedIn = product.status === "signed-in";

      const appName = product.displayName ?? product.id;
      const models = Array.isArray(product.models) ? product.models : [];
      const hiddenCount = models.filter((model) => model.hidden === true).length;
      const allVisible = models.length > 0 && hiddenCount === 0;
      const noneVisible = hiddenCount === models.length && models.length > 0;

      const toggle = (modelId, visible) => {
        void onWrite(product.id, { modelId, visible }).catch(() => undefined);
      };

      const setAll = (all) => {
        void onWrite(product.id, { all, models: models.map((model) => model.id) }).catch(() => undefined);
      };

      // 过期优先于「未登录」提示——用户需要知道的是「去开客户端续期」
      const expired = product.expired === true;
      const remaining = signedIn && !expired ? remainingText(product.expiresAt, now) : undefined;

      return jsxs("li", { style: cardStyle, children: [
        jsxs("div", { style: rowStyle, children: [
          jsx("strong", { children: appName }),
          jsx("span", { style: mutedStyle, children: product.providerId ?? product.id }),
        ]}),

        // ── 登录状态 ──
        !signedIn
          ? jsx("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
              jsx("span", { style: { opacity: 0.7 }, children: t("signedOut") }),
              jsx("span", { style: mutedStyle, children: t("signedOutHint", { app: appName }) }),
            )
          : jsx("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
              jsx("div", { style: rowStyle },
                jsx("span", { children: t("signedInAs") }),
                jsx("span", { style: mutedStyle, children: product.account ?? t("noAccount") }),
              ),
              jsx("div", { style: rowStyle },
                jsx("span", { style: mutedStyle, children: t("expiresAt") }),
                jsx("span", {
                  style: mutedStyle,
                  children: expired
                    ? t("expiredHint", { app: appName })
                    : remaining !== undefined
                      ? remaining
                      : t("neverExpires"),
                }),
              ),
            ),

        // ── 目录来源 ──
        signedIn
          ? jsxs("div", { style: mutedStyle, children: [
              `${t("catalogHeading")} · ${
                product.catalogSource === "live"
                  ? t("catalogLive")
                  : product.catalogSource === "saved"
                    ? t("catalogSaved")
                    : t("catalogFallback")
              }`,
              typeof product.modelCount === "number"
                ? ` · ${t("modelCount", { count: product.modelCount, hidden: product.hiddenCount ?? 0 })}`
                : "",
            ]})
          : null,

        product.catalogError
          ? jsx("div", { style: mutedStyle, children: t("catalogError", { message: product.catalogError.message }) })
          : null,

        // ── 模型显隐 ──
        signedIn && models.length > 0
          ? jsx("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
              jsx("div", { style: rowStyle },
                jsx("span", { style: mutedStyle, children: t("visibilityHeading") }),
                jsx("div", { style: { display: "flex", gap: 6 } },
                  jsx("button", {
                    type: "button",
                    style: buttonStyle,
                    disabled: writePending || allVisible,
                    onClick: () => setAll(true),
                    children: t("showAll"),
                  }),
                  jsx("button", {
                    type: "button",
                    style: buttonStyle,
                    disabled: writePending || noneVisible,
                    onClick: () => setAll(false),
                    children: t("hideAll"),
                  }),
                ),
              ),
              jsx("ul", { style: listStyle }, models.map((model) =>
                jsx(ModelRow, { key: model.id, model, onToggle: toggle, disabled: writePending }, model.id),
              )),
            )
          : null,
      ] });
    }

    /**
     * 纯渲染：给定状态文档画出配置页。
     *
     * 刻意与 {@link ConfigPage} 分开：数据获取（fetch + 轮询 + 竞态防护）是一件事，
     * 渲染是另一件。拆开之后渲染分支可以被离线测试直接驱动，不必伪造 fetch 与 hook。
     *
     * @param {object} props
     * @param {object|undefined} props.doc 状态文档；undefined = 还没加载完
     * @param {string|undefined} props.error 读取错误
     * @param {boolean} props.refreshing
     * @param {(product: string, body: object) => Promise<object>} props.onWrite
     * @param {boolean} props.writePending
     * @param {Function} props.t
     */
    function ConfigPageView({ doc, error, refreshing, onWrite, writePending, t }) {
      if (error !== undefined && doc === undefined) {
        return jsx("div", { children: `${t("errorBanner", { message: error })} · ${t("retry")}` });
      }
      if (doc === undefined) return t("loading");

      const products = Array.isArray(doc.products) ? doc.products : [];
      return jsxs(Fragment, { children: [
        jsx("div", { style: rowStyle, children: [
          jsx("span", { style: mutedStyle, children: t("intro") }),
          jsx("button", {
            type: "button",
            style: buttonStyle,
            disabled: refreshing,
            onClick: () => void reloadRef?.(),
            children: refreshing ? t("refreshing") : t("refresh"),
          }),
        ]}),
        jsx("ul", { style: pageListStyle, children: products.map((product) =>
          jsx(ProductCard, { key: product.id, product, t, onWrite, writePending }, product.id),
        ) }),
      ] });
    }

    /** 让 View 里的刷新按钮能回调到取数层。 */
    let reloadRef;

    /**
     * 插件配置页（宿主注册的组件）。
     *
     * `view === "summary"` 是宿主要求的一行简介；其余走取数 + 渲染。
     * 用 `<ul>`/`<li>` 而不是 div：宿主自己的样式表会给 ul 塞一堆默认样式，
     * 显式清掉才能保证与原布局一致（这是 workbuddy 踩出来的经验）。
     */
    function ConfigPage({ view, t }) {
      const { doc, error, refreshing, reload } = useStatusDocument();
      const probeKey = useProbeKey();
      const { write, pending } = useVisibilityWriter(probeKey);

      reloadRef = reload;

      // 写完立刻重读，让勾选框状态与 Host 一致
      const handleWrite = useCallback(
        async (product, body) => {
          const result = await write(product, body);
          await reload();
          return result;
        },
        [write, reload],
      );

      if (view === "summary") return t("intro");
      return jsx(ConfigPageView, { doc, error, refreshing, onWrite: handleWrite, writePending: pending, t });
    }

    // ── 降级守卫 ─────────────────────────────────────────────────────────
    const CONTRIBUTION_FAILED = "[dsh-huaweicloud-connect] client contribution degraded (host unaffected):";
    const NOOP_DISPOSER = () => {};

    function guard(label, fn) {
      try {
        return fn();
      } catch (error) {
        console.error(`${CONTRIBUTION_FAILED} ${label}`, error);
        return undefined;
      }
    }

    const name = "dsh-huaweicloud-connect-client";
    /** 需要的客户端服务：slots 注册表 + locale 文案表。 */
    const inject = ["slots", "locale"];

    function apply(ctx) {
      const namespace = "settings.huaweicloud";

      guard("settings copy", () => {
        ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-huaweicloud-connect: settings copy");
      });

      const t = ctx.locale.bind(namespace);

      // 两层 guard：slots.inject 的回调是延迟执行的，外层 try/catch 接不住
      guard("plugins.bundle.config page", () => {
        ctx.slots.inject("plugins.bundle.config", () =>
          guard("plugins.bundle.config page", () =>
            ctx.slots.register(
              {
                name: "plugins.bundle.config",
                key: BUNDLE_NAME,
                locale: namespace,
              },
              ConfigPage,
            ),
          ) ?? NOOP_DISPOSER,
        );
      });
    }

    return { apply, inject, name, BUNDLE_NAME, STATUS_PATH, VISIBILITY_PATH, ConfigPageView, ProductCard };
  },
});
