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
 * 界面结构照 dsh-workbuddy-connect 的卡片：折叠头 + 三个标签
 *   状态 / 上下文窗口 / 明细
 * 每个产品一张卡片；没有凭据能力支撑的标签不渲染（而不是显示「不可用」）。
 *
 * 数据通道：同源 fetch `/plugins/dsh-huaweicloud-connect/status`（只读）
 * 与 `/visibility`（写，需 header 携带进程内 key）。
 *
 * @module dsh-huaweicloud-connect/client
 */

window.__ModuleLoader__.load({
  id: "dsh-huaweicloud-connect",
  factory: (require) => {
    const { useCallback, useEffect, useRef, useState } = require("react");
    const { jsx, jsxs, Fragment } = require("react/jsx-runtime");

    // ── 常量：与 Host 半边共享 ────────────────────────────────────────────
    const STATUS_PATH = "/plugins/dsh-huaweicloud-connect/status";
    const KEY_PATH = "/plugins/dsh-huaweicloud-connect/key";
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
      collapse: "收起",
      expand: "展开",

      tabStatus: "状态",
      tabContext: "上下文窗口",
      tabDetails: "明细",

      accountHeading: "账号",
      signedIn: "已登录",
      signedOut: "未登录",
      signedOutHint: "请先打开 {app} 客户端并登录一次，本插件会自动跟随",
      noAccount: "未提供账号标识",
      credentialPath: "凭据来源",
      expiresAt: "有效期",
      expiresNever: "长期有效（随客户端会话）",
      expiresSoon: "{time} 后过期",
      expired: "已过期",
      expiredHint: "{app} 的登录态已过期，请打开客户端让它自动续期",
      catalogUpdated: "模型列表更新于 {time}",
      modelCount: "{count} 个模型，已隐藏 {hidden} 个",

      contextHeading: "上下文窗口",
      contextHint: "取消勾选即可在模型选择器中隐藏该模型；隐藏配置按登录账号分别保存，已在用该模型的会话不受影响。",
      allVisible: "全部显示",
      noneVisible: "全部隐藏",
      perAccount: "按账号分别记忆显隐",

      detailsHeading: "明细",
      providerHeading: "上游接入",
      providerEndpoint: "接入点",
      authHeading: "鉴权方式",
      authBasic: "APIG APP 认证（Basic）",
      authSignature: "APIG 签名（SDK-HMAC-SHA256）",
      requestPath: "请求路径",
      refreshNotice: "刷新策略",
      refreshPolicy: "只读登录态，不代客户端续期",
      refreshPolicyWhy: "两个客户端的 refresh_token 均一次性轮换，代刷会导致客户端被登出",
      concurrencyHeading: "并发限制",
      concurrencyNote: "客户端运行时最多占用 3 个免费会话",
      builtInModels: "内置兜底目录",
      builtInNote: "客户端从未运行过时使用；实测不可用的模型不会出现在这里",

      saveFailed: "保存失败：{message}",
      errorBanner: "读取失败：{message}",
    };

    const en = {
      title: "Huawei Cloud Models",
      intro: "Use models from the CodeArts and OfficeAce desktop clients, following their sign-in automatically",
      loading: "Loading sign-in status…",
      refresh: "Refresh",
      refreshing: "Refreshing…",
      collapse: "Collapse",
      expand: "Expand",

      tabStatus: "Status",
      tabContext: "Context window",
      tabDetails: "Details",

      accountHeading: "Account",
      signedIn: "Signed in",
      signedOut: "Not signed in",
      signedOutHint: "Sign in once in the {app} client; this plugin follows it automatically",
      noAccount: "no account identifier",
      credentialPath: "Credential source",
      expiresAt: "Validity",
      expiresNever: "no expiry (follows client session)",
      expiresSoon: "expires in {time}",
      expired: "expired",
      expiredHint: "The {app} credential has expired; open the client so it can renew",
      catalogUpdated: "Model list updated {time}",
      modelCount: "{count} models, {hidden} hidden",

      contextHeading: "Context window",
      contextHint: "Uncheck to hide from the model picker. Visibility is saved per account; sessions already using a model are unaffected.",
      allVisible: "Show all",
      noneVisible: "Hide all",
      perAccount: "Remember visibility per account",

      detailsHeading: "Details",
      providerHeading: "Upstream",
      providerEndpoint: "Endpoint",
      authHeading: "Authentication",
      authBasic: "APIG app authentication (Basic)",
      authSignature: "APIG signature (SDK-HMAC-SHA256)",
      requestPath: "Request path",
      refreshNotice: "Refresh policy",
      refreshPolicy: "read-only; never renews for the client",
      refreshPolicyWhy: "both clients rotate refresh_token once; renewing here would log the client out",
      concurrencyHeading: "Concurrency",
      concurrencyNote: "a running client occupies up to 3 free sessions",
      builtInModels: "Built-in fallback catalog",
      builtInNote: "used only before the client has ever run; unverified models are excluded",

      saveFailed: "Save failed: {message}",
      errorBanner: "Failed to read: {message}",
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
      if (typeof expiresAt !== "number") return undefined;
      const ms = expiresAt - now;
      if (ms <= 0) return undefined;
      const minutes = Math.floor(ms / 60_000);
      if (minutes < 60) return `${minutes} 分钟`;
      const hours = Math.floor(minutes / 60);
      if (hours < 48) return `${hours} 小时`;
      return `${Math.floor(hours / 24)} 天`;
    }

    /** 绝对时间的短格式：今天只要时刻，更早要带日期。 */
    function absoluteTime(ms, now) {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
      const date = new Date(ms);
      const sameDay = new Date(now).toDateString() === date.toDateString();
      const hh = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
      if (sameDay) return hh;
      return `${date.getMonth() + 1}月${date.getDate()}日 ${hh}`;
    }

    // ── 样式：只用继承色与 opacity，不硬编码颜色，保证跟随宿主主题 ──────────
    const cardStyle = {
      display: "flex",
      flexDirection: "column",
      border: "1px solid color-mix(in srgb, currentColor 16%, transparent)",
      borderRadius: 10,
      overflow: "hidden",
    };
    const headerStyle = {
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 10,
      padding: 12,
      cursor: "pointer",
      userSelect: "none",
    };
    const headerTitleStyle = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
    const bodyStyle = { padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 10 };
    const tabsStyle = { display: "flex", gap: 4, borderBottom: "1px solid color-mix(in srgb, currentColor 14%, transparent)" };
    const tabBaseStyle = {
      padding: "7px 12px",
      cursor: "pointer",
      font: "inherit",
      border: "none",
      background: "transparent",
      color: "inherit",
      opacity: 0.6,
      borderBottom: "2px solid transparent",
      marginBottom: -1,
    };
    const tabActiveStyle = { ...tabBaseStyle, opacity: 1, borderBottomColor: "currentColor", fontWeight: 600 };
    const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 };
    const labelStyle = { display: "flex", alignItems: "center", gap: 7, minWidth: 0 };
    const mutedStyle = { opacity: 0.62, fontSize: "0.88em" };
    const hintStyle = { opacity: 0.6, fontSize: "0.85em", lineHeight: 1.6 };
    const buttonStyle = {
      cursor: "pointer",
      padding: "3px 10px",
      borderRadius: 6,
      border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
      background: "transparent",
      color: "inherit",
      font: "inherit",
      whiteSpace: "nowrap",
    };
    const statusDotStyle = {
      width: 8,
      height: 8,
      borderRadius: "50%",
      flex: "0 0 auto",
      background: "currentColor",
      opacity: 0.35,
    };
    const listStyle = { display: "flex", flexDirection: "column", gap: 2, listStyle: "none", margin: 0, padding: 0 };
    const pageListStyle = { display: "flex", flexDirection: "column", gap: 12, listStyle: "none", margin: 0, padding: 0 };
    const checkboxStyle = { margin: 0, flex: "0 0 auto", cursor: "inherit" };

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
          const response = await fetch(STATUS_PATH, {
            headers: { accept: "application/json" },
            // credentials: "same-origin" 不是可选的。不带时浏览器按 CORS 模式发请求，
            // Host/Origin 头与实际请求不符，Host 侧的回环闸判 403，客户端就显示
            // 「读取失败：HTTP 403/404」——而 Host 端其实完全正常。
            credentials: "same-origin",
          });
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
     * 写显隐。key 走 HTTP header 而不是 body：DNS-rebinding 场景下伪造页面能自由
     * 构造 body，但受同源策略约束无法设置自定义 header。
     */
    function useVisibilityWriter(probeKeyProvider) {
      const [pending, setPending] = useState(false);

      const write = useCallback(
        async (product, body) => {
          const key = probeKeyProvider();
          if (typeof key !== "string" || key.length === 0) throw new Error("missing-key");
          setPending(true);
          try {
            const response = await fetch(VISIBILITY_PATH, {
              method: "POST",
              headers: { "content-type": "application/json", [KEY_HEADER]: key },
              credentials: "same-origin",
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

    /** 拿写路由的进程内 key（Host 只在 status 里给一个布尔标记，key 走独立端点）。 */
    function useProbeKey() {
      const [key, setKey] = useState(undefined);
      useEffect(() => {
        let cancelled = false;
        void (async () => {
          try {
            const response = await fetch(KEY_PATH, {
              headers: { accept: "text/plain" },
              credentials: "same-origin",
            });
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

    // ── 叶子组件 ─────────────────────────────────────────────────────────

    /** 一行「左标签 / 右值」。值通过 props.value 传，不走 children——两者同时给会互相覆盖。 */
    function InfoRow({ label, value, mono = false }) {
      const text = value === undefined || value === null || value === "" ? "—" : String(value);
      return jsx("div", { style: rowStyle },
        jsx("span", { style: mutedStyle, children: label }),
        jsx("span", {
          style: {
            opacity: 0.85,
            fontSize: "0.9em",
            textAlign: "right",
            wordBreak: "break-all",
            fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined,
          },
          children: text,
        }),
      );
    }

    /** 状态圆点：已登录点亮、未登录压暗。 */
    function StatusDot({ ok }) {
      return jsx("span", { style: { ...statusDotStyle, opacity: ok ? 1 : 0.3 }, title: ok ? "ok" : "off" });
    }

    // ── 三个标签页 ───────────────────────────────────────────────────────

    /** 状态：账号、凭据、到期、目录来源。 */
    function StatusTab({ product, t, now }) {
      const appName = product.displayName ?? product.id;
      const signedIn = product.status === "signed-in";
      const expired = product.expired === true;

      if (!signedIn) {
        return jsx("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
          jsx("div", { style: rowStyle },
            jsx("span", { style: { display: "flex", alignItems: "center", gap: 7 } },
              jsx(StatusDot, { ok: false }),
              jsx("span", { children: t("signedOut") }),
            ),
          ),
          jsx("div", { style: hintStyle, children: t("signedOutHint", { app: appName }) }),
        );
      }

      const remaining = expired ? undefined : remainingText(product.expiresAt, now);
      const updated = absoluteTime(product.catalogFetchedAt, now);
      const expiryText = expired
        ? t("expiredHint", { app: appName })
        : remaining !== undefined
          ? t("expiresSoon", { time: remaining })
          : t("expiresNever");

      return jsx("div", { style: { display: "flex", flexDirection: "column", gap: 7 } },
        jsx("div", { style: rowStyle },
          jsx("span", { style: { display: "flex", alignItems: "center", gap: 7 } },
            jsx(StatusDot, { ok: !expired }),
            jsx("span", { children: t("signedIn") }),
          ),
          jsx("span", { style: mutedStyle, children: product.account ?? t("noAccount") }),
        ),

        jsx(InfoRow, { label: t("expiresAt"), value: expiryText }),

        product.sourcePath ? jsx(InfoRow, { label: t("credentialPath"), mono: true, value: product.sourcePath }) : null,

        jsx(InfoRow, {
          label: t("catalogHeading"),
          value: updated !== undefined ? t("catalogUpdated", { time: updated }) : "—",
        }),

        typeof product.modelCount === "number"
          ? jsx("div", { style: mutedStyle, children: t("modelCount", { count: product.modelCount, hidden: product.hiddenCount ?? 0 }) })
          : null,

        product.catalogError
          ? jsx("div", { style: hintStyle, children: t("saveFailed", { message: product.catalogError.message }) })
          : null,
      );
    }

    /** 上下文窗口：模型勾选列表，每行显示上下文与输出上限。 */
    function ContextTab({ product, t, onWrite, writePending }) {
      const models = Array.isArray(product.models) ? product.models : [];
      if (models.length === 0) return jsx("div", { style: hintStyle, children: "—" });

      const hiddenCount = models.filter((model) => model.hidden === true).length;
      const allVisible = hiddenCount === 0;
      const noneVisible = hiddenCount === models.length;

      return jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
        jsx("div", { style: hintStyle, children: t("contextHint") }),
        jsx("div", { style: rowStyle },
          jsx("span", { style: mutedStyle, children: t("contextHeading") }),
          jsx("div", { style: { display: "flex", gap: 6 } },
            jsx("button", {
              type: "button",
              style: buttonStyle,
              disabled: writePending || allVisible,
              onClick: () => void onWrite(product.id, { all: true, models: models.map((m) => m.id) }).catch(() => undefined),
              children: t("allVisible"),
            }),
            jsx("button", {
              type: "button",
              style: buttonStyle,
              disabled: writePending || noneVisible,
              onClick: () => void onWrite(product.id, { all: false, models: models.map((m) => m.id) }).catch(() => undefined),
              children: t("noneVisible"),
            }),
          ),
        ),

        jsx("ul", { style: listStyle }, models.map((model) => {
          const inputId = `hc-ctx-${product.id}-${model.id}`;
          const labelCursor = writePending ? "default" : "pointer";
          const supportsImage = Array.isArray(model.input) && model.input.includes("image");
          return jsxs("li", { key: model.id, style: rowStyle },
            jsxs("label", { htmlFor: inputId, style: { ...labelStyle, cursor: labelCursor } },
              jsx("input", {
                id: inputId,
                type: "checkbox",
                style: checkboxStyle,
                checked: model.hidden !== true,
                disabled: writePending,
                onChange: (event) => void onWrite(product.id, { modelId: model.id, visible: event.target.checked }).catch(() => undefined),
              }),
              jsx("span", { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, children: model.name ?? model.id }),
            ),
            jsxs("span", { style: { ...mutedStyle, display: "flex", gap: 10, whiteSpace: "nowrap" } },
              jsx("span", { title: "上下文窗口", children: formatTokens(model.contextWindow) }),
              jsx("span", { style: { opacity: 0.7 }, title: "输出上限", children: `↑${formatTokens(model.maxTokens)}` }),
              supportsImage ? jsx("span", { style: { opacity: 0.7 }, title: "支持图片输入", children: "IMG" }) : null,
            ),
          );
        })),
      );
    }

    /** 明细：上游接入信息与设计取舍。 */
    function DetailsTab({ product, t }) {
      const isCodeArts = product.id === "codearts";
      return jsx("div", { style: { display: "flex", flexDirection: "column", gap: 7 } },
        jsx(InfoRow, { label: t("providerEndpoint"), mono: true, value: product.baseUrl ?? "—" }),
        jsx(InfoRow, { label: t("authHeading"), value: isCodeArts ? t("authSignature") : t("authBasic") }),
        jsx(InfoRow, { label: t("requestPath"), mono: true, value: isCodeArts ? "/api/v2/chat/completions" : "/chat/completions" }),
        isCodeArts ? jsx("div", { style: hintStyle, children: t("concurrencyNote") }) : null,
        jsx(InfoRow, { label: t("refreshNotice"), value: t("refreshPolicy") }),
        jsx("div", { style: hintStyle, children: t("refreshPolicyWhy") }),
        isCodeArts
          ? jsx("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
              jsx("div", { style: { opacity: 0.8, fontSize: "0.9em" }, children: t("builtInModels") }),
              jsx("div", { style: hintStyle, children: t("builtInNote") }),
            )
          : null,
      );
    }

    // ── 产品卡片 ─────────────────────────────────────────────────────────
    function ProductCard({ product, t, onWrite, writePending }) {
      const [expanded, setExpanded] = useState(true);
      const [tab, setTab] = useState("status");
      const now = Date.now();
      const appName = product.displayName ?? product.id;
      const signedIn = product.status === "signed-in";
      const models = Array.isArray(product.models) ? product.models : [];

      // 只有「状态」和「上下文窗口」有内容支撑；明细页始终有内容
      const tabs = useCallback(() => {
        const items = [{ id: "status", label: t("tabStatus") }];
        if (signedIn && models.length > 0) items.push({ id: "context", label: t("tabContext") });
        items.push({ id: "details", label: t("tabDetails") });
        return items;
      }, [signedIn, models.length, t]);

      const visibleTabs = tabs();

      // 当前标签被隐藏时（例如模型清空后还在 context 页）回落到 status
      const activeTab = visibleTabs.some((item) => item.id === tab) ? tab : "status";

      return jsx("li", { style: cardStyle },
        jsxs("div", {
          style: headerStyle,
          onClick: () => setExpanded((prev) => !prev),
        },
          jsx("div", { style: headerTitleStyle },
            jsx("strong", { children: appName }),
            jsx("span", { style: mutedStyle, children: product.providerId ?? product.id }),
          ),
          jsx("span", { style: mutedStyle, children: expanded ? t("collapse") : t("expand") }),
        ),

        expanded
          ? jsx("div", { style: bodyStyle },
              // ── 标签栏 ──
              jsx("div", { style: tabsStyle }, visibleTabs.map((item) =>
                jsx("button", {
                  key: item.id,
                  type: "button",
                  style: item.id === activeTab ? tabActiveStyle : tabBaseStyle,
                  onClick: (event) => {
                    event.stopPropagation();
                    setTab(item.id);
                  },
                  children: item.label,
                }, item.id),
              )),

              activeTab === "status"
                ? jsx(StatusTab, { product, t, now })
                : activeTab === "context"
                  ? jsx(ContextTab, { product, t, onWrite, writePending })
                  : jsx(DetailsTab, { product, t }),
            )
          : null,
      );
    }

    /**
     * 纯渲染层：给定状态文档画出配置页。
     *
     * 刻意与 {@link ConfigPage} 分开：数据获取（fetch + 轮询 + 竞态防护）是一件事，
     * 渲染是另一件。拆开之后渲染分支可以被离线测试直接驱动，不必伪造 fetch 与 hook。
     */
    function ConfigPageView({ doc, error, refreshing, onWrite, writePending, t, onReload }) {
      if (error !== undefined && doc === undefined) {
        return jsx("div", { children: t("errorBanner", { message: error }) });
      }
      if (doc === undefined) return t("loading");

      const products = Array.isArray(doc.products) ? doc.products : [];
      return jsxs(Fragment, null,
        jsx("div", { style: rowStyle },
          jsx("span", { style: { ...mutedStyle, flex: "1 1 auto" }, children: t("intro") }),
          jsx("button", {
            type: "button",
            style: buttonStyle,
            disabled: refreshing,
            onClick: () => void onReload?.(),
            children: refreshing ? t("refreshing") : t("refresh"),
          }),
        ),
        jsx("ul", { style: pageListStyle }, products.map((product) =>
          jsx(ProductCard, { key: product.id, product, t, onWrite, writePending }, product.id),
        )),
      );
    }

    /** 插件配置页（宿主注册的组件）。 */
    function ConfigPage({ view, t }) {
      const { doc, error, refreshing, reload } = useStatusDocument();
      const probeKey = useProbeKey();
      const { write, pending } = useVisibilityWriter(probeKey);

      const handleWrite = useCallback(
        async (product, body) => {
          const result = await write(product, body);
          await reload();
          return result;
        },
        [write, reload],
      );

      if (view === "summary") return t("intro");
      return jsx(ConfigPageView, { doc, error, refreshing, onWrite: handleWrite, writePending: pending, t, onReload: reload });
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

    return { apply, inject, name, BUNDLE_NAME, STATUS_PATH, VISIBILITY_PATH, ConfigPageView, ProductCard, StatusTab, ContextTab, DetailsTab, InfoRow, formatTokens, remainingText, absoluteTime };
  },
});