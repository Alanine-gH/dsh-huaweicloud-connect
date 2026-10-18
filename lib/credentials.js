/**
 * 登录态复用层。
 *
 * 设计原则（沿用 dsh-workbuddy-connect 验证过的链路，华为云侧只替换「定位/解析」两段）：
 *
 *   定位 → 分类 → （需要时）解密 → 写自己的 at-rest 副本 → 按需刷新 → 无凭据降级
 *
 * 几条必须守住的行为：
 * - **只读**桌面 App 的凭据，只写插件自己的副本，绝不回写 App。
 * - 凭据「存在但读不了」必须报错，**不许**静默回退到旧副本——那会用错账号。
 * - 副本目录 0700 / 文件 0600。
 * - 刷新单飞（single-flight）：并发请求共享同一次刷新。
 *
 * 两种凭据来源：
 * - 文本文件（OfficeAce 的 models.json）：`parseAuth(text)`
 * - 非文本（CodeArts 的 SQLite）：驱动器提供 `readCredential(path)`，直接返回规范化对象
 *
 * @module dsh-huaweicloud-connect/credentials
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 凭据读取失败的闭集原因码（不要用文案判定分支）。 */
export const CredentialErrorCode = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  UNREADABLE: "UNREADABLE",
  UNRECOGNIZED: "UNRECOGNIZED",
  ENCRYPTED_UNSUPPORTED: "ENCRYPTED_UNSUPPORTED",
  HELPER_FAILED: "HELPER_FAILED",
  EXPIRED_NO_REFRESH: "EXPIRED_NO_REFRESH",
});

export class CredentialError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "CredentialError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** DSH 主目录：优先 DSH_HOME，其次 ~/.dsh。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".dsh");
}

/** 副本路径：$DSH_HOME/.huaweicloud-connect/<product>-auth.json */
export function ownAuthPath(product) {
  return join(dshHome(), ".huaweicloud-connect", `${product}-auth.json`);
}

/** 原子写：先写临时文件再 rename，避免半截 JSON。 */
async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => undefined);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => undefined);
}

/** 账号指纹：只用于「是不是同一个账号」判断，不进日志、不外发。 */
export function accountFingerprint(account) {
  if (typeof account !== "string" || account.length === 0) return undefined;
  return createHash("sha256").update(account, "utf8").digest("hex").slice(0, 16);
}

/** 把解析结果收敛成四态之一。 */
function classify(parsed) {
  if (parsed === undefined || parsed === null) return { kind: "unrecognized" };
  if (parsed.kind === "plaintext" && typeof parsed.token === "string" && parsed.token.length > 0) return parsed;
  if (parsed.kind === "encrypted") return parsed;
  return { kind: "unrecognized" };
}

const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * 建一个产品级的凭据 store。
 *
 * @param {object} options
 * @param {string} options.product 产品 id（同时作为副本文件名）
 * @param {string} options.displayName 日志用显示名
 * @param {string} options.envOverride 允许用环境变量直接指定凭据文件
 * @param {() => Promise<string[]>} options.candidates 候选凭据路径（有序）
 * @param {(text: string) => object|undefined} [options.parseAuth] 文本凭据解析
 * @param {(path: string) => Promise<object>} [options.readCredential] 非文本凭据读取（优先于 parseAuth）
 * @param {() => Promise<string|undefined>} [options.resolveExplicitPath] 来自插件 Config 的显式路径
 * @param {(payload: unknown) => Promise<object|undefined>} [options.decrypt] 加密凭据解密钩子
 * @param {(credential: object) => Promise<object|undefined>} [options.refresh] 刷新钩子（华为云两产品都**不提供**）
 * @param {boolean} [options.persistCopy] 是否写插件的 at-rest 副本（默认 true）
 * @param {object} [options.logger]
 */
export function createCredentialStore(options) {
  const {
    product,
    displayName,
    envOverride,
    candidates,
    parseAuth,
    readCredential,
    resolveExplicitPath,
    decrypt,
    refresh,
    persistCopy = true,
    logger,
  } = options;

  let cached;
  let inflightRefresh;
  let lastError;

  const now = () => Date.now();

  function expired(credential, marginMs = 0) {
    const expiresAt = credential?.expiresAt;
    if (typeof expiresAt !== "number") return false;
    return expiresAt - marginMs <= now();
  }

  /** 规范化驱动器/解析器给出的凭据。 */
  function normalizeCredential(raw, path) {
    const token = typeof raw?.token === "string" && raw.token.length > 0 ? raw.token : undefined;
    if (token === undefined) {
      throw new CredentialError(CredentialErrorCode.UNRECOGNIZED, `${displayName} 登录态缺少可用凭据: ${path}`);
    }
    return { ...raw, kind: "plaintext", sourcePath: path, readAtMs: now() };
  }

  /** 读一个具体路径：不存在抛 NOT_FOUND（调用方继续找），其余错误原样抛。 */
  async function credentialAt(path) {
    if (typeof readCredential === "function") {
      try {
        return normalizeCredential(await readCredential(path), path);
      } catch (error) {
        if (error instanceof CredentialError) throw error;
        if (error?.code === "NOT_FOUND") {
          throw new CredentialError(CredentialErrorCode.NOT_FOUND, String(error?.message ?? `${displayName} 未登录`), error);
        }
        throw new CredentialError(
          CredentialErrorCode.UNREADABLE,
          String(error?.message ?? `${displayName} 登录态读取失败`),
          error,
        );
      }
    }

    let text;
    try {
      text = await readFile(path, { encoding: "utf8" });
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new CredentialError(CredentialErrorCode.NOT_FOUND, `${displayName} 凭据文件不存在: ${path}`);
      }
      throw new CredentialError(CredentialErrorCode.UNREADABLE, `${displayName} 凭据文件读不了: ${path}`, error);
    }

    const parsed = classify(
      (() => {
        try {
          return parseAuth?.(text);
        } catch {
          return undefined;
        }
      })(),
    );

    if (parsed.kind === "plaintext") return normalizeCredential(parsed, path);

    if (parsed.kind === "encrypted") {
      if (typeof decrypt !== "function") {
        throw new CredentialError(
          CredentialErrorCode.ENCRYPTED_UNSUPPORTED,
          `${displayName} 凭据是加密的，但当前没有可用的解密路径（可用 ${envOverride} 直接指定明文凭据文件）`,
        );
      }
      const plain = classify(await decrypt(parsed.payload));
      if (plain.kind !== "plaintext") {
        throw new CredentialError(CredentialErrorCode.HELPER_FAILED, `${displayName} 加密凭据解密后仍不是可用的 token`);
      }
      return normalizeCredential(plain, path);
    }

    throw new CredentialError(CredentialErrorCode.UNRECOGNIZED, `${displayName} 凭据文件格式无法识别: ${path}`);
  }

  /**
   * 定位：Config 显式路径 > 环境变量 > 平台候选。
   * 命中即返回已解析的凭据，避免同一个文件读两遍。
   */
  async function locate() {
    const ordered = [];
    const explicit = await resolveExplicitPath?.();
    if (typeof explicit === "string" && explicit.length > 0) ordered.push({ path: explicit, source: "config" });
    const fromEnv = process.env[envOverride];
    if (typeof fromEnv === "string" && fromEnv.length > 0) ordered.push({ path: fromEnv, source: "env" });
    for (const path of await candidates()) ordered.push({ path, source: "desktop" });

    for (const candidate of ordered) {
      try {
        const credential = await credentialAt(candidate.path);
        return { ...candidate, credential };
      } catch (error) {
        if (error instanceof CredentialError && error.code === CredentialErrorCode.NOT_FOUND) continue;
        // 存在但读不了：直接报错，绝不静默回退旧副本
        throw error;
      }
    }
    return undefined;
  }

  /** 读副本（仅当显式开启 persistCopy；用于人工排障）。 */
  async function readOwnCopy() {
    const path = ownAuthPath(product);
    try {
      const text = await readFile(path, { encoding: "utf8" });
      const parsed = JSON.parse(text);
      if (typeof parsed?.token !== "string" || parsed.token.length === 0) return undefined;
      return { ...parsed, sourcePath: path, source: "copy" };
    } catch {
      return undefined;
    }
  }

  /** 写副本。只存必要字段，不存原始密文。 */
  async function writeOwnCopy(credential) {
    if (persistCopy !== true) return;
    if (typeof credential?.token !== "string" || credential.token.length === 0) return;
    const payload = {
      version: 1,
      token: credential.token,
      refreshToken: credential.refreshToken,
      expiresAt: credential.expiresAt,
      account: credential.account,
      accountFingerprint: accountFingerprint(credential.account),
      sourcePath: credential.sourcePath,
      savedAtMs: now(),
    };
    await writeAtomic(ownAuthPath(product), JSON.stringify(payload, null, 2)).catch((error) => {
      logger?.warn?.(`dsh-huaweicloud-connect: ${displayName} 凭据副本写入失败`, error);
    });
  }

  /** 单飞刷新。 */
  async function refreshOnce(credential) {
    if (typeof refresh !== "function") return undefined;
    if (typeof credential?.refreshToken !== "string" || credential.refreshToken.length === 0) return undefined;
    if (inflightRefresh !== undefined) return inflightRefresh;
    inflightRefresh = (async () => {
      try {
        const next = await refresh(credential);
        if (next === undefined) return undefined;
        const merged = { ...credential, ...next, readAtMs: now() };
        await writeOwnCopy(merged);
        cached = merged;
        lastError = undefined;
        return merged;
      } catch (error) {
        logger?.warn?.(`dsh-huaweicloud-connect: ${displayName} 登录态刷新失败`, error);
        lastError = new CredentialError(CredentialErrorCode.HELPER_FAILED, `${displayName} 刷新失败`, error);
        return undefined;
      } finally {
        inflightRefresh = undefined;
      }
    })();
    return inflightRefresh;
  }

  const store = {
    product,
    displayName,

    /**
     * 解析当前可用凭据。
     *
     * @param {{allowExpired?: boolean}} [opts]
     * @returns {Promise<object|undefined>} 无凭据时返回 undefined（这是「未登录」，不是错误）
     */
    async resolve(opts = {}) {
      const located = await locate();
      if (located === undefined) {
        lastError = undefined;
        cached = undefined;
        return undefined;
      }

      const credential = located.credential;
      if (expired(credential, REFRESH_MARGIN_MS)) {
        const refreshed = await refreshOnce(credential);
        if (refreshed !== undefined) return refreshed;
        if (!opts.allowExpired && expired(credential, 0)) {
          lastError = new CredentialError(
            CredentialErrorCode.EXPIRED_NO_REFRESH,
            `${displayName} 登录态已过期；请打开 ${displayName} 让它自动续期后重试`,
          );
          throw lastError;
        }
      }

      cached = credential;
      lastError = undefined;
      await writeOwnCopy(credential);
      return credential;
    },

    /** 当前缓存的账号指纹（未登录时 undefined）。 */
    accountKey() {
      const fingerprint = accountFingerprint(cached?.account);
      if (fingerprint !== undefined) return fingerprint;
      if (typeof cached?.token === "string" && cached.token.length > 0) {
        return `t:${createHash("sha256").update(cached.token).digest("hex").slice(0, 12)}`;
      }
      return undefined;
    },

    /** 诊断信息：不泄露 token。 */
    status() {
      return {
        product,
        displayName,
        signedIn: cached !== undefined,
        account: cached?.account,
        expiresAt: cached?.expiresAt,
        sourcePath: cached?.sourcePath,
        copyPath: persistCopy === true ? ownAuthPath(product) : undefined,
        lastError: lastError === undefined ? undefined : { code: lastError.code, message: lastError.message },
      };
    },

    /** 只删插件自己的副本，不动桌面 App 的登录。 */
    async logout() {
      await rm(ownAuthPath(product), { force: true }).catch(() => undefined);
      cached = undefined;
      lastError = undefined;
    },

    /** 强制重读（诊断用，允许过期凭据通过）。 */
    async reload() {
      cached = undefined;
      return store.resolve({ allowExpired: true });
    },

    readOwnCopy,
  };

  return store;
}
