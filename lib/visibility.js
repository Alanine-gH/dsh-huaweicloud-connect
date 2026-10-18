/**
 * 模型显隐存储。
 *
 * 与 workbuddy 的差异：华为云两个产品的模型 id 会撞名（例如都有 `glm-5.3`、
 * 都有 `openpangu-2.0-pro`），所以**每个产品一份文件**，绝不共享。
 *
 * 可选「按账号区分」：华为云的登录态能拿到稳定的账号标识（CodeArts 的 account.id、
 * OfficeAce 的 userId），据此分桶。切回旧账号时它自己的显隐配置自动恢复。
 *
 * 存储位置：$DSH_HOME/.huaweicloud-connect/visibility-<product>.json
 *
 * @module dsh-huaweicloud-connect/visibility
 */

import { mkdir, readFile, rename, writeFile, chmod, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 与凭据层共用同一个 DSH 主目录解析，避免两处判断不一致。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : join(homedir(), ".dsh");
}

export function visibilityPath(product) {
  return join(dshHome(), ".huaweicloud-connect", `visibility-${product}.json`);
}

/** 原子写：先写随机后缀的兄弟文件再 rename，读者永远看到完整 JSON。 */
async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => undefined);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => undefined);
}

/**
 * 文件形态：
 * {
 *   version: 1,
 *   perAccount: true,
 *   accounts: {
 *     "fingerprint-or-uid": { hidden: ["model-a", "model-b"] }
 *   },
 *   shared: { hidden: ["model-c"] }   // perAccount=false 时使用
 * }
 */
function emptyDocument() {
  return { version: 1, perAccount: true, accounts: {}, shared: { hidden: [] } };
}

function sanitizeHidden(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 256) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 建一个产品的显隐存储。
 *
 * @param {object} options
 * @param {string} options.product 产品 id（codearts / officeace），决定文件名
 * @param {object} [options.logger]
 */
export function createVisibilityStore(options) {
  const { product, logger } = options;

  let document = emptyDocument();
  let loaded = false;
  /** 串行化写，避免并发 probe 写互相覆盖。 */
  let writeChain = Promise.resolve();

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    let text;
    try {
      text = await readFile(visibilityPath(product), { encoding: "utf8" });
    } catch {
      return; // 首次运行：保持空文档
    }
    try {
      const parsed = JSON.parse(text);
      document = {
        version: 1,
        perAccount: parsed?.perAccount !== false,
        accounts: parsed?.accounts !== null && typeof parsed?.accounts === "object" ? parsed.accounts : {},
        shared: { hidden: sanitizeHidden(parsed?.shared?.hidden) },
      };
    } catch (error) {
      // 坏文件不能静默当空：那会把用户已隐藏的模型全部恢复显示。
      logger?.warn?.(`dsh-huaweicloud-connect: ${product} 显隐配置损坏，已忽略（未覆盖原文件）`, error);
    }
  }

  function bucket(account) {
    if (document.perAccount !== true || typeof account !== "string" || account.length === 0) return document.shared;
    const key = account;
    const existing = document.accounts[key];
    if (existing !== null && typeof existing === "object" && Array.isArray(existing.hidden)) return existing;
    const created = { hidden: [] };
    document.accounts[key] = created;
    return created;
  }

  function persist() {
    writeChain = writeChain
      .catch(() => undefined)
      .then(() => writeAtomic(visibilityPath(product), JSON.stringify(document, null, 2)))
      .catch((error) => {
        logger?.warn?.(`dsh-huaweicloud-connect: ${product} 显隐配置写入失败`, error);
      });
    return writeChain;
  }

  return {
    product,

    /**
     * 当前账号下被隐藏的模型 id。
     * @param {string|undefined} account 账号标识；未登录时传 undefined（落到 shared 桶）
     */
    async hidden(account) {
      await ensureLoaded();
      return [...bucket(account).hidden];
    },

    /** 模型选择器只应展示「未被隐藏」的模型。 */
    async visibleModels(account, models) {
      const hidden = new Set(await this.hidden(account));
      return models.filter((model) => !hidden.has(model.id));
    },

    /**
     * 设置显隐。
     * @param {string|undefined} account
     * @param {string} modelId
     * @param {boolean} visible true = 显示
     */
    async set(account, modelId, visible) {
      await ensureLoaded();
      const target = bucket(account);
      const next = new Set(target.hidden);
      if (visible === true) next.delete(modelId);
      else next.add(modelId);
      target.hidden = [...next];
      await persist();
      return target.hidden;
    },

    /** 批量设置（卡片里勾选全选/全不选）。 */
    async replace(account, modelIds, visible) {
      await ensureLoaded();
      bucket(account).hidden = visible === true ? [] : sanitizeHidden(modelIds);
      await persist();
      return bucket(account).hidden;
    },

    /** 切换「按账号区分」。切到 false 时把当前账号的隐藏项合并进共享桶。 */
    async setPerAccount(perAccount, account) {
      await ensureLoaded();
      if (perAccount === false && document.perAccount === true && typeof account === "string") {
        const current = document.accounts[account]?.hidden ?? [];
        document.shared.hidden = sanitizeHidden([...document.shared.hidden, ...current]);
      }
      document.perAccount = perAccount === true;
      await persist();
      return document.perAccount;
    },

    /** 读当前设置，供 status 文档下发。 */
    async describe(account) {
      await ensureLoaded();
      return {
        perAccount: document.perAccount,
        account: document.perAccount === true && typeof account === "string" ? account : undefined,
        hidden: [...bucket(account).hidden],
      };
    },

    async reset(account) {
      await ensureLoaded();
      if (document.perAccount === true && typeof account === "string") delete document.accounts[account];
      else document.shared.hidden = [];
      await persist();
    },

    /** 只删插件自己的文件，不动客户端。 */
    async clear() {
      loaded = false;
      document = emptyDocument();
      await rm(visibilityPath(product), { force: true }).catch(() => undefined);
    },
  };
}
