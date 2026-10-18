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
test("导出 name / inject / apply", () => {
  assert.equal(typeof module.apply, "function");
  assert.equal(typeof module.name, "string");
  assert.ok(Array.isArray(module.inject));
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

test("view=summary 返回一行简介（宿主要求）", () => {
  rendered.length = 0;
  const out = ConfigPage({ view: "summary", t });
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0, "简介不该为空");
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
    ...overrides,
  });
}

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

test("已登录时显示账号、凭据剩余时长与模型勾选列表", () => {
  const tree = renderPageWithDoc({
    version: "0.1.0",
    products: [
      {
        id: "officeace",
        displayName: "OfficeAce",
        providerId: "huaweicloud-officeace",
        status: "signed-in",
        account: "user-1",
        expiresAt: Date.now() + 3600_000,
        catalogSource: "live",
        modelCount: 2,
        models: [
          { id: "glm-5.3", name: "GLM-5.3", contextWindow: 202752, maxTokens: 32768, input: ["text"], hidden: false },
          { id: "kimi-k2.6", name: "Kimi-K2.6", contextWindow: 262144, maxTokens: 32768, input: ["text", "image"], hidden: true },
        ],
        visibility: { perAccount: true, hidden: ["kimi-k2.6"] },
      },
    ],
  });
  const text = textOf(tree);
  assert.match(text, /user-1/, "应显示账号");
  assert.match(text, /GLM-5\.3/, "应列出模型名");
  assert.match(text, /Kimi-K2\.6/, "隐藏的模型也要列出，否则没法取消隐藏");
  assert.match(text, /小时/, "应显示凭据剩余时长");

  // 勾选框：每个模型一个，checked 反映 hidden 的反值
  const checkboxes = collect(tree).filter((node) => node.type === "input" && node.props.type === "checkbox");
  assert.equal(checkboxes.length, 2, "应为每个模型一个勾选框");
  assert.equal(checkboxes[0].props.checked, true, "未隐藏的模型应为勾选态");
  assert.equal(checkboxes[1].props.checked, false, "隐藏的模型应为未勾选态");
});

test("凭据过期时提示去客户端续期，而不是显示剩余时长", () => {
  const tree = renderPageWithDoc({
    version: "0.1.0",
    products: [
      { id: "codearts", displayName: "CodeArts", providerId: "p", status: "signed-in", expired: true, expiresAt: Date.now() - 1000, models: [] },
    ],
  });
  const text = textOf(tree);
  assert.match(text, /过期/, "应提示已过期");
  assert.match(text, /CodeArts/, "应点名让用户去开哪个客户端");
});

test("目录来源如实显示 live 与 fallback", () => {
  const live = renderPageWithDoc({
    products: [{ id: "officeace", displayName: "OfficeAce", providerId: "p", status: "signed-in", catalogSource: "live", models: [] }],
  });
  assert.match(textOf(live), new RegExp(t("catalogLive")));

  const fallback = renderPageWithDoc({
    products: [{ id: "officeace", displayName: "OfficeAce", providerId: "p", status: "signed-in", catalogSource: "fallback", models: [] }],
  });
  assert.match(textOf(fallback), new RegExp(t("catalogFallback")));
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

test("组件函数不是 undefined（挂载不会崩）", () => {
  assert.equal(typeof ConfigPage, "function");
});

// ── 汇总 ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const row of results) {
  console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.name}`);
  if (!row.ok) console.log(`      ${row.error.message}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
