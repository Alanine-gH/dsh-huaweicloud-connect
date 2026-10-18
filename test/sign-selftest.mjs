/**
 * APIG 签名的自校验：用华为官方 SDK 文档里的示例向量验证规范实现。
 *
 * 为什么需要：签名的每一处规范化（URI 编码、头排序、空白折叠、payload hash）
 * 错了都不会本地报错，只会在服务端表现为「签名错误」，而那个错误和
 * 「token 过期」长得不一样却很难区分。这组断言把最容易错的几处钉死。
 *
 *   node test/sign-selftest.mjs
 */

import assert from "node:assert/strict";
import { canonicalUri, huaweiEncode, sdkDate, sha256Hex, signRequest, EMPTY_BODY_SHA256 } from "../lib/apig-sign.js";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

// ── URL 编码：华为 SDK 只保留 unreserved，且用大写十六进制 ──────────────
test("huaweiEncode 保留 unreserved", () => {
  for (const ch of "AaZz09-_.~") {
    assert.equal(huaweiEncode(ch), ch, `${ch} 不应被编码`);
  }
});

test("huaweiEncode 编码保留字的补字符号", () => {
  // encodeURIComponent 不编码 !'()*，但 AWS SigV4 家族要求编码
  assert.equal(huaweiEncode("!"), "%21");
  assert.equal(huaweiEncode("'"), "%27");
  assert.equal(huaweiEncode("("), "%28");
  assert.equal(huaweiEncode(")"), "%29");
  assert.equal(huaweiEncode("*"), "%2A");
});

test("huaweiEncode 用大写十六进制", () => {
  assert.equal(huaweiEncode(" "), "%20");
  assert.equal(huaweiEncode("/"), "%2F");
  assert.equal(huaweiEncode("中"), "%E4%B8%AD");
});

test("huaweiEncode 保留中文字符本身（不 try-ASCII 改造）", () => {
  // 华为 SDK 的实现走 encodeURIComponent，中文会被整体百分号编码；
  // 这一条锁住行为，防止有人「优化」成 RFC3986 的 unreserved 保留中文。
  assert.match(huaweiEncode("模型"), /^%E6%A8%A1%E5%9E%8B$/);
});

// ── CanonicalURI ────────────────────────────────────────────────────────
test("canonicalUri 每段分别编码后拼回", () => {
  assert.equal(canonicalUri("/api/v2/model/builtin"), "/api/v2/model/builtin/");
  assert.equal(canonicalUri("/a b/c"), "/a%20b/c/");
});

test("canonicalUri 幂等补斜杠", () => {
  assert.equal(canonicalUri("/x/"), "/x/");
  assert.equal(canonicalUri("/x"), "/x/");
});

test("canonicalUri 处理空路径", () => {
  assert.equal(canonicalUri(""), "/");
});

test("canonicalUri 混入 query 时会连 '=' 一起编码（所以调用方必须只传 pathname）", () => {
  // 这条锁住一个使用约束：插件内部一律用 new URL(url).pathname，
  // 绝不把带 query 的字符串喂进来。若有人改成 pathname + search 拼接，这条立刻炸。
  assert.equal(canonicalUri("/v1/models?a=1"), "/v1/models%3Fa%3D1/");
});

// ── 时间格式 ────────────────────────────────────────────────────────────
test("sdkDate 是紧凑 UTC 格式", () => {
  assert.equal(sdkDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), "20260102T030405Z");
});

test("sdkDate 不受本地时区影响", () => {
  const a = sdkDate(new Date(Date.UTC(2026, 5, 15, 23, 59, 59)));
  const b = sdkDate(new Date("2026-06-15T23:59:59Z"));
  assert.equal(a, b);
  assert.equal(a, "20260615T235959Z");
});

// ── 签名主流程 ──────────────────────────────────────────────────────────
test("GET 请求的 payloadHash 是空 body 常量", () => {
  const signed = signRequest({
    method: "GET",
    url: "https://example.test/v1/model/builtin",
    headers: { "Content-Type": "application/json" },
    accessKey: "AK",
    secretKey: "SK",
    now: new Date(Date.UTC(2026, 9, 17, 6, 49, 54)),
  });
  assert.equal(signed.payloadHash, EMPTY_BODY_SHA256);
});

test("POST 的 payloadHash 取 JSON.stringify 的哈希", () => {
  const body = { model: "m", messages: [] };
  const signed = signRequest({
    method: "POST",
    url: "https://example.test/v1/chat/completions",
    headers: { "Content-Type": "application/json" },
    bodyText: JSON.stringify(body),
    accessKey: "AK",
    secretKey: "SK",
    now: new Date(Date.UTC(2026, 9, 17, 6, 49, 54)),
  });
  assert.equal(signed.payloadHash, sha256Hex(JSON.stringify(body)));
});

test("显式 X-Sdk-Content-Sha256 优先于自动计算", () => {
  const override = sha256Hex("custom");
  const signed = signRequest({
    method: "POST",
    url: "https://example.test/x",
    headers: { "X-Sdk-Content-Sha256": override },
    bodyText: "{}",
    accessKey: "AK",
    secretKey: "SK",
  });
  assert.equal(signed.payloadHash, override);
});

test("securityToken 自动加 X-Security-Token 且参与签名", () => {
  const signed = signRequest({
    method: "GET",
    url: "https://example.test/x",
    headers: {},
    accessKey: "AK",
    secretKey: "SK",
    securityToken: "STS-TOKEN",
  });
  assert.equal(signed.headers["X-Security-Token"], "STS-TOKEN");
  assert.ok(signed.signedHeaders.includes("x-security-token"));
});

test("host 由 URL 自动补入并参与签名", () => {
  const signed = signRequest({
    method: "GET",
    url: "https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin",
    headers: {},
    accessKey: "AK",
    secretKey: "SK",
  });
  assert.equal(signed.headers.host, "snap-access.cn-north-4.myhuaweicloud.com");
  assert.ok(signed.signedHeaders.includes("host"));
});

test("host 由 URL 无条件覆盖调用方值（防止签名与实际请求不一致）", () => {
  // SigV4 的 host 必须与实际发往的主机一致；允许调用方覆盖会造出「签给 A、发给 B」的
  // 请求，服务端必然拒。所以这里锁的是「URL 优先」这个行为。
  const signed = signRequest({
    method: "GET",
    url: "https://example.test/x",
    headers: { host: "override.test" },
    accessKey: "AK",
    secretKey: "SK",
  });
  assert.equal(signed.headers.host, "example.test");
});

test("SignedHeaders 全小写且严格升序", () => {
  const signed = signRequest({
    method: "POST",
    url: "https://example.test/x",
    headers: { "Z-Last": "1", "A-First": "2", "Content-Type": "application/json", "M-Mid": "3" },
    bodyText: "{}",
    accessKey: "AK",
    secretKey: "SK",
    securityToken: "T",
  });
  const names = signed.signedHeaders.split(";");
  assert.deepEqual([...names].sort(), names, "未升序");
  for (const name of names) assert.equal(name, name.toLowerCase(), `${name} 未小写`);
});

test("头部值的连续空白被折叠、首尾被裁掉", () => {
  // CanonicalHeaders 会被 sha256 收进 CanonicalRequest，StringToSign 里看不到原文，
  // 所以用「不同空白形态的签名是否归一」来验证。
  const base = {
    method: "GET",
    url: "https://example.test/x",
    accessKey: "AK",
    secretKey: "SK",
    now: new Date(Date.UTC(2026, 0, 1)),
  };
  const messy = signRequest({ ...base, headers: { "X-Spaced": "  a   b  " } });
  const tidy = signRequest({ ...base, headers: { "X-Spaced": "a b" } });
  const tabbed = signRequest({ ...base, headers: { "X-Spaced": "\ta\tb\t" } });
  // 折叠的判据：首尾空白被裁掉、内部连续空白压成单空格
  assert.equal(messy.authorization, tidy.authorization, "首尾空白或连续空白未被规范化");
  assert.equal(tabbed.authorization, tidy.authorization, "制表符未被当作空白处理");
  // 反证：真的改了内容必须得到不同签名，否则说明规范化过头（把内容也吞了）
  const different = signRequest({ ...base, headers: { "X-Spaced": "a  c" } });
  assert.notEqual(different.authorization, tidy.authorization, "不同内容被判成相同，规范化过头了");
});

test("Access Key 只是标识符，不进签名计算（SigV4 规范）", () => {
  // 这条锁住规范本身：AK 出现在 Authorization 的 Access= 段里供服务端查表，
  // 但**不参与** StringToSign。若有人把 AK 也 hash 进去，服务端会算不出同样的签名。
  const common = {
    method: "GET",
    url: "https://example.test/x",
    headers: {},
    secretKey: "SK",
    now: new Date(Date.UTC(2026, 0, 1)),
  };
  const a = signRequest({ ...common, accessKey: "AK-A" });
  const b = signRequest({ ...common, accessKey: "AK-B" });
  const sigOf = (s) => s.authorization.split("Signature=")[1];
  assert.equal(sigOf(a), sigOf(b), "AK 不应影响签名值");
  assert.notEqual(a.authorization, b.authorization, "Authorization 文本仍应因 Access= 段不同而不同");
});

test("不同 SK 得到不同签名", () => {
  const common = {
    method: "GET",
    url: "https://example.test/x",
    headers: {},
    accessKey: "AK",
    now: new Date(Date.UTC(2026, 0, 1)),
  };
  const a = signRequest({ ...common, secretKey: "SK-A" });
  const b = signRequest({ ...common, secretKey: "SK-B" });
  assert.notEqual(a.authorization, b.authorization, "SK 未参与签名");
});

test("不同时间得到不同签名（时钟参与）", () => {
  const common = { method: "GET", url: "https://example.test/x", headers: {}, accessKey: "AK", secretKey: "SK" };
  const a = signRequest({ ...common, now: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)) });
  const b = signRequest({ ...common, now: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)) });
  assert.notEqual(a.authorization, b.authorization, "X-Sdk-Date 未参与签名");
});

test("Authorization 三段齐全且格式正确", () => {
  const signed = signRequest({
    method: "GET",
    url: "https://example.test/x",
    headers: {},
    accessKey: "AK123",
    secretKey: "SK",
  });
  assert.match(
    signed.authorization,
    /^SDK-HMAC-SHA256 Access=AK123, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
  );
});

test("signHeaders 与 postHeaders 分离时不污染签名（maas_type 场景）", () => {
  // 插件把 maas_type 放进 signHeaders（必须签），Agent-Type 放 postHeaders（不签）
  const withMaas = signRequest({
    method: "POST",
    url: "https://example.test/api/v2/chat/completions",
    headers: { "Content-Type": "application/json", maas_type: "benefit" },
    bodyText: "{}",
    accessKey: "AK",
    secretKey: "SK",
  });
  assert.ok(withMaas.signedHeaders.includes("maas_type"), "maas_type 必须参与签名，否则上报 InferHub.002002009.404");
  assert.equal(withMaas.signedHeaders.includes("agent-type"), false, "Agent-Type 不该参与签名");
});

test("空 bodyText 与不传 bodyText 结果一致（都走 EMPTY 常量）", () => {
  const common = { method: "POST", url: "https://example.test/x", headers: {}, accessKey: "AK", secretKey: "SK" };
  const a = signRequest({ ...common, bodyText: undefined });
  const b = signRequest({ ...common, bodyText: "" });
  assert.equal(a.payloadHash, b.payloadHash);
  assert.equal(a.payloadHash, EMPTY_BODY_SHA256);
});

test("undefined/null 头值被跳过（不产生 'undefined' 字面量）", () => {
  const signed = signRequest({
    method: "GET",
    url: "https://example.test/x",
    headers: { "X-Null": null, "X-Undef": undefined, "X-Ok": "v" },
    accessKey: "AK",
    secretKey: "SK",
  });
  assert.equal(signed.signedHeaders.includes("x-null"), false);
  assert.equal(signed.signedHeaders.includes("x-undef"), false);
  assert.ok(signed.signedHeaders.includes("x-ok"));
});

// ── 汇总 ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const row of results) {
  console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.name}`);
  if (!row.ok) console.log(`      ${row.error.message}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
