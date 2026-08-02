import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { accessKeyDigest, RelayError, readAccessKey } from "./relay-registry.mjs";

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const FORWARDED_REQUEST_HEADERS = new Set(["content-type", "idempotency-key", "accept"]);
const FORWARDED_RESPONSE_HEADERS = new Set(["content-type", "content-disposition", "etag", "last-modified"]);
const GZIP_MIN_BYTES = 1_024;
const gzipAsync = promisify(gzip);

export function registerControlRoutes(app, { registry, limiter, digestText, sendRateLimited }) {
  app.get("/v1/relay/desktop", {
    websocket: true,
    preValidation: (request, reply) => validateSocketKey(request, reply, limiter, digestText, sendRateLimited),
  }, (socket, request) => {
    const key = readAccessKey(request.headers);
    if (!key) return socket.close(4001, "Invalid key");
    if (!limiter.allow(`desktop:${digestText(request.ip)}`, 20)) return socket.close(4029, "Too many connections");
    const registered = registry.registerDesktop(key, socket, digestText(request.ip));
    if (!registered) socket.close(1013, "Server connection capacity reached");
  });

  app.get("/control/v1/events", {
    websocket: true,
    preValidation: (request, reply) => validateSocketKey(request, reply, limiter, digestText, sendRateLimited),
  }, (socket, request) => {
    const key = readAccessKey(request.headers);
    if (!key || !limiter.allow(`events:${accessKeyDigest(key)}`, 30)) return socket.close(4029, "Too many connections");
    if (!registry.attachEventSocket(key, socket, request.url.replace(/^\/control/, ""))) {
      socket.close(4004, "Desktop offline");
    }
  });

  app.all("/control/*", (request, reply) => proxyControlRequest({
    request,
    reply,
    registry,
    limiter,
    digestText,
    sendRateLimited,
  }));
}

async function validateSocketKey(request, reply, limiter, digestText, sendRateLimited) {
  if (readAccessKey(request.headers)) return;
  if (!limiter.allow(`auth:${digestText(request.ip)}`, 60)) return sendRateLimited(reply);
  return reply.code(401).send({ error: "invalid_key" });
}

async function proxyControlRequest({ request, reply, registry, limiter, digestText, sendRateLimited }) {
  const key = readAccessKey(request.headers);
  if (!key) {
    if (!limiter.allow(`auth:${digestText(request.ip)}`, 60)) return sendRateLimited(reply);
    return reply.code(401).send({ error: "invalid_key" });
  }
  if (!limiter.allow(`request:${accessKeyDigest(key)}`, 240)) return sendRateLimited(reply);
  if (!ALLOWED_METHODS.has(request.method)) {
    reply.header("Allow", [...ALLOWED_METHODS].join(", "));
    return reply.code(405).send({ error: "method_not_allowed" });
  }
  const path = safeControlPath(request.url.replace(/^\/control/, ""));
  if (!path) return reply.code(404).send({ error: "not_found" });
  const body = encodeRequestBody(request.body);
  try {
    const response = await registry.proxyRequest(key, {
      method: request.method,
      path,
      headers: selectHeaders(request.headers, FORWARDED_REQUEST_HEADERS),
      bodyBase64: body.toString("base64"),
    });
    const statusCode = Number.isInteger(response.statusCode) && response.statusCode >= 100 && response.statusCode <= 599
      ? response.statusCode
      : 502;
    const responseHeaders = selectHeaders(response.headers, FORWARDED_RESPONSE_HEADERS);
    let responseBody = Buffer.from(String(response.bodyBase64 || ""), "base64");
    if (
      request.method !== "HEAD"
      && responseBody.byteLength >= GZIP_MIN_BYTES
      && acceptsEncoding(request.headers["accept-encoding"], "gzip")
      && isCompressibleContentType(responseHeaders["content-type"])
    ) {
      const compressed = await gzipAsync(responseBody, { level: 6 });
      if (compressed.byteLength < responseBody.byteLength) {
        responseBody = compressed;
        responseHeaders["content-encoding"] = "gzip";
        responseHeaders.vary = "Accept-Encoding";
      }
    }
    for (const [name, value] of Object.entries(responseHeaders)) reply.header(name, value);
    reply.header("Cache-Control", "no-store");
    return reply.code(statusCode).send(responseBody);
  } catch (error) {
    if (error instanceof RelayError) return reply.code(error.statusCode).send({ error: error.code });
    return reply.code(502).send({ error: "relay_failed" });
  }
}

function encodeRequestBody(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}

function selectHeaders(headers, allowed) {
  const selected = {};
  if (!headers || typeof headers !== "object") return selected;
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!allowed.has(normalized) || value === undefined) continue;
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    if (text.length > 8_192 || /[\r\n\0]/.test(text)) continue;
    selected[normalized] = text;
  }
  return selected;
}

function acceptsEncoding(value, encoding) {
  return String(value || "").split(",").some((entry) => {
    const [name, ...parameters] = entry.trim().toLowerCase().split(";");
    if (name !== encoding && name !== "*") return false;
    const quality = parameters
      .map((parameter) => /^q\s*=\s*(\d(?:\.\d+)?)$/.exec(parameter.trim()))
      .find(Boolean);
    return !quality || Number(quality[1]) > 0;
  });
}

function isCompressibleContentType(value) {
  return /^(?:text\/|application\/(?:[\w.+-]*\+)?(?:json|javascript|xml)\b|image\/svg\+xml\b)/i.test(String(value || ""));
}

function safeControlPath(value) {
  if (typeof value !== "string" || value.length > 32_768 || !value.startsWith("/v1/") || /[\0\\]/.test(value)) return null;
  try {
    const url = new URL(value, "http://localhost");
    return url.origin === "http://localhost" && url.pathname.startsWith("/v1/")
      ? `${url.pathname}${url.search}`
      : null;
  } catch {
    return null;
  }
}
