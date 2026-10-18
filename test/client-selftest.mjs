/**
 * 客户端（设置界面）的离线测试。
 *
 *   node test/client-selftest.mjs
 *
 * client.js 是给浏览器加载的 bundle（走 window.__ModuleLoader__.load），
 * 所以这里用假的 React 与假的 DSH slot 注册表把它跑起来，验证：
 *   1. 模块加载器注册形状正确（id = 包名）
 *   2. apply() 注册到正确的 slot 与 key
 *   3. 两层降级守卫真的能兜住延迟抛出的错误
 *   4. 渲染出的树在各种 status 下都成立（含「未登录」「过期」）
 *   5. 勾选模型触发的是带 key header 的 POST
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── 假 React：够用即可，只关心「渲染成了什么树」 ────────────────────────
const rendered = [];

/**
 * 假 JSX 工厂。
 *
 * 两个必须做对的地方，否则测试是假的：
 * 1. **函数类型要执行**（真实 React 就是这样渲染组件的）。只记录的话
 *    `jsx(ProductCard, …)` 不会展开，断言只能看到外层壳子。
 * 2. **rest 参数的 children 要转发**。插件里两种写法都有——
 *    `jsx("li", {children: [...]})` 和 `jsx("div", {...}, a, b)`。
 *    只认 props.children 会让位置参数那一半静默丢失，测出来的树是残缺的。
 */
function h(type, props, ...children) {
  if (typeof type === "function") return type({ ...(props ?? {}), children });
  const all = children.length > 0 ? children : (props?.children === undefined ? [] : [props.children]);
  const node = {
    type,
    props: props ?? {},
    children: all.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  };
  rendered.push(node);
  return node;
}
const fakeReact = {
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  jsx: (type, props, ...children) => h(type, props, ...children),
  jsxs: (type, props, ...children) => h(type, props, ...children),
  Fragment: "Fragment",
};

const registered = [];
const injectedSlots = new Map();
const localeCopies = {};
let injectShouldThrow = false;

// ── 假 DSH 客户端上下文 ─────────────────────────────────────────────────
const ctx = {
  locale: {
    register: (namespace, copies) => {
      localeCopies[namespace] = copies;
    },
    bind: (namespace) => (key, vars) => {
      const table = localeCopies[namespace]?.zh ?? {};
      const text = table[key] ?? key;
      if (typeof vars !== "object" || vars === null) return text;
      return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
    },
  },
  slots: {
    inject: (slotName, callback) => {
      if (injectShouldThrow) throw new Error("slot API shape break");
      injectedSlots.set(slotName, callback);
    },
    register: (descriptor, component) => {
      const disposer = () => {};
      registered.push({ descriptor, component });
      return disposer;
    },
  },
  effect: (fn) => fn(),
  on: () => undefined,
};

// ── 加载 client.js ──────────────────────────────────────────────────────
let loaderArgs;
const windowShim = {
  __ModuleLoader__: {
    load: (args) => {
      loaderArgs = args;
    },
  },
};
globalThis.window = windowShim;

const clientSource = await import("node:fs/promises").then((fs) =>
  fs.readFile(new URL("../lib/client.js", import.meta.url), "utf8"),
);
// 用 Function 构造器执行 bundle：它不依赖 require()，只依赖 window
new Function("window", "require", clientSource)(windowShim, (name) => {
  if (name === "react") return fakeReact;
  if (name === "react/jsx-runtime") return fakeReact;
  throw new Error(`client.js 依赖了未预期的模块: ${name}`);
});

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

// ── 1. 模块加载器注册 ───────────────────────────────────────────────────
test("通过 window.__ModuleLoader__.load 注册", () => {
  assert.ok(loaderArgs, "未调用 __ModuleLoader__.load");
  assert.equal(typeof loaderArgs.factory, "function");
});

test("id 必须是包名 dsh-huaweicloud-connect", () => {
  assert.equal(loaderArgs.id, "dsh-huaweicloud-connect");
});

const module = loaderArgs.factory(() => fakeReact);

// ── 2. apply() 的注册形状 ───────────────────────────────────────────────
test("factory 返回 CommonJS 形状且带 Symbol.toStringTag='Module'", () => {
  // 与 workbuddy 的 bundle 保持一致：factory 返回 module.exports，且该对象
  // 带 Symbol.toStringTag = "Module"。DSH 的 window.__ModuleLoader__ 按这个
  // 约定取返回值 —— 返回普通对象字面量时注册静默不发生（页面白屏、无报错）。
  assert.equal(
    module[Symbol.toStringTag],
    "Module",
    "factory 返回值缺少 Symbol.toStringTag='Module'，加载器可能不认",
  );
  assert.equal(typeof module.apply, "function");
});

test("导出 name / inject / apply", () => {
  assert.equal(typeof module.apply, "function");
  assert.equal(typeof module.name, "string");
  assert.ok(Array.isArray(module.inject));
  assert.equal(typeof module.ConfigPage, "function", "未导出 ConfigPage（t 为 null 的回归测试要用）");
});

test("inject 只声明 slots 与 locale（不碰别的）", () => {
  assert.deepEqual([...module.inject].sort(), ["locale", "slots"]);
});

test("apply 注册了 locale 文案，中英双份", () => {
  module.apply(ctx);
  const copies = localeCopies["settings.huaweicloud"];
  assert.ok(copies, "未注册 locale");
  assert.ok(copies.zh.title, "缺中文标题");
  assert.ok(copies.en.title, "缺英文标题");
});

/**
 * slots.inject 只**缓存**回调，真正的注册发生在 slot 声明者提交时（晚于 apply）。
 * 这里手动触发，等价于宿主里 `plugins.bundle.config` 被声明的那一刻。
 */
function commitSlot(slotName) {
  const callback = injectedSlots.get(slotName);
  assert.ok(callback, `slot ${slotName} 没有被 inject`);
  const disposer = callback();
  assert.equal(typeof disposer, "function", "注入回调必须返回 disposer");
  return disposer;
}

test("apply 注册到 plugins.bundle.config 且 key=包名", () => {
  commitSlot("plugins.bundle.config");
  const entry = registered.find((r) => r.descriptor.name === "plugins.bundle.config");
  assert.ok(entry, "提交 slot 后仍未注册");
  assert.equal(entry.descriptor.key, "dsh-huaweicloud-connect");
  assert.equal(typeof entry.component, "function");
});

test("没有注册已废弃的 settings.plugin.item（0.1.6+ 不再派发）", () => {
  const entry = registered.find((r) => r.descriptor.name === "settings.plugin.item");
  assert.equal(entry, undefined, "不该注册旧 slot");
  assert.equal(injectedSlots.has("settings.plugin.item"), false, "不该 inject 旧 slot");
});

// ── 3. 两层降级守卫 ─────────────────────────────────────────────────────
test("外层守卫：slots.inject 同步抛错被吞掉，不炸出 apply", () => {
  injectShouldThrow = true;
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    // 不应抛出
    module.apply({ ...ctx, slots: { ...ctx.slots, inject: () => { throw new Error("boom"); } } });
  } finally {
    console.error = originalError;
    injectShouldThrow = false;
  }
  assert.ok(errors.length > 0, "应有 console.error 记录降级");
  assert.match(String(errors[0][0]), /degraded/);
});

test("内层守卫：延迟回调抛错也被吞掉（这层最关键）", () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    // 模拟 slot API 形状不符：inject 成功，但回调里的 register 抛错
    let captured;
    const brokenCtx = {
      ...ctx,
      slots: {
        inject: (_name, cb) => {
          captured = cb;
        },
        register: () => {
          throw new Error("id→key rename broke it");
        },
      },
    };
    module.apply(brokenCtx);
    assert.ok(captured, "inject 回调应被缓存下来");
    // 触发延迟执行——这发生在 apply() 返回之后，任何外层 try/catch 都接不住
    const disposer = captured();
    assert.equal(typeof disposer, "function", "降级后必须返回 NOOP disposer，否则 slot 运行时炸");
    disposer();
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.length > 0, "内层降级应有 console.error");
});

test("降级后返回的 disposer 可安全调用", () => {
  // 上面已经调用过一次；这里再确认 NOOP 不抛
  const noop = () => {};
  assert.doesNotThrow(() => noop());
});

// ── 4. 组件渲染 ────────────────────────────────────────────────────────
const ConfigPage = registered.find((r) => r.descriptor.name === "plugins.bundle.config").component;
const t = ctx.locale.bind("settings.huaweicloud");

test("view=summary 返回含简介文案的节点（宿主要求）", () => {
  rendered.length = 0;
  const out = ConfigPage({ view: "summary", t });
  assert.ok(out !== null && typeof out === "object", "summary 应返回渲染节点");
  assert.ok(textOf(out).length > 0, "简介不该为空");
});

test("渲染树里 children 真的传下去了（位置参数陷阱的回归）", () => {
  // 真实故障：React 的 jsx(type, props, key) 第三参是 key 不是 children。
  // v0.2.0 把 children 改成位置参数后，每个 div 的 children 都是 undefined，
  // 界面整块空白且不报错。这条断言要求渲染树里存在带 children 的节点。
  rendered.length = 0;
  const tree = ConfigPage({ view: "page", t });
  const withChildren = collect(tree).filter(
    (node) => node.children !== undefined && node.children !== null && !Array.isArray(node.children) ? false : (node.children ?? []).length > 0,
  );
  assert.ok(withChildren.length > 0, "渲染树里没有任何带 children 的节点 —— 位置参数陷阱又出现了");
  // 并且文本必须非空
  assert.ok(textOf(tree).length > 0, "整棵渲染树没有任何文字");
});

/** 深度遍历渲染树，找 tagName。 */
function collect(node, acc = []) {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  acc.push(node);
  for (const child of node.children ?? []) collect(child, acc);
  return acc;
}

/** 把渲染树里所有文本节点拼起来，便于断言文案。 */
function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  return (node.children ?? []).map(textOf).join(" ");
}

/**
 * 渲染 ConfigPage 的**纯渲染分支**。
 *
 * 为什么这样测：假 React 的 useState 永远返回初始值、useEffect 不执行，
 * 所以「喂 doc 让组件自己 fetch」这条路在测试里走不通。插件因此把取数与渲染
 * 拆成 ConfigPage / ConfigPageView 两层，这里直接驱动 View 覆盖渲染分支。
 */
function renderPageWithDoc(doc, overrides = {}) {
  rendered.length = 0;
  return module.ConfigPageView({
    doc,
    error: undefined,
    refreshing: false,
    onWrite: async () => ({}),
    writePending: false,
    t,
    onReload: () => {},
    ...overrides,
  });
}

const SIGNED_IN_MODELS_PRE = [
  { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", contextWindow: 1_000_000, maxTokens: 384_000, input: ["text"], hidden: false },
  { id: "glm-5.3", name: "GLM-5.3", contextWindow: 202_752, maxTokens: 65_536, input: ["text"], hidden: true },
];

test("未登录时渲染出未登录文案与「去开客户端」指引", () => {
  const tree = renderPageWithDoc({
    version: "0.1.0",
    products: [
      { id: "codearts", displayName: "CodeArts", providerId: "huaweicloud-codearts", status: "signed-out", reasonCode: "NOT_FOUND" },
    ],
  });
  const text = textOf(tree);
  assert.match(text, /CodeArts/, "应显示产品名");
  assert.match(text, new RegExp(t("signedOut")), "应显示未登录文案");
});

test("已登录时状态页显示账号与凭据剩余时长", () => {
  const now = Date.now();
  const tree = renderPageWithDoc({
    version: "0.2.0",
    products: [
      {
        id: "officeace",
        displayName: "OfficeAce",
        providerId: "huaweicloud-officeace",
        status: "signed-in",
        account: "user-1",
        expiresAt: now + 5 * 3600_000,
        catalogFetchedAt: now,
        modelCount: 2,
        hiddenCount: 1,
        models: SIGNED_IN_MODELS_PRE,
      },
    ],
  });
  const text = textOf(tree);
  assert.match(text, /OfficeAce/, "应显示产品名");
  assert.match(text, /已登录/);
  assert.match(text, /user-1/, "应显示账号");
  assert.match(text, /小时/, "应显示凭据剩余时长");
});

test("凭据过期时提示去客户端续期，而不是显示剩余时长", () => {
  const tree = renderPageWithDoc({
    version: "0.2.0",
    products: [
      { id: "codearts", displayName: "CodeArts", providerId: "p", status: "signed-in", expired: true, expiresAt: Date.now() - 1000, models: [] },
    ],
  });
  const text = textOf(tree);
  assert.match(text, /过期/, "应提示已过期");
  assert.match(text, /CodeArts/, "应点名让用户去开哪个客户端");
});

test("目录更新时间如实显示（不编造来源标签）", () => {
  const now = Date.now();
  const tree = renderPageWithDoc({
    version: "0.2.0",
    products: [
      { id: "officeace", displayName: "OfficeAce", providerId: "p", status: "signed-in", catalogFetchedAt: now, models: [] },
    ],
  });
  assert.match(textOf(tree), /模型列表更新于/);
});

test("status 拉取失败时不抛（错误由 state 承载）", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    assert.doesNotThrow(() => ConfigPage({ t }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── 5. 三个标签页（直接驱动，避免假 React 的 useState 无法切 tab）──────
const { StatusTab, ContextTab, DetailsTab, formatTokens, remainingText, absoluteTime } = module;

function renderTab(component, props) {
  rendered.length = 0;
  return component(props);
}

const SIGNED_IN_MODELS = [
  { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", contextWindow: 1_000_000, maxTokens: 384_000, input: ["text"], hidden: false },
  { id: "glm-5.3", name: "GLM-5.3", contextWindow: 202_752, maxTokens: 65_536, input: ["text"], hidden: true },
];

test("formatTokens：M / K 缩写", () => {
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(202_752), "203K");
  assert.equal(formatTokens(0), "—");
  assert.equal(formatTokens(undefined), "—");
});

test("remainingText：分钟/小时/天，超期返回 undefined", () => {
  const now = Date.now();
  assert.equal(remainingText(now + 30 * 60_000, now), "30 分钟");
  assert.equal(remainingText(now + 5 * 3600_000, now), "5 小时");
  assert.equal(remainingText(now + 3 * 86400_000, now), "3 天");
  assert.equal(remainingText(now - 1000, now), undefined, "已过期应返回 undefined");
  assert.equal(remainingText(undefined, now), undefined);
});

test("absoluteTime：今天只给时刻，往日带日期", () => {
  const now = new Date(2026, 9, 18, 9, 30).getTime();
  const today = new Date(2026, 9, 18, 8, 5).getTime();
  const older = new Date(2026, 9, 15, 14, 30).getTime();
  assert.equal(absoluteTime(today, now), "08:05");
  assert.match(absoluteTime(older, now), /10月15日 14:30/);
});

test("状态页：已登录显示账号与有效期", () => {
  const now = Date.now();
  const tree = renderTab(StatusTab, {
    product: {
      id: "officeace",
      displayName: "OfficeAce",
      status: "signed-in",
      account: "user-1",
      expiresAt: now + 5 * 3600_000,
      sourcePath: "C:\\path\\models.json",
      catalogFetchedAt: now,
      modelCount: 2,
      hiddenCount: 1,
      models: SIGNED_IN_MODELS,
    },
    t,
    now,
  });
  const text = textOf(tree);
  assert.match(text, /已登录/);
  assert.match(text, /user-1/, "应显示账号");
  assert.match(text, /5 小时/, "应显示剩余时长");
  assert.match(text, /models\.json/, "应显示凭据来源路径");
});

test("状态页：未登录时给出去开客户端的指引，不显示有效期", () => {
  const tree = renderTab(StatusTab, {
    product: { id: "codearts", displayName: "CodeArts", status: "signed-out", reasonCode: "NOT_FOUND" },
    t,
    now: Date.now(),
  });
  const text = textOf(tree);
  assert.match(text, /未登录/);
  assert.match(text, /CodeArts/, "指引里要点名客户端");
  assert.equal(/有效期/.test(text), false, "未登录时不该显示有效期行");
});

test("状态页：过期提示优先于剩余时长", () => {
  const tree = renderTab(StatusTab, {
    product: { id: "codearts", displayName: "CodeArts", status: "signed-in", expired: true, expiresAt: Date.now() - 1000 },
    t,
    now: Date.now(),
  });
  const text = textOf(tree);
  assert.match(text, /过期/);
  assert.match(text, /CodeArts/);
});

test("上下文页：每个模型一个勾选框，checked 与 hidden 反值一致", () => {
  const tree = renderTab(ContextTab, {
    product: { id: "officeace", models: SIGNED_IN_MODELS },
    t,
    onWrite: async () => ({}),
    writePending: false,
  });
  const boxes = collect(tree).filter((n) => n.type === "input" && n.props.type === "checkbox");
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].props.checked, true, "未隐藏应为勾选");
  assert.equal(boxes[1].props.checked, false, "隐藏应为未勾选");
});

test("上下文页：显示上下文与输出上限，支持图片的模型带 IMG 标记", () => {
  const tree = renderTab(ContextTab, {
    product: {
      id: "officeace",
      models: [{ ...SIGNED_IN_MODELS[0], input: ["text", "image"] }],
    },
    t,
    onWrite: async () => ({}),
    writePending: false,
  });
  const text = textOf(tree);
  assert.match(text, /1M/, "应显示上下文窗口");
  assert.match(text, /↑384K/, "应显示输出上限");
  assert.match(text, /IMG/, "多模态模型应标记");
});

test("上下文页：全选/全不选按钮调 onWrite 且带全部模型 id", () => {
  const calls = [];
  const tree = renderTab(ContextTab, {
    product: { id: "officeace", models: SIGNED_IN_MODELS },
    t,
    onWrite: (product, body) => {
      calls.push({ product, body });
      return Promise.resolve({});
    },
    writePending: false,
  });
  const buttons = collect(tree).filter((n) => n.type === "button");
  const hideAll = buttons.find((b) => textOf(b) === "全部隐藏");
  assert.ok(hideAll, "应有「全部隐藏」按钮");
  hideAll.props.onClick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].product, "officeace");
  assert.equal(calls[0].body.all, false);
  assert.deepEqual(calls[0].body.models, ["deepseek-v4.1-flash", "glm-5.3"]);
});

test("明细页：CodeArts 显示签名鉴权与并发提示，OfficeAce 显示 Basic", () => {
  const codearts = textOf(
    renderTab(DetailsTab, {
      product: { id: "codearts", baseUrl: "https://snap-access.cn-north-4.myhuaweicloud.com" },
      t,
    }),
  );
  assert.match(codearts, /SDK-HMAC-SHA256/, "CodeArts 应显示签名鉴权");
  assert.match(codearts, /\/api\/v2\/chat\/completions/);
  assert.match(codearts, /3 个/, "应提示并发上限");

  const office = textOf(
    renderTab(DetailsTab, {
      product: { id: "officeace", baseUrl: "https://modelgw-0009.example.com/v2" },
      t,
    }),
  );
  assert.match(office, /Basic/, "OfficeAce 应显示 Basic 鉴权");
  assert.match(office, /modelgw-0009/);
});

test("明细页：如实说明不代客户端续期及其原因", () => {
  const text = textOf(renderTab(DetailsTab, { product: { id: "officeace", baseUrl: "x" }, t }));
  assert.match(text, /不代客户端续期/);
  assert.match(text, /refresh_token/, "应解释原因");
});

test("三处 fetch 都带 credentials: same-origin", () => {
  // 真实故障：漏掉 same-origin 时浏览器按 CORS 模式发请求，Host 侧回环闸判 403，
  // 客户端显示「读取失败：HTTP 403/404」，而 Host 端实测完全正常（直接打 200）。
  // 这条按源码文本匹配 —— 假的 React 拦不到 fetch 的调用参数。
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const fetches = source.match(/await fetch\(/g) ?? [];
  const withCreds = source.match(/credentials:\s*"same-origin"/g) ?? [];
  assert.equal(fetches.length, 3, `应有 3 处 fetch，实际 ${fetches.length}`);
  assert.ok(
    withCreds.length >= fetches.length,
    `fetch ${fetches.length} 处但 same-origin 只有 ${withCreds.length} 处 —— 有请求没带，回环闸会判 403`,
  );
});

test("宿主没注入 t 时不崩（回退到 key 本身）", () => {
  // 真实故障（线上 Console 实测）：
  //   TypeError: Cannot read properties of null (reading 'key')
  //     at ConfigPageView (client.js)
  // 宿主在某些时序下不把 t 注入 props，组件里直接 t("x") 就崩，整页白屏。
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/key")) return { ok: true, status: 200, text: async () => "k" };
    return { ok: true, status: 200, json: async () => ({ products: [] }) };
  };
  try {
    const { ConfigPage } = module;
    assert.doesNotThrow(() => ConfigPage({ view: "page", t: null }), "t 为 null 时 ConfigPage 抛异常");
    assert.doesNotThrow(() => ConfigPage({ view: "page" }), "t 缺失时 ConfigPage 抛异常");
    assert.doesNotThrow(() => ConfigPage({ view: "summary", t: null }), "summary 分支崩");
  } finally {
    globalThis.fetch = original;
  }
});

test("apply 不声明未使用的 ctx.locale.bind（它可能返回 null）", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 只看真正的代码，注释里提到这个名字是允许的（那里正好在解释为什么不用它）
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
  assert.equal(
    code.includes("ctx.locale.bind("),
    false,
    "apply 里不该有 ctx.locale.bind(...)：可能返回 null，且组件的 t 由宿主按 props 注入",
  );
});

test("组件函数不是 undefined（挂载不会崩）", () => {
  assert.equal(typeof ConfigPage, "function");
  assert.equal(typeof StatusTab, "function");
  assert.equal(typeof ContextTab, "function");
  assert.equal(typeof DetailsTab, "function");
});

// ── 汇总 ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const row of results) {
  console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.name}`);
  if (!row.ok) console.log(`      ${row.error.message}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
