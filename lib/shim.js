/**
 * 回环 OpenAI 兼容 shim。
 *
 * 为什么需要它：pi-ai 的 `openai-completions` 只会发「标准 OpenAI 请求」，
 * 而华为云上游需要自己的鉴权头、可能不认 `developer` 角色、可能拒对象形态的
 * `tool_choice`、SSE 帧也可能不完全标准。把这些差异全部收敛在本文件里，
 * pi-ai 那一侧就只看见一个干净的 OpenAI endpoint。
 *
 * 安全：绑定 127.0.0.1 本身**不是**信任边界（本机任意进程、DNS rebinding 都能打
 * 回环地址），所以四道闸一个都不能省：
 *   1) Host 必须是回环主机名
 *   2) Origin（若存在）必须是回环 origin
 *   3) Authorization 必须等于本进程启动时生成的随机 Bearer
 *   4) POST 必须带 JSON Content-Type
 *
 * @module dsh-huaweicloud-connect/shim
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

/** 回环主机名白名单。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** 请求体上限：8 MiB（聊天请求，含图片 base64 的情况留足余量）。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 从 Host 头里剥离端口，IPv6 方括号感知。 */
function hostnameOf(hostHeader) {
  const raw = String(hostHeader ?? "").trim().toLowerCase();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end === -1 ? raw : raw.slice(0, end + 1);
  }
  const colon = raw.lastIndexOf(":");
  return colon === -1 ? raw : raw.slice(0, colon);
}

/** Origin 是否也是回环。允许缺省（非浏览器调用方不带 Origin）。 */
function isLoopbackOrigin(originHeader) {
  const raw = String(originHeader ?? "").trim();
  if (raw.length === 0) return true;
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** 把上游 SSE 的文本块原样转发，但保证最后一定有一个 `data: [DONE]`。 */
function ensureDoneFrame(chunks) {
  let sawDone = false;
  let tail = "";
  const push = (text) => {
    for (const line of text.split("\n")) {
      if (line.trim() === "data: [DONE]") sawDone = true;
    }
  };
  return {
    push(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      tail = (tail + text).slice(-64);
      push(text);
      return text;
    },
    finish() {
      return sawDone ? "" : "data: [DONE]\n\n";
    },
  };
}

/**
 * 读完整请求体（带长度上限）。
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 统一的 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/** 按 OpenAI 错误信封回错误，让 pi-ai 的 classify 能正确归类。 */
function sendOpenAiError(res, status, message, type = "invalid_request_error", code = null) {
  sendJson(res, status, { error: { message, type, code, param: null } });
}

/**
 * 请求体归一化。只做「上游普遍不认」的最小改写，其余原样透传。
 *
 * @param {object} body 原始 JSON 请求体
 * @param {object} opts
 * @param {boolean} [opts.dropEffort] 上游不认 reasoning_effort 时剥掉
 * @param {boolean} [opts.developerToSystem] 上游不认 developer 角色时降级为 system
 * @param {boolean} [opts.stringToolChoice] 上游拒对象形态 tool_choice 时压平
 * @returns {object}
 */
export function normalizeChatBody(body, opts = {}) {
  if (body === null || typeof body !== "object") return body;
  const out = { ...body };

  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (message === null || typeof message !== "object") return message;
      let role = message.role;
      if (opts.developerToSystem !== false && role === "developer") role = "system";
      // 部分网关只认字符串 content；数组形态（多模态）原样保留。
      if (role === message.role) return message;
      return { ...message, role };
    });
  }

  if (opts.stringToolChoice !== false && out.tool_choice !== null && typeof out.tool_choice === "object") {
    const name = out.tool_choice?.function?.name;
    out.tool_choice = typeof name === "string" && name.length > 0 ? "required" : "auto";
  }

  if (opts.dropEffort === true) {
    delete out.reasoning_effort;
    delete out.reasoning;
    delete out.thinking;
  }

  return out;
}

/**
 * 起一个回环 OpenAI 兼容 shim。
 *
 * @param {object} options
 * @param {(args: {body: object, signal: AbortSignal, shimToken: string}) => Promise<{status: number, headers?: Record<string,string>, stream: AsyncIterable<Uint8Array|string>}>} options.dispatch
 *        把归一化后的请求交给具体上游；抛错时由 shim 转成 OpenAI 错误信封。
 * @param {() => Promise<ReadonlyArray<object>>} [options.listModels]
 * @param {(provider: string, model: string) => {dropEffort?: boolean, developerToSystem?: boolean, stringToolChoice?: boolean}} [options.normalizeOptions]
 * @param {object} [options.logger] Cordis logger（可选）
 * @returns {{ ready: Promise<void>, baseUrl: () => string, token: () => string, close: () => void }}
 */
export function createShim(options) {
  const { dispatch, listModels, normalizeOptions, logger } = options;
  const secret = randomBytes(32).toString("base64url");
  let origin = "";
  let closed = false;

  const server = createServer(async (req, res) => {
    // ── 闸 1：Host 必须回环 ────────────────────────────────────────────
    if (!LOOPBACK_HOSTS.has(hostnameOf(req.headers.host))) {
      sendOpenAiError(res, 403, "forbidden host", "permission_error");
      return;
    }
    // ── 闸 2：Origin 必须回环（浏览器调用才带） ────────────────────────
    if (!isLoopbackOrigin(req.headers.origin)) {
      sendOpenAiError(res, 403, "forbidden origin", "permission_error");
      return;
    }
    // ── 闸 3：Bearer ───────────────────────────────────────────────────
    const auth = String(req.headers.authorization ?? "");
    if (auth !== `Bearer ${secret}`) {
      sendOpenAiError(res, 401, "invalid api key", "authentication_error");
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/v1/models") {
      let models = [];
      try {
        models = (await listModels?.()) ?? [];
      } catch (error) {
        logger?.warn?.("dsh-huaweicloud-connect: shim /v1/models failed", error);
        sendOpenAiError(res, 502, "model listing failed", "api_error");
        return;
      }
      sendJson(res, 200, { object: "list", data: models });
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      sendOpenAiError(res, 404, "not found", "invalid_request_error");
      return;
    }

    // ── 闸 4：JSON Content-Type ────────────────────────────────────────
    if (!String(req.headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
      sendOpenAiError(res, 415, "unsupported media type", "invalid_request_error");
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      sendOpenAiError(res, 413, String(error?.message ?? "body read failed"), "invalid_request_error");
      return;
    }

    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      sendOpenAiError(res, 400, "invalid JSON body", "invalid_request_error");
      return;
    }

    const model = typeof body?.model === "string" ? body.model : "";
    const normalized = normalizeChatBody(body, normalizeOptions?.(model) ?? {});

    const controller = new AbortController();
    const onClientGone = () => controller.abort();
    req.on("aborted", onClientGone);
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    let upstream;
    try {
      upstream = await dispatch({ body: normalized, signal: controller.signal, shimToken: secret });
    } catch (error) {
      if (controller.signal.aborted) return;
      const status = Number.isInteger(error?.status) ? error.status : 502;
      const message = String(error?.message ?? "upstream request failed");
      logger?.warn?.("dsh-huaweicloud-connect: upstream dispatch failed", error);
      sendOpenAiError(res, status, message, "api_error", error?.reasonCode ?? null);
      return;
    }

    res.writeHead(upstream.status ?? 200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const done = ensureDoneFrame();
    try {
      for await (const chunk of upstream.stream) {
        if (closed || controller.signal.aborted) break;
        const text = done.push(chunk);
        if (text.length > 0) {
          res.write(text);
          // 流式响应不做批量缓冲：显式 flush 由 Node 自动处理，这里只保证不背压失控。
          if (typeof res.flushHeaders === "function") res.flushHeaders();
        }
      }
      const tail = done.finish();
      if (tail.length > 0) res.write(tail);
    } catch (error) {
      logger?.warn?.("dsh-huaweicloud-connect: upstream stream interrupted", error);
      // 已经开始写响应头，无法再改状态码；至少补一个错误帧 + [DONE]，避免客户端挂到超时。
      const message = String(error?.message ?? "stream interrupted").replace(/\r?\n/g, " ");
      res.write(`data: ${JSON.stringify({ error: { message, type: "api_error" } })}\n\n`);
      res.write("data: [DONE]\n\n");
    } finally {
      res.end();
    }
  });

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    ready,
    baseUrl: () => origin,
    token: () => secret,
    close: () => {
      closed = true;
      try {
        server.close();
      } catch {
        /* 已关闭 */
      }
    },
  };
}

/** 仅供单测：把 Readable 拼成字符串的辅助。 */
export function decodeStream(decoderText) {
  const decoder = new StringDecoder("utf8");
  return decoder.write(Buffer.from(String(decoderText)));
}
