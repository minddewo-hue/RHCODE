import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";

const MAX_RELAY_BODY_BYTES = 35 * 1024 * 1024;
const MAX_RELAY_FRAME_BYTES = 50 * 1024 * 1024;
const MAX_SOCKET_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_EVENT_FRAME_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 65_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;

interface DesktopRelayClientOptions {
  serverUrl: string;
  fetchImpl?: typeof fetch;
  reconnectDelaysMs?: readonly number[];
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

export class DesktopRelayClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private eventSockets = new Map<string, WebSocket>();
  private pendingEventFrames = new Map<string, Buffer>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatTimeout: NodeJS.Timeout | null = null;
  private stopped = true;
  private localUrl = "";
  private accessKey = "";
  private readonly fetchImpl: typeof fetch;
  private readonly reconnectDelaysMs: readonly number[];

  constructor(private readonly options: DesktopRelayClientOptions) {
    super();
    this.fetchImpl = options.fetchImpl || fetch;
    this.reconnectDelaysMs = options.reconnectDelaysMs?.length
      ? options.reconnectDelaysMs
      : RECONNECT_DELAYS_MS;
  }

  start(localUrl: string, accessKey: string): void {
    this.localUrl = normalizeLocalUrl(localUrl);
    this.accessKey = accessKey;
    this.stopped = false;
    this.connect();
  }

  updateAccess(localUrl: string, accessKey: string): void {
    const nextLocalUrl = normalizeLocalUrl(localUrl);
    if (this.localUrl === nextLocalUrl && this.accessKey === accessKey && !this.stopped) return;
    this.localUrl = nextLocalUrl;
    this.accessKey = accessKey;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.disconnect(4000, "Relay credentials changed");
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.disconnect(1000, "Desktop shutting down");
  }

  private connect(): void {
    if (this.stopped || !this.localUrl || !this.accessKey || this.socket) return;
    let url: URL;
    try {
      url = new URL(this.options.serverUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/relay/desktop`;
      url.search = "";
      url.hash = "";
    } catch {
      this.emit("error", new Error("Transfer server URL is invalid."));
      return;
    }
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.accessKey}` },
      handshakeTimeout: 10_000,
      maxPayload: MAX_RELAY_FRAME_BYTES,
    });
    this.socket = socket;
    socket.once("open", () => {
      this.reconnectAttempt = 0;
      this.startHeartbeat(socket);
      this.emit("status", "online");
    });
    socket.on("pong", () => {
      if (this.socket === socket) this.clearHeartbeatTimeout();
    });
    socket.on("message", (data) => void this.handleMessage(socket, data));
    socket.once("error", (error) => {
      this.emit("error", error);
      // A WebSocket error is not guaranteed to be followed by close. If the
      // relay has already evicted this registration, keeping the stale socket
      // here prevents connect() from ever registering the desktop again.
      if (this.socket === socket) {
        this.socket = null;
        this.stopHeartbeat();
        this.closeEventSockets();
        socket.terminate();
        this.emit("status", "offline");
        this.scheduleReconnect();
      }
    });
    socket.once("close", () => {
      // An intentionally replaced socket may close after the new connection
      // has opened. It must not tear down the replacement's heartbeat/events.
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      this.closeEventSockets();
      this.emit("status", "offline");
      this.scheduleReconnect();
    });
  }

  private async handleMessage(relaySocket: WebSocket, data: RawData): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(rawDataBuffer(data).toString("utf8")) as Record<string, unknown>;
    } catch {
      relaySocket.close(1003, "Invalid relay frame");
      return;
    }
    if (message.type === "request") await this.forwardRequest(relaySocket, message);
    if (message.type === "socket.open") this.openEventSocket(relaySocket, message);
    if (message.type === "socket.message") this.forwardEventMessage(message);
    if (message.type === "socket.close") this.closeEventSocket(message);
  }

  private async forwardRequest(relaySocket: WebSocket, message: Record<string, unknown>): Promise<void> {
    const id = typeof message.id === "string" ? message.id : "";
    const method = typeof message.method === "string" ? message.method.toUpperCase() : "";
    const requestPath = safeControlPath(message.path);
    if (!id || !requestPath || !new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).has(method)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const body = typeof message.bodyBase64 === "string" ? Buffer.from(message.bodyBase64, "base64") : Buffer.alloc(0);
      if (body.byteLength > MAX_RELAY_BODY_BYTES) throw new Error("Relay request is too large.");
      const response = await this.fetchImpl(`${this.localUrl}${requestPath}`, {
        method,
        headers: { ...safeHeaders(message.headers), Authorization: `Bearer ${this.accessKey}` },
        body: method === "GET" || method === "HEAD" || body.byteLength === 0 ? undefined : body,
        signal: controller.signal,
      });
      const responseBody = Buffer.from(await response.arrayBuffer());
      if (responseBody.byteLength > MAX_RELAY_BODY_BYTES) throw new Error("Relay response is too large.");
      this.send(relaySocket, {
        type: "response",
        id,
        statusCode: response.status,
        headers: responseHeaders(response.headers),
        bodyBase64: responseBody.toString("base64"),
      });
    } catch (error) {
      this.send(relaySocket, {
        type: "response",
        id,
        statusCode: 502,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({
          error: "desktop_relay_failed",
          message: error instanceof Error && error.name === "AbortError" ? "Local request timed out." : "Local request failed.",
        })).toString("base64"),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private openEventSocket(relaySocket: WebSocket, message: Record<string, unknown>): void {
    const id = typeof message.id === "string" ? message.id : "";
    const requestPath = safeControlPath(message.path);
    if (!id || !requestPath || this.eventSockets.has(id)) return;
    const url = new URL(requestPath, this.localUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const eventSocket = new WebSocket(url, ["rhzycode.v1", `rhzycode.auth.${this.accessKey}`], {
      maxPayload: MAX_RELAY_FRAME_BYTES,
    });
    this.eventSockets.set(id, eventSocket);
    eventSocket.once("open", () => {
      const pending = this.pendingEventFrames.get(id);
      this.pendingEventFrames.delete(id);
      if (pending && eventSocket.readyState === WebSocket.OPEN) eventSocket.send(pending);
    });
    eventSocket.on("message", (data) => this.send(relaySocket, {
      type: "socket.message",
      id,
      dataBase64: rawDataBuffer(data).toString("base64"),
    }));
    eventSocket.once("close", (code) => {
      this.eventSockets.delete(id);
      this.pendingEventFrames.delete(id);
      this.send(relaySocket, { type: "socket.close", id, code });
    });
    eventSocket.once("error", () => eventSocket.close());
  }

  private forwardEventMessage(message: Record<string, unknown>): void {
    const socket = typeof message.id === "string" ? this.eventSockets.get(message.id) : null;
    if (!socket || typeof message.id !== "string" || typeof message.dataBase64 !== "string") return;
    const frame = Buffer.from(message.dataBase64, "base64");
    if (socket.readyState === WebSocket.CONNECTING) {
      if (frame.byteLength > MAX_PENDING_EVENT_FRAME_BYTES) socket.close(1009, "Pending event frame too large");
      else this.pendingEventFrames.set(message.id, frame);
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) socket.close(1013, "Relay backpressure limit reached");
      else socket.send(frame);
    }
  }

  private closeEventSocket(message: Record<string, unknown>): void {
    if (typeof message.id !== "string") return;
    const socket = this.eventSockets.get(message.id);
    this.eventSockets.delete(message.id);
    this.pendingEventFrames.delete(message.id);
    socket?.close(1000, "Mobile event stream closed");
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelaysMs[
      Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)
    ];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    const intervalMs = this.options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    const timeoutMs = this.options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.heartbeatInterval = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      this.clearHeartbeatTimeout();
      socket.ping();
      this.heartbeatTimeout = setTimeout(() => {
        if (this.socket === socket) socket.terminate();
      }, timeoutMs);
      this.heartbeatTimeout.unref();
    }, intervalMs);
    this.heartbeatInterval.unref();
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    this.heartbeatTimeout = null;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
    this.clearHeartbeatTimeout();
  }

  private disconnect(code: number, reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.stopHeartbeat();
    this.closeEventSockets();
    if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) socket.close(code, reason);
  }

  private closeEventSockets(): void {
    for (const socket of this.eventSockets.values()) socket.close(1001, "Relay disconnected");
    this.eventSockets.clear();
    this.pendingEventFrames.clear();
  }

  private send(socket: WebSocket, value: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
      socket.close(1013, "Relay backpressure limit reached");
      return;
    }
    socket.send(JSON.stringify(value));
  }
}

function normalizeLocalUrl(value: string): string {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Local control URL is invalid.");
  return url.toString().replace(/\/+$/, "");
}

function safeControlPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/v1/") || value.includes("\0") || value.includes("\\")) return null;
  try {
    const url = new URL(value, "http://localhost");
    return url.origin === "http://localhost" && url.pathname.startsWith("/v1/") ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

function safeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const allowed = new Set(["content-type", "idempotency-key", "accept"]);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([name, entry]) => (
    allowed.has(name.toLowerCase()) && typeof entry === "string" ? [[name.toLowerCase(), entry]] : []
  )));
}

function responseHeaders(headers: Headers): Record<string, string> {
  const allowed = new Set(["content-type", "content-length", "content-disposition", "etag", "last-modified"]);
  return Object.fromEntries([...headers.entries()].filter(([name]) => allowed.has(name.toLowerCase())));
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new Error("Unsupported WebSocket frame type.");
}
