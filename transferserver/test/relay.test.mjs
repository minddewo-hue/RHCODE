import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { gunzipSync } from "node:zlib";
import { createTransferServer } from "../app.mjs";
import { accessKeyDigest } from "../relay-registry.mjs";

const key = `rhzy_${"A".repeat(43)}`;

test("forwards control requests only while the matching desktop is online", async (context) => {
  const { app } = await createTransferServer({ requireTls: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const desktop = new WebSocket(`${baseUrl.replace("http:", "ws:")}/v1/relay/desktop`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  context.after(() => desktop.close());
  await nextJson(desktop, "registered");

  desktop.once("message", (data) => {
    const request = JSON.parse(data.toString());
    assert.equal(request.type, "request");
    assert.equal(request.path, "/v1/snapshot");
    desktop.send(JSON.stringify({
      type: "response",
      id: request.id,
      statusCode: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from(JSON.stringify({ lastSequence: 7 })).toString("base64"),
    }));
  });
  const response = await fetch(`${baseUrl}/control/v1/snapshot`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { lastSequence: 7 });

  desktop.close();
  await onceClosed(desktop);
  const offline = await fetch(`${baseUrl}/control/v1/snapshot`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(offline.status, 503);
  assert.deepEqual(await offline.json(), { error: "desktop_offline" });
});

test("forwards a large desktop snapshot without exhausting the server stack", async (context) => {
  const { app } = await createTransferServer({ requireTls: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const desktop = new WebSocket(`${baseUrl.replace("http:", "ws:")}/v1/relay/desktop`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  context.after(() => desktop.close());
  await nextJson(desktop, "registered");
  const snapshot = Buffer.alloc(12 * 1024 * 1024, 0x61);
  desktop.once("message", (data) => {
    const request = JSON.parse(data.toString());
    desktop.send(JSON.stringify({
      type: "response",
      id: request.id,
      statusCode: 200,
      headers: { "content-type": "application/octet-stream" },
      bodyBase64: snapshot.toString("base64"),
    }));
  });
  const response = await fetch(`${baseUrl}/control/v1/snapshot`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), snapshot);
  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
});

test("compresses large JSON relay responses for slow mobile links", async (context) => {
  const { app } = await createTransferServer({ requireTls: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const desktop = new WebSocket(`ws://127.0.0.1:${address.port}/v1/relay/desktop`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  context.after(() => desktop.close());
  await nextJson(desktop, "registered");
  const snapshot = JSON.stringify({ timeline: [{ content: "mobile-data-".repeat(200_000) }] });
  desktop.once("message", (data) => {
    const request = JSON.parse(data.toString());
    desktop.send(JSON.stringify({
      type: "response",
      id: request.id,
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      bodyBase64: Buffer.from(snapshot).toString("base64"),
    }));
  });
  const response = await app.inject({
    method: "GET",
    url: "/control/v1/snapshot",
    headers: {
      authorization: `Bearer ${key}`,
      "accept-encoding": "br, gzip",
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.equal(response.headers.vary, "Accept-Encoding");
  assert.ok(response.rawPayload.byteLength < Buffer.byteLength(snapshot) / 10);
  assert.equal(gunzipSync(response.rawPayload).toString(), snapshot);
});

test("forwards event frames and exposes no raw KEY in public status", async (context) => {
  const { app } = await createTransferServer({ requireTls: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const wsBase = `ws://127.0.0.1:${address.port}`;
  const desktop = new WebSocket(`${wsBase}/v1/relay/desktop`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  await nextJson(desktop, "registered");
  const mobile = new WebSocket(`${wsBase}/control/v1/events?after=0`, ["rhzycode.v1", `rhzycode.auth.${key}`]);
  context.after(() => {
    desktop.close();
    mobile.close();
  });
  const opened = await nextJson(desktop, "socket.open");
  const event = { type: "host.status", sequence: 1 };
  desktop.send(JSON.stringify({
    type: "socket.message",
    id: opened.id,
    dataBase64: Buffer.from(JSON.stringify(event)).toString("base64"),
  }));
  const forwarded = await nextFrame(mobile);
  assert.equal(forwarded.isBinary, false);
  assert.deepEqual(JSON.parse(forwarded.data.toString()), event);

  const health = await fetch(`http://127.0.0.1:${address.port}/health`);
  const body = await health.text();
  assert.equal(body.includes(key), false);
  assert.equal(body.includes(accessKeyDigest(key)), false);
  assert.deepEqual(JSON.parse(body), { status: "ok", onlineDesktops: 1 });
});

test("serves only a validated update manifest", async (context) => {
  const updatesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-transfer-updates-"));
  context.after(() => fs.rmSync(updatesDirectory, { recursive: true, force: true }));
  const manifest = {
    schemaVersion: 2,
    publishedAt: "2026-07-29T00:00:00.000Z",
    platforms: {
      android: {
        version: "1.0.0",
        versionCode: 1,
        file: "android/app.apk",
        downloadUrl: "http://127.0.0.1:8000/updates/android/app.apk",
        bytes: 11,
        sha256: "a".repeat(64),
        releaseNotes: "Initial release",
      },
    },
  };
  fs.mkdirSync(path.join(updatesDirectory, "android"));
  fs.writeFileSync(path.join(updatesDirectory, "version.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(updatesDirectory, "android", "app.apk"), "hello world");
  const { app } = await createTransferServer({
    requireTls: false,
    updatesDirectory,
  });
  context.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/v1/updates/manifest" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ...manifest,
    platforms: {
      android: {
        platform: "android",
        version: "1.0.0",
        versionCode: 1,
        downloadUrl: "http://127.0.0.1:8000/updates/android/app.apk",
        bytes: 11,
        sha256: "a".repeat(64),
        releaseNotes: "Initial release",
      },
    },
  });
  assert.equal(response.headers["cache-control"], "no-cache, no-store, must-revalidate");

  const artifact = await app.inject({ method: "GET", url: "/updates/android/app.apk" });
  assert.equal(artifact.statusCode, 200);
  assert.equal(artifact.body, "hello world");
  assert.equal(artifact.headers["content-type"], "application/vnd.android.package-archive");
  assert.equal(artifact.headers["content-length"], "11");
  const range = await app.inject({
    method: "GET",
    url: "/updates/android/app.apk",
    headers: { range: "bytes=6-10" },
  });
  assert.equal(range.statusCode, 206);
  assert.equal(range.body, "world");
  assert.equal(range.headers["content-range"], "bytes 6-10/11");
  const head = await app.inject({ method: "HEAD", url: "/updates/android/app.apk" });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers["content-length"], "11");
  assert.equal(head.body, "");
  const traversal = await app.inject({ method: "GET", url: "/updates/%2e%2e/app.mjs" });
  assert.equal(traversal.statusCode, 404);
});

function nextJson(socket, type) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      try {
        const value = JSON.parse(data.toString());
        if (value.type !== type) return;
        cleanup();
        resolve(value);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

function nextFrame(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, isBinary) => resolve({ data, isBinary }));
    socket.once("error", reject);
  });
}

function onceClosed(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", resolve));
}
