import { randomBytes } from "node:crypto";
import http from "node:http";
import { parseUpdateManifest } from "@rhzycode/update-contract";
import WebSocket from "ws";

const input = process.argv[2] || process.env.RHZYCODE_TRANSFER_AUDIT_URL;
if (!input) throw new Error("Usage: npm run audit:remote -- http://218.201.210.211:8000");
const target = new URL(input);
if (target.protocol !== "http:" || target.port !== "8000" || target.username || target.password) {
  throw new Error("The audit target must be an HTTP URL on explicit port 8000 without credentials.");
}
target.pathname = target.pathname.replace(/\/+$/, "");
target.search = "";
target.hash = "";

await checkHealth();
await checkHostValidation();
await checkAuthentication();
await checkWebSocketOrigin();
await checkRelayRoundTrip();
await checkUpdateManifest();
console.log(`[security-audit] PASS ${target.origin}`);

async function checkHealth() {
  const response = await request("/health");
  requireStatus(response, 200, "health endpoint");
  requireHeader(response, "content-security-policy", /default-src 'none'/i);
  requireHeader(response, "x-content-type-options", /^nosniff$/i);
  requireHeader(response, "x-frame-options", /^DENY$/i);
  const serverHeader = response.headers.get("server") || "";
  if (/\d|\//.test(serverHeader) || response.headers.has("x-powered-by")) {
    throw new Error("The public response exposes server version headers.");
  }
  const value = await response.json();
  if (value?.status !== "ok") throw new Error("The health response is invalid.");
}

async function checkHostValidation() {
  const status = await rawHttpStatus({ Host: "security-audit.invalid:8000" });
  if (status !== 421) throw new Error(`Host validation returned HTTP ${status}, expected 421.`);
}

async function checkAuthentication() {
  const response = await request("/control/v1/snapshot");
  requireStatus(response, 401, "control authentication");
  const text = await response.text();
  if (/rhzy_[A-Za-z0-9_-]{43}/.test(text)) throw new Error("An error response exposed an access KEY.");
}

async function checkWebSocketOrigin() {
  const url = new URL("/v1/relay/desktop", target);
  url.protocol = "ws:";
  const randomKey = `rhzy_${randomBytes(32).toString("base64url")}`;
  const status = await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${randomKey}`,
        Origin: "https://security-audit.invalid",
      },
      handshakeTimeout: 5_000,
    });
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    socket.once("open", () => {
      socket.close();
      reject(new Error("A cross-origin WebSocket connection was accepted."));
    });
    socket.once("error", reject);
  });
  if (status !== 403) throw new Error(`WebSocket Origin validation returned HTTP ${status}, expected 403.`);
}

async function checkRelayRoundTrip() {
  const key = `rhzy_${randomBytes(32).toString("base64url")}`;
  const relayUrl = new URL("/v1/relay/desktop", target);
  relayUrl.protocol = "ws:";
  const desktop = new WebSocket(relayUrl, {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: 5_000,
  });
  try {
    const registered = await nextJson(desktop);
    if (registered.type !== "registered") throw new Error("Desktop relay registration was not acknowledged.");
    const desktopRequest = nextJson(desktop).then((message) => {
      if (message.type !== "request" || typeof message.id !== "string") {
        throw new Error("The relay sent an invalid desktop request.");
      }
      desktop.send(JSON.stringify({
        type: "response",
        id: message.id,
        statusCode: 200,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({ audit: "ok" })).toString("base64"),
      }));
    });
    const response = await request("/control/v1/snapshot", {
      headers: { Authorization: `Bearer ${key}` },
    });
    await desktopRequest;
    requireStatus(response, 200, "relay round trip");
    if ((await response.json())?.audit !== "ok") throw new Error("The relay response body was changed.");
  } finally {
    desktop.close();
    await socketClosed(desktop);
  }
  const offline = await request("/control/v1/snapshot", {
    headers: { Authorization: `Bearer ${key}` },
  });
  requireStatus(offline, 503, "offline desktop rejection");
}

async function checkUpdateManifest() {
  const response = await request("/v1/updates/manifest");
  requireStatus(response, 200, "update manifest");
  parseUpdateManifest(await response.json());
}

function request(pathname, init = {}) {
  return fetch(new URL(pathname, target), {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
}

function rawHttpStatus(headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: 8000,
      path: "/health",
      method: "GET",
      headers,
      timeout: 8_000,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("timeout", () => request.destroy(new Error("Host validation request timed out.")));
    request.once("error", reject);
    request.end();
  });
}

function requireStatus(response, expected, label) {
  if (response.status !== expected) throw new Error(`${label} returned HTTP ${response.status}, expected ${expected}.`);
}

function requireHeader(response, name, pattern) {
  const value = response.headers.get(name) || "";
  if (!pattern.test(value)) throw new Error(`Security header ${name} is missing or invalid.`);
}

function nextJson(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function socketClosed(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", resolve));
}
