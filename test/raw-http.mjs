/**
 * 发一条**原始 HTTP 请求**，可以伪造 Host / Origin 头。
 *
 * 为什么不用 fetch：WHATWG fetch 出于安全会**丢弃并重写** Host 头，
 * 所以 `fetch(url, { headers: { host: "evil" } })` 根本改不了它 ——
 * 那样测出来的「回环闸通过」是假阳性。回环闸必须用裸 socket 测。
 *
 * @param {object} options
 * @param {number} options.port
 * @param {string} options.path
 * @param {string} options.method
 * @param {Record<string,string>} [options.headers]
 * @param {string} [options.body]
 * @returns {Promise<{status: number, headers: Record<string,string>, body: string}>}
 */
import { connect } from "node:net";

export function rawRequest({ port, path, method = "GET", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" }, () => {
      const lines = [`${method} ${path} HTTP/1.1`];
      // Host 必须显式给出（HTTP/1.1 必需），默认值由调用方决定
      if (headers.host === undefined) lines.push(`Host: 127.0.0.1:${port}`);
      for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === "host") lines.push(`Host: ${value}`);
        else lines.push(`${name}: ${value}`);
      }
      if (body !== undefined) {
        lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
        if (headers["content-type"] === undefined && headers["Content-Type"] === undefined) {
          lines.push("Content-Type: application/json");
        }
      }
      lines.push("Connection: close", "", body ?? "");
      socket.write(lines.join("\r\n"));
    });

    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      const head = split === -1 ? text : text.slice(0, split);
      const payload = split === -1 ? "" : text.slice(split + 4);
      const statusLine = head.split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? 0);
      const responseHeaders = {};
      for (const line of head.split("\r\n").slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) responseHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({ status, headers: responseHeaders, body: payload });
    });
  });
}
