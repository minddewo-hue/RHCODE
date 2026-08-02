import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createTransferServer } from "../app.mjs";
import { resolveTransferServerConfig } from "../server.mjs";

const firstKey = `rhzy_${"S".repeat(43)}`;
const secondKey = `rhzy_${"T".repeat(43)}`;

test("defaults to port 8000 and fails closed for unsafe public listeners", () => {
  const local = resolveTransferServerConfig({
    RHZYCODE_TRANSFER_HOST: "127.0.0.1",
    RHZYCODE_TRANSFER_REQUIRE_TLS: "0",
  });
  assert.equal(local.port, 8000);
  assert.equal(local.https, null);

  const proxy = resolveTransferServerConfig({
    RHZYCODE_TRANSFER_HOST: "127.0.0.1",
    RHZYCODE_TRANSFER_TRUST_PROXY: "1",
    RHZYCODE_TRANSFER_ALLOWED_HOSTS: "transfer.example:8000",
  });
  assert.equal(proxy.port, 8000);
  assert.equal(proxy.trustProxy, true);

  assert.throws(() => resolveTransferServerConfig({
    RHZYCODE_TRANSFER_HOST: "0.0.0.0",
    RHZYCODE_TRANSFER_REQUIRE_TLS: "0",
  }), /ALLOW_PUBLIC_HTTP=1/);
  const publicHttp = resolveTransferServerConfig({
    RHZYCODE_TRANSFER_HOST: "0.0.0.0",
    RHZYCODE_TRANSFER_REQUIRE_TLS: "0",
    RHZYCODE_TRANSFER_ALLOW_PUBLIC_HTTP: "1",
    RHZYCODE_TRANSFER_ALLOWED_HOSTS: "218.201.210.211:8000",
  });
  assert.equal(publicHttp.allowPublicHttp, true);
  assert.throws(() => resolveTransferServerConfig({
    RHZYCODE_TRANSFER_HOST: "0.0.0.0",
    RHZYCODE_TRANSFER_REQUIRE_TLS: "0",
    RHZYCODE_TRANSFER_ALLOW_PUBLIC_HTTP: "1",
  }), /ALLOWED_HOSTS is required/);
  assert.throws(() => resolveTransferServerConfig({
    RHZYCODE_TRANSFER_HOST: "0.0.0.0",
    RHZYCODE_TRANSFER_TRUST_PROXY: "1",
  }), /Trusted-proxy mode must bind/);
  assert.throws(() => resolveTransferServerConfig({
    RHZYCODE_TRANSFER_HOST: "127.0.0.1",
  }), /TLS is required/);
  assert.throws(() => resolveTransferServerConfig({
    RHZYCODE_TRANSFER_HOST: "127.0.0.1",
    RHZYCODE_TRANSFER_TRUST_PROXY: "1",
  }), /ALLOWED_HOSTS is required/);
});

test("requires TLS, validates Host, and sets hardened response headers", async (context) => {
  const { app } = await createTransferServer({
    requireTls: true,
    allowedHosts: ["relay.example:8000"],
  });
  context.after(() => app.close());

  const wrongHost = await app.inject({ method: "GET", url: "/health", headers: { host: "attacker.example" } });
  assert.equal(wrongHost.statusCode, 421);

  const plaintext = await app.inject({
    method: "GET",
    url: "/control/v1/snapshot",
    headers: { host: "relay.example:8000", authorization: `Bearer ${firstKey}` },
  });
  assert.equal(plaintext.statusCode, 426);
  assert.equal(plaintext.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  assert.equal(plaintext.headers["x-content-type-options"], "nosniff");
  assert.equal(plaintext.headers["x-frame-options"], "DENY");
  assert.equal(plaintext.headers.server, undefined);
});

test("rejects browser-origin WebSocket connections unless explicitly allowed", async (context) => {
  const { app } = await createTransferServer({ requireTls: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");

  const statusCode = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/relay/desktop`, {
      headers: { Authorization: `Bearer ${firstKey}`, Origin: "https://attacker.example" },
    });
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    socket.once("open", () => reject(new Error("Browser-origin WebSocket unexpectedly connected.")));
    socket.once("error", () => undefined);
  });
  assert.equal(statusCode, 403);
});

test("rate limits repeated authentication failures", async (context) => {
  const { app } = await createTransferServer({ requireTls: false });
  context.after(() => app.close());
  for (let index = 0; index < 60; index += 1) {
    const rejected = await app.inject({ method: "GET", url: "/control/v1/snapshot" });
    assert.equal(rejected.statusCode, 401);
  }
  const limited = await app.inject({ method: "GET", url: "/control/v1/snapshot" });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "60");
});

test("caps the number of registered desktops", async (context) => {
  const { app } = await createTransferServer({
    requireTls: false,
    relay: { maxDesktops: 1 },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/v1/relay/desktop`;
  const first = new WebSocket(url, { headers: { Authorization: `Bearer ${firstKey}` } });
  context.after(() => first.close());
  await waitForMessage(first, "registered");

  const second = new WebSocket(url, { headers: { Authorization: `Bearer ${secondKey}` } });
  const closeCode = await new Promise((resolve, reject) => {
    second.once("close", resolve);
    second.once("error", reject);
  });
  assert.equal(closeCode, 1013);
});

test("rejects malformed desktop responses without forwarding them", async (context) => {
  const { app } = await createTransferServer({ requireTls: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const desktop = new WebSocket(`${baseUrl.replace("http:", "ws:")}/v1/relay/desktop`, {
    headers: { Authorization: `Bearer ${firstKey}` },
  });
  context.after(() => desktop.close());
  await waitForMessage(desktop, "registered");
  desktop.once("message", (data) => {
    const request = JSON.parse(data.toString());
    desktop.send(JSON.stringify({
      type: "response",
      id: request.id,
      statusCode: 200,
      headers: {},
      bodyBase64: "not-base64",
    }));
  });
  const response = await fetch(`${baseUrl}/control/v1/snapshot`, {
    headers: { Authorization: `Bearer ${firstKey}` },
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "invalid_desktop_response" });
});

test("rejects an oversized update manifest before parsing", async (context) => {
  const updatesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-transfer-oversized-"));
  fs.writeFileSync(path.join(updatesDirectory, "version.json"), "x".repeat(256 * 1024 + 1));
  context.after(() => fs.rmSync(updatesDirectory, { recursive: true, force: true }));
  const { app } = await createTransferServer({
    requireTls: false,
    updatesDirectory,
  });
  context.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/v1/updates/manifest" });
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), { error: "invalid_update_manifest" });
});

function waitForMessage(socket, expectedType) {
  return new Promise((resolve, reject) => {
    socket.on("message", (data) => {
      const value = JSON.parse(data.toString());
      if (value.type === expectedType) resolve(value);
    });
    socket.once("error", reject);
  });
}
