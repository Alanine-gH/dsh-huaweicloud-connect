/**
 * 华为 APIG `SDK-HMAC-SHA256` 签名器。
 *
 * 依据：CodeArts kernel 内嵌的 `huaweicloud-sdk-core` `AKSKSigner` 行为（见
 * ref/codearts-spec.md §2.4）。纯函数、无 IO，可直接单测。
 *
 * 注意两个容易踩错的点：
 * 1. `PayloadHash` 取的是 **`JSON.stringify(body)` 的 sha256**，不是原始字节的哈希。
 *    所以调用方必须在序列化一次之后就固定这份字符串，并用它既签名又发送。
 * 2. `CanonicalURI` 每一段都要按华为的 URL 编码规则处理（`~` 之外的非 unreserved
 *    全部百分号编码），并且若结果不以 `/` 结尾要补一个。
 *
 * @module dsh-huaweicloud-connect/apig-sign
 */

import { createHash, createHmac } from "node:crypto";

/** 空 body 的 sha256。 */
export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const ALGORITHM = "SDK-HMAC-SHA256";

/** 华为 SDK 的 URI 编码：仅保留 A-Za-z0-9-_.~，其余一律 %XX（大写）。 */
export function huaweiEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `YYYYMMDDTHHmmssZ`。 */
export function sdkDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * CanonicalURI：按段编码后拼回，保证以 `/` 结尾。
 * @param {string} pathname
 */
export function canonicalUri(pathname) {
  const path = pathname.length === 0 ? "/" : pathname;
  const encoded = path.split("/").map(huaweiEncode).join("/");
  return encoded.endsWith("/") ? encoded : `${encoded}/`;
}

/**
 * 对请求签名。
 *
 * @param {object} options
 * @param {string} options.method HTTP 方法（大写）
 * @param {string} options.url 完整 URL
 * @param {Record<string,string>} options.headers 会被签名并原样发送的头（不含 Authorization）
 * @param {string} [options.bodyText] 已序列化好的请求体字符串（GET 不传）
 * @param {string} options.accessKey
 * @param {string} options.secretKey
 * @param {string} [options.securityToken] STS token，会给 `X-Security-Token` 并参与签名
 * @param {Date} [options.now] 注入时间便于测试
 * @returns {{headers: Record<string,string>, authorization: string, signedHeaders: string, payloadHash: string, stringToSign: string}}
 */
export function signRequest(options) {
  const { method, url, accessKey, secretKey, securityToken, bodyText, now } = options;
  const parsed = new URL(url);

  // 合并待签名头：调用方给的 + host + X-Sdk-Date [+ X-Security-Token]
  const headers = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined || value === null) continue;
    headers[name] = String(value);
  }
  headers.host = parsed.host;
  headers["X-Sdk-Date"] = sdkDate(now);
  if (typeof securityToken === "string" && securityToken.length > 0) {
    headers["X-Security-Token"] = securityToken;
  }

  // 规范化：按小写名排序
  const sortedNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();

  const canonicalHeaders = sortedNames.map((lower) => {
    // 找到原始名对应的值（可能不同大小写）
    const original = Object.keys(headers).find((name) => name.toLowerCase() === lower);
    const value = original === undefined ? "" : headers[original];
    // 值做 trim + 连续空白折叠
    return `${lower}:${value.trim().replace(/\s+/g, " ")}\n`;
  });

  const signedHeaders = sortedNames.join(";");
  const payloadHash =
    headers["X-Sdk-Content-Sha256"] ?? (typeof bodyText === "string" ? sha256Hex(bodyText) : EMPTY_BODY_SHA256);

  const canonicalRequest = [method.toUpperCase(), canonicalUri(parsed.pathname), "", canonicalHeaders.join(""), signedHeaders, payloadHash].join("\n");
  const stringToSign = `${ALGORITHM}\n${headers["X-Sdk-Date"]}\n${sha256Hex(canonicalRequest)}`;
  const signature = createHmac("sha256", secretKey).update(stringToSign, "utf8").digest("hex");

  return {
    headers,
    authorization: `${ALGORITHM} Access=${accessKey}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders,
    payloadHash,
    stringToSign,
  };
}

/** 小写 hex sha256。 */
export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
