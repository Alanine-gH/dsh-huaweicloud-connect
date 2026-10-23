/**
 * 离线自测：不依赖 DSH 内核，直接用 Node 跑。
 *
 *   node test/selftest.mjs
 *
 * 覆盖：APIG 签名规范化、请求体归一化、OfficeAce 凭据解析、凭据层状态机、
 * shim 的四道闸与 SSE 透传。
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";

import { canonicalUri, sdkDate, signRequest, sha256Hex, EMPTY_BODY_SHA256 } from "../lib/apig-sign.js";
import { normalizeChatBody, createShim } from "../lib/shim.js";
import { parseAuth } from "../lib/drivers/officeace.js";
import { CONTEXT_WINDOWS, IMAGE_MODELS, fallbackModels } from "../lib/drivers/codearts.js";
import { createCredentialStore } from "../lib/credentials.js";

const results = [];
function test(name, fn) {
  try {
    const value = fn();
    results.push({ name, ok: true });
    return value;
  } catch (error) {
    results.push({ name, ok: false, error });
    return undefined;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

// ── APIG 签名 ─────────────────────────────────────────────────────────────
test("canonicalUri 补尾斜杠", () => {
  assert.equal(canonicalUri("/api/v2/chat/completions"), "/api/v2/chat/completions/");
  assert.equal(canonicalUri("/v1/model/builtin/"), "/v1/model/builtin/");
  assert.equal(canonicalUri("/"), "/");
});

test("sdkDate 格式", () => {
  assert.equal(sdkDate(new Date(Date.UTC(2026, 9, 17, 6, 49, 54))), "20261017T064954Z");
});

test("空 body 哈希常量自洽", () => {
  assert.equal(sha256Hex(""), EMPTY_BODY_SHA256);
});

test("signRequest 产出合法 Authorization 且包含全部头", () => {
  const signed = signRequest({
    method: "POST",
    url: "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions",
    headers: { "Content-Type": "application/json", "X-Language": "zh-cn" },
    bodyText: JSON.stringify({ model: "GLM-5.2", messages: [] }),
    accessKey: "AKTEST",
    secretKey: "SKTEST",
    securityToken: "STSTEST",
    now: new Date(Date.UTC(2026, 9, 17, 6, 49, 54)),
  });
  assert.match(signed.authorization, /^SDK-HMAC-SHA256 Access=AKTEST, SignedHeaders=/);
  assert.match(signed.authorization, /Signature=[0-9a-f]{64}$/);
  const names = signed.signedHeaders.split(";");
  for (const required of ["content-type", "host", "x-language", "x-sdk-date", "x-security-token"]) {
    assert.ok(names.includes(required), `缺少签名头 ${required}: ${signed.signedHeaders}`);
  }
  // SignedHeaders 必须严格升序
  assert.deepEqual([...names].sort(), names);
  assert.equal(signed.payloadHash, sha256Hex(JSON.stringify({ model: "GLM-5.2", messages: [] })));
});

// ── 请求体归一化 ──────────────────────────────────────────────────────────
test("developer 角色降级为 system", () => {
  const out = normalizeChatBody({ messages: [{ role: "developer", content: "x" }, { role: "user", content: "y" }] });
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[1].role, "user");
});

test("tool_choice 对象形态压平", () => {
  assert.equal(normalizeChatBody({ tool_choice: { type: "function", function: { name: "f" } } }).tool_choice, "required");
  assert.equal(normalizeChatBody({ tool_choice: { type: "auto" } }).tool_choice, "auto");
  assert.equal(normalizeChatBody({ tool_choice: "none" }).tool_choice, "none");
});

test("dropEffort 剥离推理字段", () => {
  const out = normalizeChatBody({ reasoning_effort: "high", reasoning: { x: 1 }, thinking: { type: "enabled" } }, { dropEffort: true });
  assert.equal(out.reasoning_effort, undefined);
  assert.equal(out.reasoning, undefined);
  assert.equal(out.thinking, undefined);
});

test("不影响其它字段", () => {
  const body = { model: "m", stream: true, max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
  assert.deepEqual(normalizeChatBody(body), body);
});

// ── OfficeAce 凭据解析 ────────────────────────────────────────────────────
test("parseAuth 取 defaults[0] 的 baseUrl 与 Basic 头", () => {
  const doc = {
    defaults: [
      {
        model_name: "deepseek-v4.1-flash",
        model_client_config: {
          api_base: "https://modelgw-0009.officeace.cn-southwest-2.huaweicloud-agentarts.com/v2",
          api_key: "huawei-maas-session",
          custom_headers: { Authorization: "Basic ABCDEF" },
        },
      },
    ],
  };
  const parsed = parseAuth(JSON.stringify(doc));
  assert.equal(parsed.kind, "plaintext");
  assert.equal(parsed.token, "Basic ABCDEF");
  assert.equal(parsed.baseUrl, "https://modelgw-0009.officeace.cn-southwest-2.huaweicloud-agentarts.com/v2");
  assert.equal(parsed.modelName, "deepseek-v4.1-flash");
});

test("parseAuth 遇到坏数据不抛、返回 unrecognized", () => {
  assert.equal(parseAuth("not json").kind, "unrecognized");
  assert.equal(parseAuth(JSON.stringify({ defaults: [{}] })).kind, "unrecognized");
});

// ── 凭据层状态机 ──────────────────────────────────────────────────────────
await testAsync("凭据层：无文件 → 未登录（undefined，不抛）", async () => {
  const store = createCredentialStore({
    product: "t",
    displayName: "T",
    envOverride: "HUAWEI_TEST_NOPE",
    candidates: async () => ["/nonexistent/definitely/missing.json"],
    parseAuth: () => ({ kind: "unrecognized" }),
    persistCopy: false,
  });
  assert.equal(await store.resolve(), undefined);
});

await testAsync("凭据层：明文可用 → 返回凭据", async () => {
  const store = createCredentialStore({
    product: "t",
    displayName: "T",
    envOverride: "HUAWEI_TEST_NOPE",
    candidates: async () => ["/virtual/creds.json"],
    parseAuth: () => ({ kind: "unrecognized" }),
    readCredential: async () => ({ token: "Basic XYZ", baseUrl: "https://example.test/v2" }),
    persistCopy: false,
  });
  const credential = await store.resolve();
  assert.equal(credential.token, "Basic XYZ");
  assert.equal(store.status().signedIn, true);
});

await testAsync("凭据层：已过期且无刷新 → 抛 EXPIRED_NO_REFRESH", async () => {
  const store = createCredentialStore({
    product: "t",
    displayName: "T",
    envOverride: "HUAWEI_TEST_NOPE",
    candidates: async () => ["/virtual/creds.json"],
    parseAuth: () => ({ kind: "unrecognized" }),
    readCredential: async () => ({ token: "tok", expiresAt: Date.now() - 1000 }),
    persistCopy: false,
  });
  await assert.rejects(() => store.resolve(), (error) => error.code === "EXPIRED_NO_REFRESH");
  // allowExpired 时应放行
  const expired = await store.resolve({ allowExpired: true });
  assert.equal(expired.token, "tok");
});

// ── shim 端到端 ───────────────────────────────────────────────────────────
await testAsync("shim：四道闸 + SSE 透传", async () => {
  const seen = { bodies: [] };
  const shim = createShim({
    dispatch: async ({ body }) => {
      seen.bodies.push(body);
      return {
        status: 200,
        headers: {},
        stream: (async function* () {
          yield 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
          yield "data: [DONE]\n\n";
        })(),
      };
    },
    listModels: async () => [{ id: "m1" }],
  });
  await shim.ready;
  const base = shim.baseUrl();
  const token = shim.token();

  // 闸 3：错 Bearer
  const denied = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: JSON.stringify({ model: "m1", messages: [] }),
  });
  assert.equal(denied.status, 401);

  // 闸 4：错 Content-Type
  const wrongType = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "text/plain", authorization: `Bearer ${token}` },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);

  // 正常流：developer 被改写
  const ok = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "m1", messages: [{ role: "developer", content: "d" }, { role: "user", content: "u" }] }),
  });
  assert.equal(ok.status, 200);
  const text = await ok.text();
  assert.match(text, /data: \{"choices"/);
  assert.match(text, /data: \[DONE\]/);
  assert.equal(seen.bodies[0].messages[0].role, "system");

  // /v1/models
  const models = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data[0].id, "m1");

  shim.close();
});

await testAsync("shim：上游没给 [DONE] 时补一个", async () => {
  const shim = createShim({
    dispatch: async () => ({
      status: 200,
      headers: {},
      stream: (async function* () {
        yield 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n';
      })(),
    }),
  });
  await shim.ready;
  const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${shim.token()}` },
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  const text = await response.text();
  assert.match(text, /data: \[DONE\]\s*$/);
  shim.close();
});

// ── CodeArts 模型目录：直读上游 ───────────────────────────────────────
// 这组断言的目的是**防止回退**。2026-10-23 实测：`/v1/model/builtin` 返回
// 9 个真实模型（含 GLM-5.2、kimi-k3、glm-5.2-sft-harmony），而旧版写死的
// 7 个里有 3 个（deepseek-v4-flash-0731 / deepseek-v4-pro-0813 / glm-5.3-flash）
// 在目录里根本不存在——是"幽灵模型"。listModels 现在直读目录，不再写死。
test("CONTEXT_WINDOWS 覆盖目录里所有 display_enabled 的模型", () => {
  // 2026-10-23 实测的目录快照（display_enabled=true 的 7 个）
  const displayModels = [
    "GLM-5.2",
    "openpangu-2.0-flash",
    "openpangu-2.0-pro",
    "glm-5.3",
    "glm-5.2-sft-harmony",
    "deepseek-v4.1-flash",
    "kimi-k3",
  ];
  for (const id of displayModels) {
    assert.ok(CONTEXT_WINDOWS[id] !== undefined, `${id} 缺上下文窗口记录（目录里有这个模型）`);
  }
});

test("图片模型集合覆盖目录里 supports_images=true 的两个", () => {
  // Qwen3-VL-235B / kimi-k2.6-vl 在目录里 enable=true 但 display_enabled=false；
  // 它们由 toModelInfo 的 IMAGE_MODELS 集合处理，这里锁住集合本身
  assert.ok(IMAGE_MODELS.has("Qwen3-VL-235B"));
  assert.ok(IMAGE_MODELS.has("kimi-k2.6-vl"));
});

test("兜底目录只给已验证的模型", () => {
  assert.equal(fallbackModels.length, 1);
  assert.equal(fallbackModels[0].id, "deepseek-v4.1-flash");
});

test("上下文窗口记录都是正数且 output ≤ context", () => {
  for (const [id, limits] of Object.entries(CONTEXT_WINDOWS)) {
    assert.ok(limits.context > 0, `${id} context 非法`);
    assert.ok(limits.output > 0, `${id} output 非法`);
    assert.ok(limits.output <= limits.context, `${id} output 大于 context`);
  }
});

// ── 汇总 ──────────────────────────────────────────────────────────────────
const failed = results.filter((row) => !row.ok);
for (const row of results) {
  console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.name}`);
  if (!row.ok) console.log(`      ${String(row.error?.message ?? row.error)}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
