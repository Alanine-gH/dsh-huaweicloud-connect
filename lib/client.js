/**
 * dsh-huaweicloud-connect · Web 半边（设置界面）。
 *
 * 契约全部对齐 DSH 0.2.1-rc.2：
 * - `window.__ModuleLoader__.load({ id, factory })`，id = 包名
 * - factory 必须返回带 `Symbol.toStringTag = "Module"` 的 `module.exports`
 * - 只注册一个 slot：`plugins.bundle.config`，key = 包名，`view: 'page'`
 * - 每个贡献都要 guard **两层**：外层 catch 同步抛出，内层 catch 延迟回调抛出。
 *   `slots.inject` 的回调在 apply() 返回之后才执行，外层 try/catch 接不住。
 *
 * 数据通道：同源 fetch `/plugins/dsh-huaweicloud-connect/status`（只读）
 * 与 `/visibility`（写，需 header 携带进程内 key）。三处 fetch 都必须带
 * `credentials: "same-origin"`，否则浏览器走 CORS 模式，Host 侧回环闸判 403。
 *
 * @module dsh-huaweicloud-connect/client
 */

window.__ModuleLoader__.load({
  id: "dsh-huaweicloud-connect",
  factory: (require) => {
    var module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const { useCallback, useEffect, useRef, useState } = require("react");
    const { jsx } = require("react/jsx-runtime");

    /**
     * 渲染助手。
     *
     * **React 的 `jsx(type, props, key)` 第三参是 key，不是 children。**
     * children 必须放进 `props.children`。直接写 `jsx("div", {style}, child)`
     * 会得到一个空 div —— 不报错、不警告，整块界面消失。
     *
     * v0.2.0 我为了绕开嵌套括号错误，把 `children: [...]` 改成位置参数，
     * 结果 v0.2.0–v0.5.0 全部卡在这上面：卡片区域永远空白。
     *
     * 这层 `h` 把位置参数正确折叠进 props.children，既保留自然写法，
     * 又不会踩坑。全文件只用它，不直接用 jsx。
     */
    const h = (type, props, ...children) => {
      const next = { ...(props ?? {}) };
      if (children.length === 1) next.children = children[0];
      else if (children.length > 1) next.children = children;
      return jsx(type, next);
    };

    // ── 常量：与 Host 半边共享 ────────────────────────────────────────────
    const STATUS_PATH = "/plugins/dsh-huaweicloud-connect/status";
    const KEY_PATH = "/plugins/dsh-huaweicloud-connect/key";
    const VISIBILITY_PATH = "/plugins/dsh-huaweicloud-connect/visibility";
    const PROBE_PATH = "/plugins/dsh-huaweicloud-connect/probe";
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

      signedIn: "已登录",
      signedOut: "未登录",
      signedOutHint: "请先打开 {app} 客户端并登录一次，本插件会自动跟随",
      noAccount: "未提供账号标识",
      credentialPath: "凭据来源",
      expiresAt: "有效期",
      expiresNever: "长期有效（随客户端会话）",
      expiresSoon: "{time} 后过期",
      expiredHint: "{app} 的登录态已过期，请打开客户端让它自动续期",
      catalogUpdated: "模型列表更新于 {time}",
      modelCount: "{count} 个模型，已隐藏 {hidden} 个",

      contextHeading: "上下文窗口",
      contextHint: "取消勾选即可在模型选择器中隐藏该模型；隐藏配置按登录账号分别保存，已在用该模型的会话不受影响。",
      allVisible: "全部显示",
      noneVisible: "全部隐藏",

      tabReasoning: "思考强度",
      reasoningHeading: "推理档位",
      reasoningHint: "模型选择器里的「思考强度」由这里的能力表决定。华为上游逐模型不同：有的全档支持，有的只有几档，有的完全不支持。",
      reasoningDetected: "已探测",
      reasoningNotDetected: "未探测",
      reasoningNone: "不支持思考强度",
      reasoningProbe: "探测",
      reasoningProbeAll: "全部探测",
      reasoningProbeRunning: "探测中…",
      reasoningKnownCount: "{known}/{total} 已知，{unprobed} 未探测",
      reasoningUnprobedTitle: "还没测过的模型",
      reasoningUnsupportedTitle: "实测不支持的模型",
      reasoningNonValidatingShort: "上游不校验该参数",
      reasoningLevels: "可选档位",

      providerHeading: "上游接入",
      providerEndpoint: "接入点",
      authHeading: "鉴权方式",
      authBasic: "APIG APP 认证（Basic）",
      authSignature: "APIG 签名（SDK-HMAC-SHA256）",
      requestPath: "请求路径",
      refreshNotice: "刷新策略",
      refreshPolicy: "只读登录态，不代客户端续期",
      refreshPolicyWhy: "两个客户端的 refresh_token 均一次性轮换，代刷会导致客户端被登出",
      concurrencyNote: "客户端运行时最多占用 3 个免费会话",
      builtInModels: "内置兜底目录",
      builtInNote: "客户端从未运行过时使用；实测不可用的模型不会出现在这里",

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

      signedIn: "Signed in",
      signedOut: "Not signed in",
      signedOutHint: "Sign in once in the {app} client; this plugin follows it automatically",
      noAccount: "no account identifier",
      credentialPath: "Credential source",
      expiresAt: "Validity",
      expiresNever: "no expiry (follows client session)",
      expiresSoon: "expires in {time}",
      expiredHint: "The {app} credential has expired; open the client so it can renew",
      catalogUpdated: "Model list updated {time}",
      modelCount: "{count} models, {hidden} hidden",

      contextHeading: "Context window",
      contextHint: "Uncheck to hide from the model picker. Visibility is saved per account; sessions already using a model are unaffected.",
      allVisible: "Show all",
      noneVisible: "Hide all",

      tabReasoning: "Thinking effort",
      reasoningHeading: "Reasoning levels",
      reasoningHint: "The picker's thinking-effort choices come from this capability table. The upstream differs per model: some support every level, some only a few, some none.",
      reasoningDetected: "detected",
      reasoningNotDetected: "not detected",
      reasoningNone: "no thinking effort",
      reasoningProbe: "Detect",
      reasoningProbeAll: "Detect all",
      reasoningProbeRunning: "Detecting…",
      reasoningKnownCount: "{known}/{total} known, {unprobed} untested",
      reasoningUnprobedTitle: "Not yet tested",
      reasoningUnsupportedTitle: "Tested and unsupported",
      reasoningNonValidatingShort: "upstream does not validate this parameter",
      reasoningLevels: "levels",

      providerHeading: "Upstream",
      providerEndpoint: "Endpoint",
      authHeading: "Authentication",
      authBasic: "APIG app authentication (Basic)",
      authSignature: "APIG signature (SDK-HMAC-SHA256)",
      requestPath: "Request path",
      refreshNotice: "Refresh policy",
      refreshPolicy: "read-only; never renews for the client",
      refreshPolicyWhy: "both clients rotate refresh_token once; renewing here would log the client out",
      concurrencyNote: "a running client occupies up to 3 free sessions",
      builtInModels: "Built-in fallback catalog",
      builtInNote: "used only before the client has ever run; unverified models are excluded",

      errorBanner: "Failed to read: {message}",
    };

    // ── 工具 ─────────────────────────────────────────────────────────────
    const NUMBER_FORMAT = new Intl.NumberFormat();

    /** 把 token 数格式化成 1M / 203K 这种可读形式。 */
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

    /** 绝对时间的短格式：今天只给时刻，更早带日期。 */
    function absoluteTime(ms, now) {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
      const date = new Date(ms);
      const sameDay = new Date(now).toDateString() === date.toDateString();
      const hh = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
      if (sameDay) return hh;
      return `${date.getMonth() + 1}月${date.getDate()}日 ${hh}`;
    }

    // ── 样式 ─────────────────────────────────────────────────────────────
    // 只用继承色 + rgba，不硬编码主题色，也不依赖 color-mix()（外壳内核版本未知）。
    const HAIRLINE = "1px solid rgba(127, 127, 127, 0.28)";
    const cardStyle = {
      display: "flex",
      flexDirection: "column",
      border: HAIRLINE,
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
    const tabsStyle = { display: "flex", gap: 4, borderBottom: HAIRLINE };
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
      border: HAIRLINE,
      background: "transparent",
      color: "inherit",
      font: "inherit",
      whiteSpace: "nowrap",
    };
    const statusDotStyle = { width: 8, height: 8, borderRadius: "50%", flex: "0 0 auto", background: "currentColor" };
    const listStyle = { display: "flex", flexDirection: "column", gap: 2, listStyle: "none", margin: 0, padding: 0 };
    const pageListStyle = { display: "flex", flexDirection: "column", gap: 12, listStyle: "none", margin: 0, padding: 0 };
    const checkboxStyle = { margin: 0, flex: "0 0 auto", cursor: "inherit" };
    const rootStyle = { display: "flex", flexDirection: "column", gap: 12 };
    const columnStyle = (gap) => ({ display: "flex", flexDirection: "column", gap });

    // ── 数据获取 ─────────────────────────────────────────────────────────
    /**
     * 拉状态文档。
     *
     * `readSeq` 竞态防护：序号必须在**请求开始时**取，不是响应到达时取。
     * 否则 60s 轮询的慢响应会在手动刷新之后才返回，把新状态覆盖回旧状态。
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
            // 必须带 same-origin：不带时浏览器按 CORS 模式发请求，Host 侧
            // 回环闸判 403，界面显示「读取失败」。
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

    /** 拿写路由的进程内 key。 */
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

    /** 一行「左标签 / 右值」。 */
    function InfoRow({ label, value, mono = false }) {
      const text = value === undefined || value === null || value === "" ? "—" : String(value);
      return h("div", { style: rowStyle },
        h("span", { style: mutedStyle }, label),
        h("span", {
          style: {
            opacity: 0.85,
            fontSize: "0.9em",
            textAlign: "right",
            wordBreak: "break-all",
            fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined,
          },
        }, text),
      );
    }

    /** 状态圆点。 */
    function StatusDot({ ok }) {
      return h("span", { style: { ...statusDotStyle, opacity: ok ? 1 : 0.3 } });
    }

    // ── 三个标签页 ───────────────────────────────────────────────────────

    /** 状态：账号、凭据、到期、目录来源。 */
    function StatusTab({ product, t, now }) {
      const appName = product.displayName ?? product.id;
      const signedIn = product.status === "signed-in";
      const expired = product.expired === true;

      if (!signedIn) {
        return h("div", { style: columnStyle(6) },
          h("div", { style: rowStyle },
            h("span", { style: labelStyle },
              h(StatusDot, { ok: false }),
              h("span", null, t("signedOut")),
            ),
          ),
          h("div", { style: hintStyle }, t("signedOutHint", { app: appName })),
        );
      }

      const remaining = expired ? undefined : remainingText(product.expiresAt, now);
      const expiryText = expired
        ? t("expiredHint", { app: appName })
        : remaining !== undefined
          ? t("expiresSoon", { time: remaining })
          : t("expiresNever");

      const children = [
        h("div", { style: rowStyle },
          h("span", { style: labelStyle },
            h(StatusDot, { ok: !expired }),
            h("span", null, t("signedIn")),
          ),
          h("span", { style: mutedStyle }, product.account ?? t("noAccount")),
        ),
        h(InfoRow, { label: t("expiresAt"), value: expiryText }),
      ];

      if (product.sourcePath) {
        children.push(h(InfoRow, { label: t("credentialPath"), mono: true, value: product.sourcePath }));
      }
      if (typeof product.catalogFetchedAt === "number") {
        children.push(h(InfoRow, {
          label: t("catalogUpdated"),
          value: absoluteTime(product.catalogFetchedAt, now),
        }));
      }
      if (typeof product.modelCount === "number") {
        children.push(h("div", { style: mutedStyle },
          t("modelCount", { count: product.modelCount, hidden: product.hiddenCount ?? 0 })));
      }
      if (product.catalogError) {
        children.push(h("div", { style: hintStyle }, product.catalogError.message));
      }

      return h("div", { style: columnStyle(7) }, ...children);
    }

    /** 上下文窗口：模型勾选列表。 */
    function ContextTab({ product, t, onWrite, writePending }) {
      const models = Array.isArray(product.models) ? product.models : [];
      if (models.length === 0) return h("div", { style: hintStyle }, "—");

      const hiddenCount = models.filter((model) => model.hidden === true).length;
      const allVisible = hiddenCount === 0;
      const noneVisible = hiddenCount === models.length;
      const allIds = models.map((model) => model.id);

      const rows = models.map((model) => {
        const inputId = `hc-ctx-${product.id}-${model.id}`;
        const supportsImage = Array.isArray(model.input) && model.input.includes("image");
        const meta = [formatTokens(model.contextWindow)];
        if (model.maxTokens !== undefined) meta.push(`↑${formatTokens(model.maxTokens)}`);
        if (supportsImage) meta.push("IMG");

        return h("li", { key: model.id, style: rowStyle },
          h("label", {
            htmlFor: inputId,
            style: { ...labelStyle, cursor: writePending ? "default" : "pointer" },
          },
            h("input", {
              id: inputId,
              type: "checkbox",
              style: checkboxStyle,
              checked: model.hidden !== true,
              disabled: writePending,
              onChange: (event) => {
                void onWrite(product.id, { modelId: model.id, visible: event.target.checked }).catch(() => undefined);
              },
            }),
            h("span", { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
              model.name ?? model.id),
          ),
          h("span", { style: { ...mutedStyle, display: "flex", gap: 10, whiteSpace: "nowrap" } },
            ...meta.map((item, index) => h("span", { key: String(index) }, item))),
        );
      });

      return h("div", { style: columnStyle(8) },
        h("div", { style: hintStyle }, t("contextHint")),
        h("div", { style: rowStyle },
          h("span", { style: mutedStyle }, t("contextHeading")),
          h("div", { style: { display: "flex", gap: 6 } },
            h("button", {
              type: "button",
              style: buttonStyle,
              disabled: writePending || allVisible,
              onClick: () => {
                void onWrite(product.id, { all: true, models: allIds }).catch(() => undefined);
              },
            }, t("allVisible")),
            h("button", {
              type: "button",
              style: buttonStyle,
              disabled: writePending || noneVisible,
              onClick: () => {
                void onWrite(product.id, { all: false, models: allIds }).catch(() => undefined);
              },
            }, t("noneVisible")),
          ),
        ),
        h("ul", { style: listStyle }, ...rows),
      );
    }

    /**
     * 思考强度：显示每个模型的推理档位能力，并提供逐模型探测。
     *
     * 档位来自三层：上游声明 → 本地探测 → 内置已验证基线。
     *
     * **"未探测"和"不支持"是两件事**，这里必须分开列：
     * 一个模型没出现在基线里，只代表还没测过，不代表上游拒绝该参数。
     * 早先版本把两者混成一个"不支持"列表，让用户以为二十多个模型都不支持，
     * 而实测下来多数只是没测（glm-5.1/5.2、kimi-k2.6、DeepSeek-V4-Flash 等
     * 都会正常拒绝非法值，属于"可探测"）。
     */
    function ReasoningTab({ product, t, onProbe, probePending }) {
      const models = Array.isArray(product.models) ? product.models : [];
      if (models.length === 0) return h("div", { style: hintStyle }, "—");

      const probeState = product.probeState ?? { probed: 0, entries: [] };
      const entryById = new Map((probeState.entries ?? []).map((entry) => [entry.modelId, entry]));

      /** 三分类：有档位 / 实测不支持 / 还没测过。 */
      const withLevels = [];
      const rejected = [];
      const unprobed = [];
      for (const model of models) {
        const levels = Array.isArray(model.thinkingLevels) ? model.thinkingLevels : [];
        const entry = entryById.get(model.id);
        if (levels.length > 0) {
          withLevels.push({ model, entry, levels });
        } else if (entry?.validation === "non-validating") {
          rejected.push({ model, entry, reason: "non-validating" });
        } else if (entry !== undefined) {
          // 探测过且没档位 → 上游确实拒绝（或模型不可用）
          rejected.push({ model, entry, reason: entry.validation });
        } else {
          unprobed.push({ model });
        }
      }

      const rowOf = ({ model, entry, levels }) => {
        const meta = [];
        if (Array.isArray(levels) && levels.length > 0) meta.push(levels.join(" · "));
        else if (entry?.validation === "non-validating") meta.push(t("reasoningNonValidating"));
        else meta.push(t("reasoningNone"));

        return h("li", { key: model.id, style: { ...rowStyle, alignItems: "flex-start", padding: "6px 0" } },
          h("div", { style: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 } },
            h("span", { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
              model.name ?? model.id),
            h("span", { style: { ...mutedStyle, opacity: 0.5, fontSize: "0.8em" } },
              entry === undefined ? t("reasoningNotDetected") : t("reasoningDetected")),
          ),
          h("div", { style: { display: "flex", alignItems: "center", gap: 10, flex: "0 0 auto" } },
            h("span", { style: { ...mutedStyle, textAlign: "right", whiteSpace: "nowrap" } }, ...meta),
            h("button", {
              type: "button",
              style: { ...buttonStyle, opacity: probePending ? 0.5 : 1 },
              disabled: probePending,
              onClick: () => {
                void onProbe?.(product.id, model.id)?.catch?.(() => undefined);
              },
            }, t("reasoningProbe")),
          ),
        );
      };

      const children = [
        h("div", { style: hintStyle }, t("reasoningHint")),
        h("div", { style: rowStyle },
          h("span", { style: mutedStyle },
            `${t("reasoningHeading")} · ${t("reasoningKnownCount", {
              known: withLevels.length,
              total: models.length,
              unprobed: unprobed.length,
            })}`),
          h("button", {
            type: "button",
            style: { ...buttonStyle, opacity: probePending ? 0.5 : 1 },
            disabled: probePending || models.length === 0,
            onClick: () => {
              void onProbe?.(product.id, undefined)?.catch?.(() => undefined);
            },
          }, probePending ? t("reasoningProbeRunning") : t("reasoningProbeAll")),
        ),
      ];

      if (withLevels.length > 0) {
        children.push(h("ul", { style: listStyle }, ...withLevels.map(rowOf)));
      }

      // 未探测：明确说是"还没测"，并给出探测入口，不要吓唬用户
      if (unprobed.length > 0) {
        children.push(h("div", { style: { ...hintStyle, marginTop: 8 } },
          h("div", { style: { opacity: 0.85, marginBottom: 3 } },
            `${t("reasoningUnprobedTitle")}（${unprobed.length}）：`),
          h("div", null, unprobed.map((row) => row.model.name ?? row.model.id).join("、")),
        ));
      }

      // 实测不支持：这些是真结论
      if (rejected.length > 0) {
        children.push(h("div", { style: { ...hintStyle, marginTop: 8 } },
          h("div", { style: { opacity: 0.85, marginBottom: 3 } },
            `${t("reasoningUnsupportedTitle")}（${rejected.length}）：`),
          h("div", null, rejected.map((row) =>
            `${row.model.name ?? row.model.id}${row.reason === "non-validating" ? `（${t("reasoningNonValidatingShort")}）` : ""}`,
          ).join("、")),
        ));
      }

      return h("div", { style: columnStyle(8) }, ...children);
    }

    /** 明细：上游接入信息与设计取舍。 */
    function DetailsTab({ product, t }) {
      const isCodeArts = product.id === "codearts";
      const children = [
        h(InfoRow, { label: t("providerEndpoint"), mono: true, value: product.baseUrl ?? "—" }),
        h(InfoRow, { label: t("authHeading"), value: isCodeArts ? t("authSignature") : t("authBasic") }),
        h(InfoRow, {
          label: t("requestPath"),
          mono: true,
          value: isCodeArts ? "/api/v2/chat/completions" : "/chat/completions",
        }),
      ];
      if (isCodeArts) children.push(h("div", { style: hintStyle }, t("concurrencyNote")));
      children.push(h(InfoRow, { label: t("refreshNotice"), value: t("refreshPolicy") }));
      children.push(h("div", { style: hintStyle }, t("refreshPolicyWhy")));
      if (isCodeArts) {
        children.push(h("div", { style: columnStyle(4) },
          h("div", { style: { opacity: 0.8, fontSize: "0.9em" } }, t("builtInModels")),
          h("div", { style: hintStyle }, t("builtInNote")),
        ));
      }
      return h("div", { style: columnStyle(7) }, ...children);
    }

    // ── 产品卡片 ─────────────────────────────────────────────────────────
    function ProductCard({ product, t, onWrite, writePending, onProbe, probePending }) {
      const [expanded, setExpanded] = useState(true);
      const [tab, setTab] = useState("status");
      const now = Date.now();
      const appName = product.displayName ?? product.id;
      const signedIn = product.status === "signed-in";
      const models = Array.isArray(product.models) ? product.models : [];

      const tabs = [{ id: "status", label: t("tabStatus") }];
      if (signedIn && models.length > 0) tabs.push({ id: "context", label: t("tabContext") });
      if (signedIn && models.length > 0) tabs.push({ id: "reasoning", label: t("tabReasoning") });
      tabs.push({ id: "details", label: t("tabDetails") });

      const activeTab = tabs.some((item) => item.id === tab) ? tab : "status";

      const tabButtons = tabs.map((item) =>
        h("button", {
          key: item.id,
          type: "button",
          style: item.id === activeTab ? tabActiveStyle : tabBaseStyle,
          onClick: (event) => {
            event.stopPropagation();
            setTab(item.id);
          },
        }, item.label));

      const tabBody = activeTab === "context"
        ? h(ContextTab, { product, t, onWrite, writePending })
        : activeTab === "reasoning"
          ? h(ReasoningTab, { product, t, onProbe, probePending })
          : activeTab === "details"
            ? h(DetailsTab, { product, t })
            : h(StatusTab, { product, t, now });

      const body = h("div", { style: bodyStyle },
        h("div", { style: tabsStyle }, ...tabButtons),
        tabBody,
      );

      return h("li", { style: cardStyle },
        h("div", {
          style: headerStyle,
          onClick: () => setExpanded((prev) => !prev),
        },
          h("div", { style: headerTitleStyle },
            h("strong", null, appName),
            h("span", { style: mutedStyle }, product.providerId ?? product.id),
          ),
          h("span", { style: mutedStyle }, expanded ? t("collapse") : t("expand")),
        ),
        expanded ? body : null,
      );
    }

    /**
     * 纯渲染层：给定状态文档画出配置页。
     *
     * 与 ConfigPage 分开：取数（fetch + 轮询 + 竞态防护）是一件事，渲染是另一件。
     * 拆开后渲染分支可以被离线测试直接驱动，不必伪造 fetch 与 hook。
     */
    function ConfigPageView({ doc, error, refreshing, onWrite, writePending, onProbe, probePending, t, onReload }) {
      if (error !== undefined && doc === undefined) {
        return h("div", null, t("errorBanner", { message: error }));
      }
      if (doc === undefined) return h("div", { style: hintStyle }, t("loading"));

      const products = Array.isArray(doc.products) ? doc.products : [];
      const cards = products.map((product) =>
        h(ProductCard, { key: product.id, product, t, onWrite, writePending, onProbe, probePending }));

      return h("div", { style: rootStyle },
        h("div", { style: rowStyle },
          h("span", { style: { ...mutedStyle, flex: "1 1 auto" } }, t("intro")),
          h("button", {
            type: "button",
            style: buttonStyle,
            disabled: refreshing,
            onClick: () => void onReload?.(),
          }, refreshing ? t("refreshing") : t("refresh")),
        ),
        h("ul", { style: pageListStyle }, ...cards),
      );
    }

    /**
     * 插件配置页（宿主注册的组件）。
     *
     * 契约：`plugins.bundle.config` 只传 `view: 'page'`，渲染在 bundle 页面的
     * 描述与行之间。
     */
    function ConfigPage({ view, t }) {
      const { doc, error, refreshing, reload } = useStatusDocument();
      const probeKey = useProbeKey();
      const { write, pending } = useVisibilityWriter(probeKey);
      const { probe, probePending } = useReasoningProbe(probeKey);

      const handleWrite = useCallback(
        async (product, body) => {
          const result = await write(product, body);
          await reload();
          return result;
        },
        [write, reload],
      );

      const handleProbe = useCallback(
        async (product, modelId) => {
          const result = await probe(product, modelId);
          await reload();
          return result;
        },
        [probe, reload],
      );

      // t 由宿主按注册项的 locale 字段注入 props。若宿主未注入（或渲染早于
      // 文案表注册），t 会是 null —— 直接 t("x") 会抛 "Cannot read properties
      // of null"，整页白屏。回退到 key 本身，宁可显示裸 key 也不要空白。
      const tr = typeof t === "function" ? t : (key) => String(key ?? "");

      if (view === "summary") return h("div", { style: hintStyle }, tr("intro"));

      return h("div", { style: rootStyle },
        h(ConfigPageView, {
          doc,
          error,
          refreshing,
          onWrite: handleWrite,
          writePending: pending,
          onProbe: handleProbe,
          probePending,
          t: tr,
          onReload: reload,
        }),
      );
    }

    /**
     * 触发推理档位探测。
     *
     * 探测会向上游发真实请求（每次 1 token），所以先确认。全部探测是串行
     * 的：并行会撞上游的 1 次/秒限流，反而让探测判成 unknown。
     */
    function useReasoningProbe(probeKeyProvider) {
      const [probePending, setPending] = useState(false);

      const probe = useCallback(
        async (product, modelId) => {
          const key = probeKeyProvider();
          if (typeof key !== "string" || key.length === 0) throw new Error("missing-key");
          setPending(true);
          try {
            const response = await fetch(PROBE_PATH, {
              method: "POST",
              headers: { "content-type": "application/json", [KEY_HEADER]: key },
              credentials: "same-origin",
              body: JSON.stringify({ product, modelId, consent: true }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
          } finally {
            setPending(false);
          }
        },
        [probeKeyProvider],
      );

      return { probe, probePending };
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

      // 文案表必须先注册，宿主才能在渲染时按 locale namespace 注入 t。
      guard("settings copy", () => {
        ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-huaweicloud-connect: settings copy");
      });

      // 不要 `const t = ctx.locale.bind(namespace)`：文案表尚未 commit 时可能
      // 返回 null，而且组件的 t 由宿主按注册项的 locale 字段注入 props。

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

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    exports.BUNDLE_NAME = BUNDLE_NAME;
    exports.STATUS_PATH = STATUS_PATH;
    exports.VISIBILITY_PATH = VISIBILITY_PATH;
    exports.ConfigPage = ConfigPage;
    exports.ConfigPageView = ConfigPageView;
    exports.ProductCard = ProductCard;
    exports.StatusTab = StatusTab;
    exports.ContextTab = ContextTab;
    exports.ReasoningTab = ReasoningTab;
    exports.DetailsTab = DetailsTab;
    exports.InfoRow = InfoRow;
    exports.formatTokens = formatTokens;
    exports.remainingText = remainingText;
    exports.absoluteTime = absoluteTime;
    exports.h = h;
    return module.exports;
  },
});
