/**
 * 推理档位模块的离线测试。
 *
 *   node test/reasoning-selftest.mjs
 *
 * 覆盖三块：
 *   1. thinkingLevelMap 构造（含 none→off 的翻译）
 *   2. 三段隔离探测算法（baseline / sentinel / 逐档扫描）
 *   3. 缓存（指纹失效、按账号分桶、原子写）
 *
 * 探测算法是纯函数（send 是注入的），所以不必发真实请求。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const m = await import("../lib/reasoning.js");

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
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

// ── 1. thinkingLevelMap ────────────────────────────────────────────────
test("buildThinkingLevelMap：none 翻译成 off", () => {
  const map = m.buildThinkingLevelMap(["none", "low", "high"]);
  assert.equal(map.off, "off", "上游 none 应映射到 pi 的 off");
  assert.equal(map.low, "low");
  assert.equal(map.high, "high");
  assert.equal(map.medium, null, "未支持的层级必须是 null，不能省略");
  assert.equal(map.max, null);
});

test("buildThinkingLevelMap：minimal 永远给 null（照 workbuddy 的实测决定）", () => {
  // pi-ai 认 minimal 这个层级，但 DSH 选择器对它的处理与其它档不同。
  // workbuddy 实测后决定一律不开（reasoningFields 里 minimal: null）。
  const map = m.buildThinkingLevelMap(["none", "minimal", "low", "high", "max"]);
  assert.equal(map.minimal, null, "minimal 必须为 null，否则档位控件可能整体渲染失败");
  assert.equal(map.off, "off");
  assert.equal(map.low, "low");
});

test("buildThinkingLevelMap：上游拒绝 none 时 off 必须是 null", () => {
  // glm-5.3 实测明确回「该模型始终思考，不支持关闭思考」→ 不能给 off
  const map = m.buildThinkingLevelMap(["low", "high", "max"]);
  assert.equal(map.off, null, "上游不支持关闭思考时给 off，等于给一个会被拒的选项");
  assert.equal(map.low, "low");
  assert.equal(map.max, "max");
});

test("buildThinkingLevelMap：空集合全 null", () => {
  const map = m.buildThinkingLevelMap([]);
  assert.equal(Object.values(map).every((v) => v === null), true);
});

test("buildThinkingLevelMap：实测矩阵 glm-5.3 只给 low/high/max", () => {
  // 这是真实实测结果：glm-5.3 拒绝 none/medium/xhigh，只接受 low/high/max
  const map = m.buildThinkingLevelMap(["low", "high", "max"]);
  assert.equal(map.low, "low");
  assert.equal(map.high, "high");
  assert.equal(map.max, "max");
  assert.equal(map.medium, null);
  assert.equal(map.off, null, "glm 系列不支持关闭思考");
});

// ── 2. 探测算法 ────────────────────────────────────────────────────────
const ACCEPT = { status: 200, head: 'data: {"choices":[{"delta":{}}]}' };
const REJECT = {
  status: 200,
  head: 'data:{"error":{"code":"ModelArts.81001","message":"parameter check failed, reasoning_effort must be none or low or medium or high or xhigh or max"}}',
};
const RATE_LIMIT = { status: 200, head: 'data:{"error":{"code":"ModelArts.81101","message":"Too many requests"}}' };

/** 造一个按"支持的档位集合"作答的 send。 */
function senderFor(supported, { baselineOk = true, sentinelAccepts = false, rateLimitOn = [] } = {}) {
  return async (effort) => {
    if (rateLimitOn.includes(effort)) return RATE_LIMIT;
    if (effort === undefined) return baselineOk ? ACCEPT : REJECT;
    if (sentinelAccepts) return ACCEPT; // 不校验该参数
    if (effort.startsWith("probe_sentinel_")) return REJECT;
    return supported.includes(effort) ? ACCEPT : REJECT;
  };
}

await testAsync("探测：正常模型返回实测支持的档位", async () => {
  const out = await m.probeModel({ send: senderFor(["low", "high", "max"]), sentinel: () => "probe_sentinel_test" });
  assert.equal(out.validation, "validating");
  assert.deepEqual(out.efforts, ["low", "high", "max"]);
  assert.equal(out.requests, 1 + 1 + m.EFFORT_CANDIDATES.length, "baseline + sentinel + 全档扫描");
});

await testAsync("探测：baseline 失败 → unknown，不归因于档位", async () => {
  const out = await m.probeModel({ send: senderFor([], { baselineOk: false }), sentinel: () => "probe_sentinel_test" });
  assert.equal(out.validation, "unknown");
  assert.deepEqual(out.efforts, []);
  assert.equal(out.requests, 1, "baseline 失败就该停，不该继续扫");
});

await testAsync("探测：上游不校验参数 → non-validating，不给控制项", async () => {
  // 这是关键防护：上游接受任何值，逐档"接受"全是假阳性
  const out = await m.probeModel({ send: senderFor([], { sentinelAccepts: true }), sentinel: () => "probe_sentinel_test" });
  assert.equal(out.validation, "non-validating");
  assert.deepEqual(out.efforts, []);
  assert.equal(out.requests, 2, "baseline + sentinel 就该停");
});

await testAsync("探测：中途限流 → unknown，不写半截结果", async () => {
  const out = await m.probeModel({
    send: senderFor(["low"], { rateLimitOn: ["medium"] }),
    sentinel: () => "probe_sentinel_test",
  });
  assert.equal(out.validation, "unknown");
  assert.deepEqual(out.efforts, [], "限流干扰下不能给出半截档位表");
});

await testAsync("探测：全档支持", async () => {
  const out = await m.probeModel({
    send: senderFor(m.EFFORT_CANDIDATES),
    sentinel: () => "probe_sentinel_test",
  });
  assert.equal(out.validation, "validating");
  assert.deepEqual(out.efforts, m.EFFORT_CANDIDATES);
});

await testAsync("探测：传输异常算 unknown", async () => {
  const out = await m.probeModel({
    send: async () => {
      throw new Error("ECONNRESET");
    },
    sentinel: () => "probe_sentinel_test",
  });
  assert.equal(out.validation, "unknown");
});

// ── 3. classifyAttempt ─────────────────────────────────────────────────
test("classifyAttempt：点名 reasoning_effort 的拒绝 → reject-effort", () => {
  assert.equal(m.classifyAttempt(200, REJECT.head), "reject-effort");
  assert.equal(
    m.classifyAttempt(400, '{"error":{"message":"该模型始终思考，不支持关闭思考；请使用 low、high 或 max。"}}'),
    "reject-effort",
    "中文拒绝信息也要认",
  );
});

test("classifyAttempt：限流/鉴权/未知模型 → unknown（不能当能力结论）", () => {
  assert.equal(m.classifyAttempt(200, RATE_LIMIT.head), "unknown");
  assert.equal(m.classifyAttempt(401, "APIG.0301 auth failed"), "unknown");
  assert.equal(m.classifyAttempt(200, '{"error":{"code":"ModelArts.81102","message":"unknown model"}}'), "unknown");
});

test("classifyAttempt：正常 SSE → accept", () => {
  assert.equal(m.classifyAttempt(200, ACCEPT.head), "accept");
  assert.equal(m.classifyAttempt(0, ""), "unknown", "传输失败是 unknown");
});

test("classifyAttempt：CodeArts 并发上限 → unknown（实测踩过的坑）", () => {
  // 真实故障：CodeArts 客户端开着时占满 3 个免费并发槽，探测请求全被拒：
  //   TM.00001041 并发会话数已达上限(3个)，请关闭部分会话后重试。
  // 早期版本没识别它 → sentinel 也被「拒绝」→ 误判 non-validating →
  // 一票否决后 CodeArts 所有模型永远拿不到档位。
  const concurrent = '{"error_code":"TM.00001041","error_msg":"并发会话数已达上限(3个)，请关闭部分会话后重试。"}';
  assert.equal(m.classifyAttempt(400, concurrent), "unknown", "并发上限不能当成「上游拒绝该档位」");
});

await testAsync("探测：baseline 撞并发上限 → unknown，不误判 non-validating", async () => {
  const concurrent = { status: 400, head: '{"error_code":"TM.00001041","error_msg":"并发会话数已达上限(3个)"}' };
  const out = await m.probeModel({
    send: async () => concurrent,
    sentinel: () => "probe_sentinel_test",
  });
  assert.equal(out.validation, "unknown", "并发占满时必须判 unknown，否则会污染缓存");
  assert.deepEqual(out.efforts, []);
});

test("classifyAttempt：模型下线/无渠道 → unknown（不可与档位拒绝混淆）", () => {
  // 实测：OfficeAce 的 glm-5.2-zx / glm-5.2-harmony / glm.5.2-arkts-spark
  // baseline 就 403/404，属于模型本身不可用，与"支不支持思考强度"无关。
  assert.equal(m.classifyAttempt(404, '{"error":{"code":"ModelArts.81009","message":"Invalid model."}}'), "unknown");
  assert.equal(m.classifyAttempt(403, '{"error":{"code":"ModelArts.81010","message":"No available channel"}}'), "unknown");
});

await testAsync("探测：baseline 就是 403/404 → unknown，不留半截结论", async () => {
  const out = await m.probeModel({
    send: async () => ({ status: 404, head: '{"error":{"code":"ModelArts.81009","message":"Invalid model."}}' }),
    sentinel: () => "probe_sentinel_test",
  });
  assert.equal(out.validation, "unknown");
  assert.equal(out.requests, 1, "baseline 失败就该停，不该继续扫");
  assert.match(String(out.reason ?? ""), /baseline 404/);
});

// ── 4. 缓存 ────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "hc-probe-"));
const file = join(dir, "probes.json");

test("缓存：写入后可读回", () => {
  const store = m.createProbeStore({ file });
  const model = { id: "glm-5.3", contextWindow: 202752, maxTokens: 32768, reasoning: true };
  store.set("officeace", "acct-1", model, "validating", ["low", "high", "max"]);
  const back = store.get("officeace", "acct-1", model);
  assert.equal(back.validation, "validating");
  assert.deepEqual(back.efforts, ["low", "high", "max"]);
});

test("缓存：模型指纹变化后视为未探测", () => {
  const store = m.createProbeStore({ file });
  const model = { id: "glm-5.3", contextWindow: 202752, maxTokens: 32768, reasoning: true };
  assert.ok(store.get("officeace", "acct-1", model) !== undefined, "前置：应有记录");
  // contextWindow 变了 → 能力声明可能也变了，必须重探
  const changed = { ...model, contextWindow: 100000 };
  assert.equal(store.get("officeace", "acct-1", changed), undefined, "指纹不同应视为没有记录");
});

test("缓存：按账号分桶，互不影响", () => {
  const store = m.createProbeStore({ file });
  const model = { id: "glm-5.3", contextWindow: 202752, maxTokens: 32768, reasoning: true };
  store.set("officeace", "acct-2", model, "validating", ["low"]);
  assert.deepEqual(store.get("officeace", "acct-2", model).efforts, ["low"]);
  assert.deepEqual(store.get("officeace", "acct-1", model).efforts, ["low", "high", "max"], "acct-1 的记录不该被覆盖");
});

test("缓存：落盘是合法 JSON（原子写）", () => {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(typeof doc.version, "number");
  assert.ok(doc.version >= 2, "缓存格式版本：改判定逻辑时必须提升");
  assert.equal(typeof doc.buckets, "object");
});

test("缓存：版本号过期时整体作废（判定逻辑变了就不能信旧结论）", () => {
  // 真实故障：v0.7.1 把 CodeArts 并发上限误判成 non-validating 并写缓存；
  // v0.7.2 修好了逻辑，但旧缓存指纹没变，新代码读到就认为「已探测」而跳过
  // —— 误判永久生效。缓存版本号就是为此存在：提升后旧缓存整体作废。
  const stale = join(dir, "stale.json");
  const model = { id: "glm-5.3", contextWindow: 202752, maxTokens: 32768, reasoning: true };
  const fingerprint = JSON.stringify([model.id, model.contextWindow, model.maxTokens, model.reasoning]);
  writeFileSync(
    stale,
    JSON.stringify({
      version: 1,
      buckets: {
        "officeace::acct-1": {
          "glm-5.3": { modelId: "glm-5.3", fingerprint, validation: "non-validating", efforts: [], probedAt: 1 },
        },
      },
    }),
    "utf8",
  );

  const fresh = m.createProbeStore({ file: stale });
  // 指纹完全对上，但缓存版本是旧的 → 必须读不到，否则误判会永久生效
  assert.equal(fresh.get("officeace", "acct-1", model), undefined, "旧版本缓存必须作废");
  assert.equal(fresh.describe("officeace", "acct-1").probed, 0);
});

test("缓存：坏文件不抛，从空开始", () => {
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ not json", "utf8");
  const store = m.createProbeStore({ file: bad });
  assert.doesNotThrow(() => store.describe("officeace", "x"));
});

test("缓存：describe 返回已探测列表", () => {
  const store = m.createProbeStore({ file });
  const state = store.describe("officeace", "acct-1");
  assert.ok(state.probed >= 1);
  assert.ok(Array.isArray(state.entries));
  assert.ok(state.entries.every((e) => typeof e.modelId === "string"));
});

// ── 5. resolveReasoning ────────────────────────────────────────────────
test("resolveReasoning：reasoning !== true 时不给控制项", () => {
  const out = m.resolveReasoning({ id: "x", reasoning: false }, undefined);
  assert.equal(out.reasoning, false);
});

test("resolveReasoning：上游声明优先于观测", () => {
  const declared = { id: "x", reasoning: true, supportedEfforts: ["low", "high"] };
  const observed = { validation: "validating", efforts: ["low", "medium", "high", "max"] };
  const out = m.resolveReasoning(declared, observed);
  assert.equal(out.reasoning, true);
  assert.equal(out.thinkingLevelMap.medium, null, "声明集不因观测而放宽");
  assert.equal(out.thinkingLevelMap.max, null);
});

test("resolveReasoning：无声明时用 validating 观测", () => {
  const out = m.resolveReasoning({ id: "x", reasoning: true }, { validation: "validating", efforts: ["low", "max"] });
  assert.equal(out.reasoning, true);
  assert.equal(out.thinkingLevelMap.low, "low");
  assert.equal(out.thinkingLevelMap.max, "max");
  assert.equal(out.thinkingLevelMap.high, null);
});

test("resolveReasoning：non-validating 观测不给控制项", () => {
  const out = m.resolveReasoning({ id: "x", reasoning: true }, { validation: "non-validating", efforts: [] });
  assert.equal(out.reasoning, false, "上游不校验参数时，任何档位结论都是假阳性");
});

test("resolveReasoning：既无声明也无观测 → 用内置基线（首次启动也有档位）", () => {
  const out = m.resolveReasoning({ id: "glm-5.3", reasoning: true }, undefined);
  assert.equal(out.reasoning, true, "glm-5.3 在已验证基线里，首次启动就该有档位");
  assert.equal(out.thinkingLevelMap.low, "low");
  assert.equal(out.thinkingLevelMap.high, "high");
  assert.equal(out.thinkingLevelMap.max, "max");
  assert.equal(out.thinkingLevelMap.none ?? out.thinkingLevelMap.off, null, "glm-5.3 不支持关闭思考");
});

test("resolveReasoning：基线里没有的模型仍不给控制项", () => {
  const out = m.resolveReasoning({ id: "some-new-model", reasoning: true }, undefined);
  assert.equal(out.reasoning, false);
});

test("resolveReasoning：non-validating 观测压过内置基线", () => {
  // qwen3-32b 实测：上游接受 totally_bogus_xyz / 99999 并返回 200，
  // 说明它不校验该参数。此时即使基线里有档位也不能给。
  const out = m.resolveReasoning(
    { id: "glm-5.3", reasoning: true },
    { validation: "non-validating", efforts: [] },
  );
  assert.equal(out.reasoning, false, "上游不校验参数时，任何档位结论都不可信");
});

test("resolveReasoning：探测结果优先于内置基线", () => {
  const out = m.resolveReasoning(
    { id: "glm-5.3", reasoning: true },
    { validation: "validating", efforts: ["low"] },
  );
  assert.equal(out.reasoning, true);
  assert.equal(out.thinkingLevelMap.low, "low");
  assert.equal(out.thinkingLevelMap.high, null, "探测说只有 low，就不该给 high");
});

test("VERIFIED_EFFORTS 只收录 validating 结论", () => {
  assert.ok(Array.isArray(m.VERIFIED_EFFORTS["deepseek-v4.1-flash"]));
  assert.equal(m.VERIFIED_EFFORTS["deepseek-v4.1-flash"].length, 7);
  assert.deepEqual(m.VERIFIED_EFFORTS["glm-5.3"], ["low", "high", "max"]);
  // qwen3-32b 实测 non-validating，刻意不收录
  assert.equal(m.VERIFIED_EFFORTS["qwen3-32b"], undefined, "non-validating 的模型不该进基线");
});

test("未在基线里的模型：reasoning=false 只表示没测过，不是上游不支持", () => {
  // 这是界面上最容易误导用户的一点：
  //   reasoning=false 有两层含义 ——「上游确实不支持」和「还没测过」
  // 客户端必须靠 probeState 区分，不能把两者混成一个"不支持"列表。
  // 实测：glm-5.1/5.2、kimi-k2.6、DeepSeek-V4-Flash 都能探测（会拒绝非法值），
  // 只是不在基线里 —— 它们必须出现在"还没测过"而不是"不支持"里。
  const out = m.resolveReasoning({ id: "glm-5.1", reasoning: true }, undefined);
  assert.equal(out.reasoning, false, "没探测过就不给档位，这是对的");
  assert.equal(m.VERIFIED_EFFORTS["glm-5.1"], undefined, "但它不在基线里，不代表上游拒绝该参数");
});

// ── 汇总 ────────────────────────────────────────────────────────────────
rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
for (const row of results) {
  console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.name}`);
  if (!row.ok) console.log(`      ${row.error.message}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;