import { createHash, randomUUID } from "node:crypto";

const KEY_PATTERN = /^rhzy_[A-Za-z0-9_-]{43}$/;
const MAX_FRAME_BYTES = 50 * 1024 * 1024;
const MAX_BODY_BYTES = 35 * 1024 * 1024;
const MAX_BODY_BASE64_LENGTH = Math.ceil(MAX_BODY_BYTES / 3) * 4;
const MAX_SOCKET_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 16;
const MAX_EVENT_SOCKETS = 16;
const DEFAULT_MAX_DESKTOPS = 5_000;
const DEFAULT_MAX_DESKTOPS_PER_OWNER = 50;
const DEFAULT_MAX_PENDING_REQUESTS_GLOBAL = 1_000;
const DEFAULT_MAX_PENDING_ENCODED_BYTES_GLOBAL = 128 * 1024 * 1024;
const DEFAULT_MAX_EVENT_SOCKETS_GLOBAL = 2_000;

export function readAccessKey(headers) {
  const authorization = Array.isArray(headers.authorization)
    ? headers.authorization[0]
    : headers.authorization;
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization || ""));
  if (match && KEY_PATTERN.test(match[1])) return match[1];

  const protocols = String(headers["sec-websocket-protocol"] || "")
    .split(",")
    .map((value) => value.trim());
  const authProtocol = protocols.find((value) => value.startsWith("rhzycode.auth."));
  const protocolKey = authProtocol?.slice("rhzycode.auth.".length) || "";
  return KEY_PATTERN.test(protocolKey) ? protocolKey : null;
}

export function accessKeyDigest(key) {
  return createHash("sha256").update("rhzycode-transfer-v1\0").update(key).digest("base64url");
}

export class RelayRegistry {
  #desktops = new Map();
  #ownerCounts = new Map();
  #pendingCount = 0;
  #pendingEncodedBytes = 0;
  #peerCount = 0;
  #requestTimeoutMs;
  #maxDesktops;
  #maxDesktopsPerOwner;
  #maxPendingRequestsGlobal;
  #maxPendingEncodedBytesGlobal;
  #maxEventSocketsGlobal;

  constructor({
    requestTimeoutMs = 65_000,
    maxDesktops = DEFAULT_MAX_DESKTOPS,
    maxDesktopsPerOwner = DEFAULT_MAX_DESKTOPS_PER_OWNER,
    maxPendingRequestsGlobal = DEFAULT_MAX_PENDING_REQUESTS_GLOBAL,
    maxPendingEncodedBytesGlobal = DEFAULT_MAX_PENDING_ENCODED_BYTES_GLOBAL,
    maxEventSocketsGlobal = DEFAULT_MAX_EVENT_SOCKETS_GLOBAL,
  } = {}) {
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxDesktops = positiveInteger(maxDesktops, DEFAULT_MAX_DESKTOPS);
    this.#maxDesktopsPerOwner = positiveInteger(maxDesktopsPerOwner, DEFAULT_MAX_DESKTOPS_PER_OWNER);
    this.#maxPendingRequestsGlobal = positiveInteger(maxPendingRequestsGlobal, DEFAULT_MAX_PENDING_REQUESTS_GLOBAL);
    this.#maxPendingEncodedBytesGlobal = positiveInteger(
      maxPendingEncodedBytesGlobal,
      DEFAULT_MAX_PENDING_ENCODED_BYTES_GLOBAL,
    );
    this.#maxEventSocketsGlobal = positiveInteger(maxEventSocketsGlobal, DEFAULT_MAX_EVENT_SOCKETS_GLOBAL);
  }

  get onlineDesktopCount() {
    return this.#desktops.size;
  }

  registerDesktop(key, socket, ownerId = "unknown") {
    const digest = accessKeyDigest(key);
    const previous = this.#desktops.get(digest);
    if (previous) this.#closeSession(previous, 4002, "Desktop connection replaced");
    if (
      this.#desktops.size >= this.#maxDesktops
      || (this.#ownerCounts.get(ownerId) || 0) >= this.#maxDesktopsPerOwner
    ) return null;

    const session = {
      digest,
      ownerId,
      socket,
      pending: new Map(),
      peers: new Map(),
      closed: false,
      heartbeat: null,
    };
    this.#desktops.set(digest, session);
    this.#ownerCounts.set(ownerId, (this.#ownerCounts.get(ownerId) || 0) + 1);
    let alive = true;
    socket.on("pong", () => { alive = true; });
    session.heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 30_000);
    session.heartbeat.unref?.();
    socket.on("message", (data) => this.#handleDesktopMessage(session, data));
    socket.once("close", () => {
      this.#removeSession(session);
    });
    socket.once("error", () => {
      // Removing the registry entry alone can leave the desktop with an open
      // TCP/WebSocket object, so it never reconnects even though mobile sees
      // desktop_offline. Terminate the failed transport as well.
      this.#removeSession(session);
      if (socket.readyState === 0 || socket.readyState === 1) socket.terminate();
    });
    this.#send(socket, { type: "registered" });
    return session;
  }

  desktopForKey(key) {
    return this.#desktops.get(accessKeyDigest(key)) || null;
  }

  proxyRequest(key, request) {
    const session = this.desktopForKey(key);
    if (!session || session.closed || session.socket.readyState !== 1) {
      return Promise.reject(new RelayError("desktop_offline", "The desktop is offline.", 503));
    }
    const encodedBytes = Buffer.byteLength(String(request.bodyBase64 || ""));
    if (
      session.pending.size >= MAX_PENDING_REQUESTS
      || this.#pendingCount >= this.#maxPendingRequestsGlobal
      || this.#pendingEncodedBytes + encodedBytes > this.#maxPendingEncodedBytesGlobal
    ) {
      return Promise.reject(new RelayError("desktop_busy", "The desktop has too many active requests.", 429));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.pending.delete(id)) this.#releasePending(encodedBytes);
        reject(new RelayError("desktop_timeout", "The desktop did not respond in time.", 504));
      }, this.#requestTimeoutMs);
      timer.unref?.();
      session.pending.set(id, { resolve, reject, timer, encodedBytes });
      this.#pendingCount += 1;
      this.#pendingEncodedBytes += encodedBytes;
      if (!this.#send(session.socket, { type: "request", id, ...request })) {
        clearTimeout(timer);
        if (session.pending.delete(id)) this.#releasePending(encodedBytes);
        reject(new RelayError("desktop_offline", "The desktop is offline.", 503));
      }
    });
  }

  attachEventSocket(key, socket, path) {
    const session = this.desktopForKey(key);
    if (!session || session.closed || session.socket.readyState !== 1) return false;
    if (session.peers.size >= MAX_EVENT_SOCKETS || this.#peerCount >= this.#maxEventSocketsGlobal) return false;
    const id = randomUUID();
    session.peers.set(id, socket);
    this.#peerCount += 1;
    socket.on("message", (data) => {
      if (byteLength(data) > MAX_FRAME_BYTES) return socket.close(1009, "Frame too large");
      if (!this.#send(session.socket, { type: "socket.message", id, dataBase64: toBuffer(data).toString("base64") })) {
        socket.close(1013, "Relay backpressure limit reached");
      }
    });
    socket.once("close", () => {
      if (session.peers.delete(id)) this.#peerCount -= 1;
      this.#send(session.socket, { type: "socket.close", id });
    });
    if (!this.#send(session.socket, { type: "socket.open", id, path })) {
      if (session.peers.delete(id)) this.#peerCount -= 1;
      return false;
    }
    return true;
  }

  close() {
    for (const session of this.#desktops.values()) this.#closeSession(session, 1001, "Server shutting down");
    this.#desktops.clear();
  }

  #handleDesktopMessage(session, data) {
    if (byteLength(data) > MAX_FRAME_BYTES) return this.#closeSession(session, 1009, "Frame too large");
    let message;
    try {
      message = JSON.parse(toBuffer(data).toString("utf8"));
    } catch {
      return this.#closeSession(session, 1003, "Invalid relay frame");
    }
    if (!message || typeof message !== "object" || typeof message.type !== "string") return;

    if (message.type === "response" && typeof message.id === "string") {
      const pending = session.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      if (session.pending.delete(message.id)) this.#releasePending(pending.encodedBytes);
      if (!validResponseMessage(message)) {
        pending.reject(new RelayError("invalid_desktop_response", "The desktop returned an invalid relay response.", 502));
        return;
      }
      pending.resolve(message);
      return;
    }

    if (
      message.type === "socket.message"
      && typeof message.id === "string"
      && validBase64(message.dataBase64, MAX_BODY_BASE64_LENGTH)
    ) {
      const peer = session.peers.get(message.id);
      if (peer?.readyState === 1) {
        if (peer.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) peer.close(1013, "Relay backpressure limit reached");
        else peer.send(Buffer.from(message.dataBase64, "base64").toString("utf8"));
      }
      return;
    }

    if (message.type === "socket.close" && typeof message.id === "string") {
      const peer = session.peers.get(message.id);
      if (session.peers.delete(message.id)) this.#peerCount -= 1;
      if (peer?.readyState === 1) peer.close(normalizeCloseCode(message.code), "Desktop event stream closed");
    }
  }

  #removeSession(session) {
    if (session.closed) return;
    session.closed = true;
    if (session.heartbeat) clearInterval(session.heartbeat);
    if (this.#desktops.get(session.digest) === session) {
      this.#desktops.delete(session.digest);
      const ownerCount = (this.#ownerCounts.get(session.ownerId) || 1) - 1;
      if (ownerCount > 0) this.#ownerCounts.set(session.ownerId, ownerCount);
      else this.#ownerCounts.delete(session.ownerId);
    }
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      this.#releasePending(pending.encodedBytes);
      pending.reject(new RelayError("desktop_offline", "The desktop went offline.", 503));
    }
    session.pending.clear();
    this.#peerCount -= session.peers.size;
    for (const peer of session.peers.values()) {
      if (peer.readyState === 1) peer.close(4004, "Desktop offline");
    }
    session.peers.clear();
  }

  #closeSession(session, code, reason) {
    this.#removeSession(session);
    if (session.socket.readyState === 0 || session.socket.readyState === 1) session.socket.close(code, reason);
  }

  #send(socket, value) {
    if (socket.readyState !== 1 || socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) return false;
    socket.send(JSON.stringify(value));
    return true;
  }

  #releasePending(encodedBytes) {
    this.#pendingCount = Math.max(0, this.#pendingCount - 1);
    this.#pendingEncodedBytes = Math.max(0, this.#pendingEncodedBytes - encodedBytes);
  }
}

export class RelayError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.map(toBuffer));
  return Buffer.from(data);
}

function byteLength(data) {
  return toBuffer(data).byteLength;
}

function normalizeCloseCode(value) {
  return Number.isInteger(value) && value >= 1000 && value <= 4999 ? value : 1000;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function validResponseMessage(value) {
  return Number.isInteger(value.statusCode)
    && value.statusCode >= 200
    && value.statusCode <= 599
    && (value.headers === undefined || isRecord(value.headers))
    && validBase64(value.bodyBase64, MAX_BODY_BASE64_LENGTH);
}

function validBase64(value, maxLength) {
  if (typeof value !== "string" || value.length > maxLength || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = value.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!valid) return false;
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
