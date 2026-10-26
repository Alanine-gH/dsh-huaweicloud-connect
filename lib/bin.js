#!/usr/bin/env node
/**
 * 诊断 CLI。
 *
 *   dsh plugin --profile <p> exec dsh-huaweicloud-connect status   [--json]
 *   dsh plugin --profile <p> exec dsh-huaweicloud-connect doctor   [--json]
 *   dsh plugin --profile <p> exec dsh-huaweicloud-connect logout
 *
 * 只读为主：status/doctor 只发幂等 GET 拉模型目录，不发对话请求、不刷新登录态。
 *
 * @module dsh-huaweicloud-connect/bin
 */

import * as codearts from "./drivers/codearts.js";
import * as officeace from "./drivers/officeace.js";

const DRIVERS = [codearts, officeace];

function parseArgs(argv) {
  const args = { command: argv[0] ?? "status", json: false, only: undefined };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") args.json = true;
    else if (token === "--provider" || token === "--only") {
      args.only = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function selected(only) {
  if (only === undefined) return DRIVERS;
  const match = DRIVERS.filter(
    (driver) => driver.product === only || driver.providerId === only || driver.displayName.toLowerCase() === String(only).toLowerCase(),
  );
  return match.length > 0 ? match : DRIVERS;
}

function maskLength(value) {
  return typeof value === "string" ? `len=${value.length}` : "<none>";
}

async function collect(driver) {
  const out = { product: driver.product, displayName: driver.displayName, providerId: driver.providerId };

  let credential;
  try {
    const paths = await driver.candidates();
    out.credentialPaths = paths;
    // CLI 长期 AK/SK 优先（与 index.js 的运行时顺序一致），否则 doctor 会和
    // 真实行为对不上——那是最容易把人带偏的调试体验。
    if (typeof driver.readCliCredential === "function") {
      credential = await driver.readCliCredential();
      if (credential !== undefined) out.mode = "cli (IAM AK/SK)";
    }
    if (credential === undefined && typeof driver.readCredential === "function") {
      for (const path of paths) {
        try {
          credential = await driver.readCredential(path);
          break;
        } catch (error) {
          if (error?.code === "NOT_FOUND") continue;
          out.credentialError = { code: error?.code, message: String(error?.message ?? error) };
          break;
        }
      }
    } else if (credential === undefined) {
      const { readFile } = await import("node:fs/promises");
      for (const path of paths) {
        let text;
        try {
          text = await readFile(path, { encoding: "utf8" });
        } catch {
          continue;
        }
        const parsed = driver.parseAuth(text);
        if (parsed?.kind === "plaintext") {
          credential = parsed;
          break;
        }
      }
    }
  } catch (error) {
    out.credentialError = { code: error?.code, message: String(error?.message ?? error) };
  }

  if (credential === undefined) {
    out.signedIn = false;
    out.hint = `未找到 ${driver.displayName} 登录态；请先打开客户端并登录`;
    return out;
  }

  out.signedIn = true;
  out.baseUrl = credential.baseUrl;
  if (credential.sourcePath !== undefined) out.credentialSource = credential.sourcePath;
  if (credential.accessKey !== undefined) out.secrets = { accessKey: maskLength(credential.accessKey), secretKey: maskLength(credential.secretKey), securityToken: maskLength(credential.securityToken) };
  else out.authorizationScheme = String(credential.token ?? "").split(" ")[0];

  if (typeof credential.expiresAt === "number") {
    out.expiresAt = new Date(credential.expiresAt).toISOString();
    out.expired = credential.expiresAt <= Date.now();
  }

  try {
    const models = await driver.listModels(credential);
    out.modelCount = models.length;
    out.models = models.map((model) => model.id);
  } catch (error) {
    out.upstreamError = { code: error?.reasonCode ?? "UPSTREAM_ERROR", message: String(error?.message ?? error) };
  }
  return out;
}

function printRow(label, value) {
  if (value === undefined) return;
  console.log(`  ${label.padEnd(16)} ${value}`);
}

function printHuman(report) {
  for (const row of report) {
    console.log(`\n${row.displayName}  (${row.providerId})`);
    console.log("  ────────────────────────────────────");
    printRow("登录态", row.signedIn ? "已登录" : "未登录");
    if (row.mode !== undefined) printRow("授权模式", row.mode);
    if (row.credentialSource !== undefined) printRow("凭据来源", row.credentialSource);
    if (row.credentialPaths !== undefined) printRow("凭据候选", row.credentialPaths.join(", ") || "<none>");
    if (row.baseUrl !== undefined) printRow("baseUrl", row.baseUrl);
    if (row.authorizationScheme !== undefined) printRow("鉴权", row.authorizationScheme);
    if (row.secrets !== undefined) {
      printRow("accessKey", row.secrets.accessKey);
      printRow("secretKey", row.secrets.secretKey);
      if (row.secrets.securityToken !== "<none>") printRow("securityToken", row.secrets.securityToken);
    }
    if (row.expiresAt !== undefined) printRow("到期", `${row.expiresAt}${row.expired === true ? "（已过期）" : ""}`);
    else if (row.mode !== undefined) printRow("到期", "永不过期（长期 AK/SK）");
    if (row.modelCount !== undefined) printRow("模型数", row.modelCount);
    if (row.models !== undefined) printRow("模型", row.models.slice(0, 10).join(", ") + (row.models.length > 10 ? " …" : ""));
    if (row.credentialError !== undefined) printRow("凭据错误", `${row.credentialError.code}: ${row.credentialError.message}`);
    if (row.upstreamError !== undefined) printRow("上游错误", `${row.upstreamError.code}: ${row.upstreamError.message}`);
    if (row.hint !== undefined) printRow("提示", row.hint);
  }
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.command === "logout") {
    const { rm } = await import("node:fs/promises");
    const { ownAuthPath } = await import("./credentials.js");
    for (const driver of selected(args.only)) {
      await rm(ownAuthPath(driver.product), { force: true }).catch(() => undefined);
      console.log(`${driver.displayName}: 已删除插件自己的凭据副本（未改动客户端登录）`);
    }
    return 0;
  }

  if (args.command !== "status" && args.command !== "doctor") {
    console.error(`未知命令: ${args.command}\n用法: status|doctor|logout [--json] [--provider <product>]`);
    return 2;
  }

  const report = [];
  for (const driver of selected(args.only)) report.push(await collect(driver));

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
    if (args.command === "doctor") {
      const cliMode = report.some((row) => typeof row.mode === "string" && row.mode.startsWith("cli"));
      console.log("\n提示：");
      if (cliMode) {
        console.log("  · 当前走 CLI 授权（IAM 长期 AK/SK）：永不过期，也不依赖 CodeArts Agent 是否在运行。");
        console.log("  · 密钥是明文，建议放在 ~/.dsh/.huaweicloud-connect/credentials.csv 并收紧 ACL，用完从 Downloads 删掉。");
      } else {
        console.log("  · 当前走 CodeArts Agent 登录态（STS）：约 1 小时有效，过期需打开客户端自动续期。");
        console.log("  · 想要免续期，请按华为云「CLI 授权指导」配置 CODEARTS_CLI_AK / CODEARTS_CLI_SK。");
      }
      console.log("  · 本插件刻意不刷新登录态：refresh_token 轮换会把客户端登出。");
    }
  }

  const broken = report.some((row) => row.signedIn !== true || row.upstreamError !== undefined || row.expired === true);
  return broken ? 1 : 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (invokedDirectly) {
  run().then((code) => {
    process.exitCode = code;
  });
}
