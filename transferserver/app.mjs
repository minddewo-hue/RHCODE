import websocket from "@fastify/websocket";
import Fastify, { LogController } from "fastify";
import path from "node:path";
import { registerControlRoutes } from "./control-routes.mjs";
import { accessKeyDigest, RelayRegistry } from "./relay-registry.mjs";
import { defaultUpdatesDirectory, registerUpdateRoutes } from "./update-routes.mjs";

const MAX_BODY_BYTES = 35 * 1024 * 1024;
const MAX_RELAY_FRAME_BYTES = 50 * 1024 * 1024;

export async function createTransferServer(options = {}) {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: options.bodyLimit ?? MAX_BODY_BYTES,
    trustProxy: options.trustProxy ?? false,
    connectionTimeout: 10_000,
    keepAliveTimeout: 5_000,
    requestTimeout: 70_000,
    maxRequestsPerSocket: 1_000,
    forceCloseConnections: "idle",
    http2: false,
    exposeHeadRoutes: false,
    routerOptions: { maxParamLength: 1_024 },
    onProtoPoisoning: "remove",
    onConstructorPoisoning: "remove",
    ...(options.https ? { https: options.https } : {}),
  });
  const registry = options.registry || new RelayRegistry(options.relay);
  const updatesDirectory = path.resolve(options.updatesDirectory
    || process.env.RHZYCODE_TRANSFER_UPDATES_DIR
    || defaultUpdatesDirectory);
  const requireTls = options.requireTls ?? process.env.NODE_ENV === "production";
  const limiter = new FixedWindowLimiter(options.rateLimit);
  const allowedOrigins = normalizedOrigins(options.allowedOrigins ?? process.env.RHZYCODE_TRANSFER_ALLOWED_ORIGINS);
  const allowedHosts = normalizedHosts(options.allowedHosts ?? process.env.RHZYCODE_TRANSFER_ALLOWED_HOSTS);

  app.server.maxHeadersCount = 64;
  app.server.headersTimeout = 15_000;
  app.server.requestTimeout = 70_000;
  app.server.keepAliveTimeout = 5_000;

  await app.register(websocket, { options: { maxPayload: MAX_RELAY_FRAME_BYTES } });

  app.addHook("onRequest", async (request, reply) => {
    if (allowedHosts.size && !allowedHosts.has(String(request.headers.host || "").toLowerCase())) {
      return reply.code(421).send({ error: "invalid_host" });
    }
    if (!limiter.allow(`global:${digestText(request.ip)}`, 600)) return sendRateLimited(reply);
    const isWebSocket = String(request.headers.upgrade || "").toLowerCase() === "websocket";
    const origin = String(request.headers.origin || "");
    // React Native/Expo WebSocket clients send local or app-scheme Origins.
    // Keep rejecting arbitrary browser origins while allowing native clients
    // to establish the authenticated event stream.
    if (isWebSocket && origin && !isAllowedWebSocketOrigin(origin, allowedOrigins)) {
      return reply.code(403).send({ error: "origin_not_allowed" });
    }
    if (!requireTls || request.url === "/health") return;
    const forwarded = String(request.headers["x-forwarded-proto"] || "").split(",")[0]?.trim();
    if (request.protocol !== "https" && forwarded !== "https") {
      return reply.code(426).send({ error: "tls_required" });
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("Cache-Control", reply.getHeader("Cache-Control") || "no-store");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    const forwarded = String(request.headers["x-forwarded-proto"] || "").split(",")[0]?.trim();
    if (request.protocol === "https" || forwarded === "https") {
      reply.header("Strict-Transport-Security", "max-age=31536000");
    }
    reply.removeHeader("Server");
    return payload;
  });

  const healthHandler = async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { status: "ok", onlineDesktops: registry.onlineDesktopCount };
  };
  app.get("/health", healthHandler);
  app.head("/health", healthHandler);

  registerUpdateRoutes(app, {
    updatesDirectory,
    allowRequest: (request) => limiter.allow(`updates:${digestText(request.ip)}`, 60),
  });
  registerControlRoutes(app, { registry, limiter, digestText, sendRateLimited });

  app.addHook("onClose", async () => registry.close());
  return { app, registry };
}

class FixedWindowLimiter {
  constructor({ windowMs = 60_000, maxEntries = 10_000 } = {}) {
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  allow(identity, limit) {
    const now = Date.now();
    let entry = this.entries.get(identity);
    if (!entry || now >= entry.resetAt) entry = { count: 0, resetAt: now + this.windowMs };
    entry.count += 1;
    this.entries.set(identity, entry);
    if (this.entries.size > this.maxEntries) {
      for (const [key, candidate] of this.entries) {
        if (now >= candidate.resetAt || this.entries.size > this.maxEntries) this.entries.delete(key);
        if (this.entries.size <= this.maxEntries) break;
      }
    }
    return entry.count <= limit;
  }
}

function digestText(value) {
  return accessKeyDigest(String(value));
}

function sendRateLimited(reply) {
  reply.header("Retry-After", "60");
  return reply.code(429).send({ error: "rate_limited" });
}

function normalizedOrigins(value) {
  const origins = new Set();
  for (const entry of listValues(value)) {
    try {
      origins.add(new URL(entry).origin);
    } catch {
      throw new Error("RHZYCODE_TRANSFER_ALLOWED_ORIGINS contains an invalid origin.");
    }
  }
  return origins;
}

function normalizedHosts(value) {
  return new Set(listValues(value).map((entry) => entry.toLowerCase()));
}

function isAllowedWebSocketOrigin(origin, allowedOrigins) {
  if (allowedOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === "exp:" || url.protocol === "exps:") return true;
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

function listValues(value) {
  if (Array.isArray(value)) return value.map(String).map((entry) => entry.trim()).filter(Boolean);
  return String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
}
