/**
 * 真实只读探测：直接走 drivers，不依赖 DSH 内核、不发对话请求。
 *
 *   node test/live-probe.mjs
 *
 * 只会发两类幂等 GET：OfficeAce `{base}/models`、CodeArts `/v1/model/builtin`。
 * 不打印任何凭据值，只打印长度/到期时间/主机名。
 */

import * as officeace from "../lib/drivers/officeace.js";
import * as codearts from "../lib/drivers/codearts.js";

function mask(value) {
  if (typeof value !== "string") return "<none>";
  if (value.length <= 8) return `len=${value.length}`;
  return `len=${value.length} prefix=${value.slice(0, 6)}…`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function probeOfficeAce() {
  console.log("── OfficeAce ─────────────────────────────────────────");
  const paths = await officeace.candidates();
  console.log(`候选凭据文件: ${paths.length} 个`);
  for (const path of paths) console.log(`  · ${path}`);
  if (paths.length === 0) {
    console.log("结果: 未找到凭据目录（OfficeAce 可能没登录过）");
    return;
  }

  let credential;
  for (const path of paths) {
    const { readFile } = await import("node:fs/promises");
    let text;
    try {
      text = await readFile(path, { encoding: "utf8" });
    } catch (error) {
      console.log(`  跳过（读不了）: ${error?.code ?? error}`);
      continue;
    }
    const parsed = officeace.parseAuth(text);
    if (parsed?.kind === "plaintext") {
      credential = parsed;
      console.log(`  采用: ${path}`);
      break;
    }
    console.log(`  跳过（格式不符）: ${path}`);
  }

  if (credential === undefined) {
    console.log("结果: 没有可解析的登录态");
    return;
  }

  console.log(`  baseUrl: ${credential.baseUrl}`);
  console.log(`  Authorization: ${mask(credential.token)} (scheme=${credential.token.split(" ")[0]})`);
  console.log(`  默认模型: ${credential.modelName ?? "<none>"}`);

  const started = Date.now();
  try {
    const models = await officeace.listModels(credential);
    console.log(`  GET /models → ${models.length} 个模型 (${Date.now() - started}ms)`);
    console.log(`  前 8 个: ${models.slice(0, 8).map((m) => m.id).join(", ")}`);
    const withWindow = models.filter((m) => m.contextWindow >= 1_000_000).length;
    console.log(`  上下文 ≥1M 的模型: ${withWindow} 个`);
  } catch (error) {
    console.log(`  GET /models 失败: ${error?.reasonCode ?? "?"} ${error?.message ?? error}`);
  }
}

async function probeCodeArts() {
  console.log("\n── CodeArts ──────────────────────────────────────────");
  const paths = await codearts.candidates();
  console.log(`凭据库: ${paths[0]}`);

  let credential;
  try {
    credential = await codearts.readCredential(paths[0]);
  } catch (error) {
    console.log(`读取失败: code=${error?.code} ${error?.message ?? error}`);
    return;
  }

  console.log(`  accessKey: ${mask(credential.accessKey)}`);
  console.log(`  secretKey: ${mask(credential.secretKey)}`);
  console.log(`  securityToken: ${mask(credential.securityToken)}`);
  console.log(`  account: ${credential.account ?? "<none>"}`);
  console.log(
    `  expiresAt: ${credential.expiresAt === undefined ? "<none>" : new Date(credential.expiresAt).toISOString()}` +
      `${credential.expiresAt !== undefined && credential.expiresAt <= Date.now() ? "  ← 已过期" : ""}`,
  );

  const started = Date.now();
  try {
    const models = await codearts.listModels(credential);
    console.log(`  GET /v1/model/builtin → ${models.length} 个模型 (${Date.now() - started}ms)`);
    for (const model of models.slice(0, 8)) {
      console.log(`    ${model.id.padEnd(24)} ctx=${model.contextWindow} out=${model.maxTokens}`);
    }
  } catch (error) {
    console.log(`  GET /v1/model/builtin 失败: ${error?.reasonCode ?? "?"} ${error?.message ?? error}`);
    console.log("  （签名链路如果被接受，这里应报 token 过期而不是签名错误）");
  }
}

await probeOfficeAce();
await probeCodeArts();
