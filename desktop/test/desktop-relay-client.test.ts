import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { DesktopRelayClient } from "../src/main/desktop-relay-client";

const key = `rhzy_${"R".repeat(43)}`;

test("carries a public mobile request through the desktop reverse tunnel", async (context) => {
  // transferserver is runtime JavaScript and intentionally has no TypeScript build step.
  // @ts-expect-error Cross-workspace JavaScript module has no declaration file.
  const { createTransferServer } = await import("../../transferserver/app.mjs");
  const local = createServer((request, response) => {
    assert.equal(request.url, "/v1/snapshot");
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ hosts: [], lastSequence: 12 }));
  });
  await listen(local);
  context.after(() => new Promise<void>((resolve) => local.close(() => resolve())));
  const localAddress = local.address();
  assert.ok(localAddress && typeof localAddress === "object");

  const { app } = await createTransferServer({ requireTls: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());
  const relayAddress = app.server.address();
  assert.ok(relayAddress && typeof relayAddress === "object");
  const relayUrl = `http://127.0.0.1:${relayAddress.port}`;

  const client = new DesktopRelayClient({ serverUrl: relayUrl });
  client.on("error", () => undefined);
  client.start(`http://127.0.0.1:${localAddress.port}`, key);
  context.after(() => client.stop());
  await waitFor(async () => (await fetch(`${relayUrl}/health`)).json().then((value) => value.onlineDesktops === 1));

  const response = await fetch(`${relayUrl}/control/v1/snapshot`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { hosts: [], lastSequence: 12 });

  client.stop();
  await waitFor(async () => (await fetch(`${relayUrl}/health`)).json().then((value) => value.onlineDesktops === 0));
  const offline = await fetch(`${relayUrl}/control/v1/snapshot`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(offline.status, 503);
});

test("buffers a mobile heartbeat while the local event socket is connecting", async (context) => {
  const local = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const localEvents = new WebSocketServer({
    server: local,
    path: "/v1/events",
    verifyClient: (_info, done) => setTimeout(() => done(true), 100),
  });
  await listen(local);
  const localAddress = local.address();
  assert.ok(localAddress && typeof localAddress === "object");

  // transferserver is runtime JavaScript and intentionally has no TypeScript build step.
  // @ts-expect-error Cross-workspace JavaScript module has no declaration file.
  const { createTransferServer } = await import("../../transferserver/app.mjs");
  const { app } = await createTransferServer({ requireTls: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const relayAddress = app.server.address();
  assert.ok(relayAddress && typeof relayAddress === "object");
  const relayUrl = `http://127.0.0.1:${relayAddress.port}`;

  const client = new DesktopRelayClient({ serverUrl: relayUrl });
  client.on("error", () => undefined);
  client.start(`http://127.0.0.1:${localAddress.port}`, key);
  let mobile: WebSocket | null = null;
  context.after(async () => {
    mobile?.terminate();
    client.stop();
    await app.close();
    await new Promise<void>((resolve) => localEvents.close(() => resolve()));
    if (local.listening) await new Promise<void>((resolve) => local.close(() => resolve()));
  });
  await waitFor(async () => (await fetch(`${relayUrl}/health`)).json().then((value) => value.onlineDesktops === 1));

  const localFrame = new Promise<string>((resolve, reject) => {
    localEvents.once("connection", (socket) => {
      socket.once("message", (data) => resolve(data.toString()));
      socket.once("error", reject);
    });
    localEvents.once("error", reject);
  });
  mobile = new WebSocket(`${relayUrl.replace("http:", "ws:")}/control/v1/events?after=0`, [
    "rhzycode.v1",
    `rhzycode.auth.${key}`,
  ]);
  await onceOpen(mobile);
  mobile.send(JSON.stringify({ type: "control.ping", id: "weak-network-heartbeat" }));
  assert.deepEqual(JSON.parse(await localFrame), {
    type: "control.ping",
    id: "weak-network-heartbeat",
  });
});

test("reconnects when a relay socket errors without first closing", async (context) => {
  const local = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ hosts: [], lastSequence: 3 }));
  });
  await listen(local);
  const localAddress = local.address();
  assert.ok(localAddress && typeof localAddress === "object");

  const relayHttp = createServer();
  const relaySockets = new WebSocketServer({ noServer: true });
  let connectionCount = 0;
  relayHttp.on("upgrade", (request, socket, head) => {
    relaySockets.handleUpgrade(request, socket, head, (webSocket) => {
      connectionCount += 1;
      webSocket.send(JSON.stringify({ type: "registered" }));
    });
  });
  await listen(relayHttp);
  const relayAddress = relayHttp.address();
  assert.ok(relayAddress && typeof relayAddress === "object");

  const client = new DesktopRelayClient({
    serverUrl: `http://127.0.0.1:${relayAddress.port}`,
    reconnectDelaysMs: [10],
  });
  client.on("error", () => undefined);
  client.start(`http://127.0.0.1:${localAddress.port}`, key);
  context.after(async () => {
    client.stop();
    relaySockets.close();
    await new Promise<void>((resolve) => relayHttp.close(() => resolve()));
    await new Promise<void>((resolve) => local.close(() => resolve()));
  });
  await waitFor(async () => connectionCount === 1);

  // Reproduce a transport error that does not rely on a close event to drive
  // recovery. This is the stale-registration failure seen in production.
  const desktopSocket = (client as unknown as { socket: WebSocket | null }).socket;
  assert.ok(desktopSocket);
  desktopSocket.emit("error", new Error("simulated relay transport failure"));

  await waitFor(async () => connectionCount >= 2);
});

test("reconnects when a half-open relay stops answering heartbeats", async (context) => {
  const local = createServer((_request, response) => response.end());
  await listen(local);
  const localAddress = local.address();
  assert.ok(localAddress && typeof localAddress === "object");

  const relayHttp = createServer();
  const relaySockets = new WebSocketServer({ noServer: true, autoPong: false });
  let connectionCount = 0;
  relayHttp.on("upgrade", (request, socket, head) => {
    relaySockets.handleUpgrade(request, socket, head, (webSocket) => {
      connectionCount += 1;
      webSocket.send(JSON.stringify({ type: "registered" }));
    });
  });
  await listen(relayHttp);
  const relayAddress = relayHttp.address();
  assert.ok(relayAddress && typeof relayAddress === "object");

  const client = new DesktopRelayClient({
    serverUrl: `http://127.0.0.1:${relayAddress.port}`,
    reconnectDelaysMs: [10],
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 10,
  });
  client.on("error", () => undefined);
  client.start(`http://127.0.0.1:${localAddress.port}`, key);
  context.after(async () => {
    client.stop();
    relaySockets.close();
    await new Promise<void>((resolve) => relayHttp.close(() => resolve()));
    await new Promise<void>((resolve) => local.close(() => resolve()));
  });

  await waitFor(async () => connectionCount >= 2);
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for relay state.");
}

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}
