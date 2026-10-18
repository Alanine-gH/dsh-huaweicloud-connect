/**
 * Host Web 路由的离线测试：把 handler 挂到裸 http server 上，不依赖 DSH。
 *
 *   node test/web-selftest.mjs
 *
 * 覆盖：回环闸、只读/写分离、probeKey 校验、status 文档形状、显隐写入后
 * 模型选择器确实变化。
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离 DSH_HOME：测试绝不能写用户的 ~/.dsh
const home = await mkdtemp(join(tmpdir(), "hc-webtest-"));
process.env.DSH_HOME = home;

const { createVisibilityStore } = await import("../lib/visibility.js");
const { createStatusHandler, createVisibilityHandler, createKeyHandler, createProbeKey, STATUS_PATH, VISIBILITY_PATH, KEY_PATH } =
  await import("../lib/web.js");
// 伪造 Host/Origin 必须走裸 socket：WHATWG fetch 会重写 Host 头，那样测回环闸是假阳性
const { rawRequest } = await import("./raw-http.mjs");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

// ── 假运行时 ────────────────────────────────────────────────────────────
function fakeRuntime(product, { signedIn = true, models = [], hidden = [] } = {}) {
  const visibility = createVisibilityStore({ product });
  const state = { models, invalidated: 0 };
  const driver = { product, displayName: product === "codearts" ? "CodeArts" : "OfficeAce", providerId: `huaweicloud-${product}` };
  return {
    driver,
    state,
    visibility,
    invalidate: () => {
      state.invalidated += 1;
    },
    account: () => (signedIn ? "acct-1" : undefined),
    /**
     * 关键：hidden 必须**从真实 visibility store 读**，不能维护一份影子状态，
     * 否则「写路由写了 store、status 却读影子」的差异会被测试漏掉。
     */
    async snapshot() {
      const hiddenIds = new Set(await visibility.hidden(signedIn ? "acct-1" : undefined));
      return {
        store: signedIn
          ? { signedIn: true, account: "acct-1", sourcePath: `/fake/${product}`, expiresAt: Date.now() + 3600_000 }
          : { signedIn: false, reasonCode: "NOT_FOUND", reason: "未找到登录态" },
        catalog: {
          visible: models.map((m) => ({ ...m, hidden: hiddenIds.has(m.id) })),
          total: models.length,
          hiddenCount: models.filter((m) => hiddenIds.has(m.id)).length,
          source: "live",
        },
        visibility: await visibility.describe(signedIn ? "acct-1" : undefined),
        account: signedIn ? "acct-1" : undefined,
      };
    },
  };
}

const MODELS = [
  { id: "glm-5.3", name: "GLM-5.3", contextWindow: 202752, maxTokens: 32768, input: ["text"] },
  { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", contextWindow: 1000000, maxTokens: 32768, input: ["text"] },
];

// ── 起一个裸 server 承载 handler ────────────────────────────────────────
const runtimes = [fakeRuntime("officeace", { models: MODELS }), fakeRuntime("codearts", { signedIn: false })];
const probeKey = createProbeKey();
const routes = {
  // status 也要拿到 probeKey：它用它的存在性告诉客户端「写路由可用」
  [STATUS_PATH]: createStatusHandler({ runtimes: () => runtimes, version: "0.1.0", probeKey }),
  [VISIBILITY_PATH]: createVisibilityHandler({ runtimes: () => runtimes, probeKey }),
  [KEY_PATH]: createKeyHandler({ probeKey }),
};

const server = createServer(async (req, res) => {
  const handler = routes[req.url];
  if (handler === undefined) {
    res.writeHead(404).end();
    return;
  }
  await handler(req, res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** 发请求（正常路径用 fetch）。loopback 默认 true；外部 Host 用 raw 模拟。 */
function call(path, { method = "GET", key, host = "127.0.0.1", origin, body } = {}) {
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  if (key !== undefined) headers["x-huaweicloud-connect-key"] = key;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** 伪造 Host / Origin 的请求必须走裸 socket。 */
function spoof(path, { method = "GET", key, host, origin, body } = {}) {
  const headers = {};
  if (host !== undefined) headers.host = host;
  if (origin !== undefined) headers.origin = origin;
  if (key !== undefined) headers["x-huaweicloud-connect-key"] = key;
  if (body !== undefined) headers["content-type"] = "application/json";
  return rawRequest({
    port: server.address().port,
    path,
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// ── 1. status ───────────────────────────────────────────────────────────
let statusDoc;

await test("GET /status 返回 200 与版本号", async () => {
  const res = await call(STATUS_PATH);
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.equal(doc.version, "0.1.0");
  assert.ok(Array.isArray(doc.products));
});

await test("status 下发两个产品，各带 id/displayName/providerId", async () => {
  statusDoc = await (await call(STATUS_PATH)).json();
  assert.equal(statusDoc.products.length, 2);
  const office = statusDoc.products.find((p) => p.id === "officeace");
  assert.equal(office.providerId, "huaweicloud-officeace");
  assert.equal(office.status, "signed-in");
  const code = statusDoc.products.find((p) => p.id === "codearts");
  assert.equal(code.status, "signed-out");
  assert.ok(code.reasonCode, "未登录应带 reasonCode");
});

await test("status 不泄露凭据值", async () => {
  const text = JSON.stringify(statusDoc);
  assert.equal(/Basic\s+[A-Za-z0-9+/=]{10,}/.test(text), false, "泄露了 Authorization 头");
  assert.equal(/HSTA9E|securityToken|secretKey/.test(text), false, "泄露了 CodeArts 密钥字段名");
});

await test("status 里模型带 hidden 标记", async () => {
  const office = statusDoc.products.find((p) => p.id === "officeace");
  assert.equal(office.models.length, 2);
  assert.equal(office.models[0].hidden, false);
  assert.equal(office.catalogSource, "live");
});

await test("status 下发 visibility 供客户端渲染勾选框", async () => {
  const office = statusDoc.products.find((p) => p.id === "officeace");
  assert.equal(office.visibility.perAccount, true);
  assert.deepEqual(office.visibility.hidden, []);
});

// ── 2. 回环闸 ───────────────────────────────────────────────────────────
await test("非回环 Host 被拒（403）", async () => {
  const res = await spoof(STATUS_PATH, { host: "evil.example.com" });
  assert.equal(res.status, 403);
  assert.match(res.body, /request-not-trusted/);
});

await test("非回环 Origin 被拒（403）", async () => {
  const res = await spoof(STATUS_PATH, { origin: "https://evil.example.com" });
  assert.equal(res.status, 403);
});

await test("DNS-rebinding 形态的 Host 被拒", async () => {
  // 攻击者控制的域名解析到 127.0.0.1，但 Host 头仍是他的域名
  const res = await spoof(STATUS_PATH, { host: "attacker.example.com" });
  assert.equal(res.status, 403);
});

await test("回环 Origin 通过", async () => {
  const res = await call(STATUS_PATH, { origin: `http://127.0.0.1:${server.address().port}` });
  assert.equal(res.status, 200);
});

await test("非 GET 打到 status 返回 405", async () => {
  const res = await call(STATUS_PATH, { method: "POST", body: {} });
  assert.equal(res.status, 405);
});

// ── 3. key 端点 ────────────────────────────────────────────────────────
await test("GET /key 返回纯文本 key", async () => {
  const res = await call(KEY_PATH);
  assert.equal(res.status, 200);
  // 注意用 Headers.get()：fetch 的 headers 不是普通对象，不能用 [] 索引
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  const text = await res.text();
  assert.equal(text, probeKey());
});

await test("key 不出现在 status body 里", async () => {
  const body = await (await call(STATUS_PATH)).text();
  assert.equal(body.includes(probeKey()), false, "key 泄进了 status body");
  // body 里只能有 hasProbeKey 这种布尔标记
  assert.equal(JSON.parse(body).hasProbeKey, true);
});

await test("key 端点非回环 Host 被拒", async () => {
  const res = await spoof(KEY_PATH, { host: "evil.example.com" });
  assert.equal(res.status, 403);
});

await test("key 端点非 GET 返回 405", async () => {
  const res = await call(KEY_PATH, { method: "POST", body: {} });
  assert.equal(res.status, 405);
});

// ── 4. 写路由的 key 校验 ────────────────────────────────────────────────
await test("写路由缺 key 被拒（401）", async () => {
  const res = await call(VISIBILITY_PATH, { method: "POST", body: { product: "officeace", modelId: "glm-5.3", visible: false } });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "invalid-key");
});

await test("写路由错 key 被拒（401）", async () => {
  const res = await call(VISIBILITY_PATH, { method: "POST", key: "wrong", body: { product: "officeace", modelId: "glm-5.3", visible: false } });
  assert.equal(res.status, 401);
});

await test("写路由即使 key 对，非回环 Host 仍被拒（403）", async () => {
  const res = await spoof(VISIBILITY_PATH, {
    method: "POST",
    key: probeKey(),
    host: "evil.example.com",
    body: { product: "officeace", modelId: "glm-5.3", visible: false },
  });
  assert.equal(res.status, 403);
});

await test("写路由非 POST 返回 405", async () => {
  const res = await call(VISIBILITY_PATH, { key: probeKey() });
  assert.equal(res.status, 405);
});

// ── 4. 显隐写入 ────────────────────────────────────────────────────────
await test("隐藏一个模型成功，返回 hidden 列表", async () => {
  const res = await call(VISIBILITY_PATH, {
    method: "POST",
    key: probeKey(),
    body: { product: "officeace", modelId: "glm-5.3", visible: false },
  });
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.deepEqual(doc.hidden, ["glm-5.3"]);
});

await test("隐藏后 status 反映 hidden=true 与 hiddenCount", async () => {
  const doc = await (await call(STATUS_PATH)).json();
  const office = doc.products.find((p) => p.id === "officeace");
  const glm = office.models.find((m) => m.id === "glm-5.3");
  assert.equal(glm.hidden, true);
  assert.equal(office.hiddenCount, 1);
  assert.deepEqual(office.visibility.hidden, ["glm-5.3"]);
});

await test("写入后触发 invalidate（模型选择器会重读）", async () => {
  assert.ok(runtimes[0].state.invalidated > 0, "没有触发 invalidate");
});

await test("再次隐藏同一模型幂等", async () => {
  const res = await call(VISIBILITY_PATH, {
    method: "POST",
    key: probeKey(),
    body: { product: "officeace", modelId: "glm-5.3", visible: false },
  });
  assert.deepEqual((await res.json()).hidden, ["glm-5.3"]);
});

await test("重新显示后从 hidden 移除", async () => {
  const res = await call(VISIBILITY_PATH, {
    method: "POST",
    key: probeKey(),
    body: { product: "officeace", modelId: "glm-5.3", visible: true },
  });
  assert.deepEqual((await res.json()).hidden, []);
  const doc = await (await call(STATUS_PATH)).json();
  assert.equal(doc.products.find((p) => p.id === "officeace").models.find((m) => m.id === "glm-5.3").hidden, false);
});

await test("批量全不选", async () => {
  const res = await call(VISIBILITY_PATH, {
    method: "POST",
    key: probeKey(),
    body: { product: "officeace", all: false, models: ["glm-5.3", "deepseek-v4.1-flash"] },
  });
  assert.deepEqual((await res.json()).hidden.sort(), ["deepseek-v4.1-flash", "glm-5.3"]);
});

await test("批量全选", async () => {
  const res = await call(VISIBILITY_PATH, {
    method: "POST",
    key: probeKey(),
    body: { product: "officeace", all: true, models: [] },
  });
  assert.deepEqual((await res.json()).hidden, []);
});

await test("未知 product 返回 404", async () => {
  const res = await call(VISIBILITY_PATH, { method: "POST", key: probeKey(), body: { product: "nope", modelId: "x" } });
  assert.equal(res.status, 404);
});

await test("缺 product 返回 400", async () => {
  const res = await call(VISIBILITY_PATH, { method: "POST", key: probeKey(), body: { modelId: "x" } });
  assert.equal(res.status, 400);
});

await test("坏 JSON 返回 400", async () => {
  const res = await fetch(`${base}${VISIBILITY_PATH}`, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", "x-huaweicloud-connect-key": probeKey() },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});

// ── 5. 显隐存储：按账号隔离 ─────────────────────────────────────────────
await test("显隐按账号分桶，A 账号设置不影响 B 账号", async () => {
  const store = createVisibilityStore({ product: "acct-test" });
  await store.set("acct-A", "m1", false);
  assert.deepEqual(await store.hidden("acct-A"), ["m1"]);
  assert.deepEqual(await store.hidden("acct-B"), [], "B 账号不该看到 A 的隐藏项");
  await store.clear();
});

await test("显隐对未登录落到 shared 桶", async () => {
  const store = createVisibilityStore({ product: "acct-test2" });
  await store.set(undefined, "m9", false);
  assert.deepEqual(await store.hidden(undefined), ["m9"]);
  await store.clear();
});

await test("显隐可关闭按账号区分并合并到共享桶", async () => {
  const store = createVisibilityStore({ product: "acct-test3" });
  await store.set("acct-A", "m1", false);
  await store.setPerAccount(false, "acct-A");
  const described = await store.describe("acct-A");
  assert.equal(described.perAccount, false);
  assert.ok(described.hidden.includes("m1"), "切到共享桶时应保留原有隐藏项");
  await store.clear();
});

await test("显隐过滤掉非法 id（空串/超长/非字符串）", async () => {
  const store = createVisibilityStore({ product: "acct-test4" });
  await store.replace(undefined, ["ok", "", "x".repeat(300), 123, "ok"], false);
  assert.deepEqual(await store.hidden(undefined), ["ok"]);
  await store.clear();
});

// ── 收尾 ────────────────────────────────────────────────────────────────
await new Promise((resolve) => server.close(resolve));
await rm(home, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
for (const row of results) {
  console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.name}`);
  if (!row.ok) console.log(`      ${row.error.message}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
