import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createControlPlane,
  MobileAccessManager,
  normalizeMobileAccessState,
} from "../src/main/control-plane/app.js";
import { materializeGeneratedImage } from "../src/main/generated-image-store.js";
import { ManagedFileStore } from "../src/main/managed-file-store.js";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=";

test("uses one persistent desktop access key and invalidates it on rotation", async () => {
  let persistedState: Parameters<typeof MobileAccessManager>[0] = null;
  const mobileAccess = new MobileAccessManager(null, (state) => { persistedState = state; });
  const first = mobileAccess.rotateAccessKey();
  const controlPlane = await createControlPlane({ logLevel: "silent", mobileAccess });

  assert.match(first.key, /^rhzy_[A-Za-z0-9_-]{43}$/);
  const authorized = await controlPlane.app.inject({
    method: "GET",
    url: "/v1/snapshot",
    headers: { authorization: `Bearer ${first.key}` },
  });
  assert.equal(authorized.statusCode, 200);

  const restored = new MobileAccessManager(persistedState);
  assert.equal(restored.authenticate(first.key)?.id, "desktop-mobile-access-key");
  assert.equal(restored.status().accessKey?.key, first.key);

  const second = mobileAccess.rotateAccessKey();
  assert.notEqual(second.key, first.key);
  assert.equal(mobileAccess.authenticate(first.key), null);
  assert.equal(mobileAccess.authenticate(second.key)?.name, "RHZYCODE Mobile");
  await controlPlane.stop();
});

test("authenticates event replay with the persistent key subprotocol", async () => {
  const mobileAccess = new MobileAccessManager();
  const accessKey = mobileAccess.rotateAccessKey();
  const controlPlane = await createControlPlane({ logLevel: "silent", mobileAccess });
  const address = await controlPlane.start({ host: "127.0.0.1", port: 0 });
  const after = controlPlane.store.snapshot().lastSequence;
  const socket = new WebSocket(
    `${address.url.replace(/^http/, "ws")}/v1/events?after=${after}`,
    ["rhzycode.v1", `rhzycode.auth.${accessKey.key}`],
  );
  await waitForSocket(socket, "open");
  const message = waitForSocket(socket, "message");
  controlPlane.store.upsertThread({
    id: "thread-ws",
    hostId: "local-desktop",
    title: "Authenticated replay",
    projectPath: "D:\\work",
    model: "test/model",
    status: "running",
    updatedAt: new Date().toISOString(),
  });
  const event = JSON.parse(String((await message as MessageEvent).data));
  assert.equal(event.thread.id, "thread-ws");
  socket.close();
  await controlPlane.stop();
});

test("closes the active WebSocket when the desktop replaces the key", async () => {
  const mobileAccess = new MobileAccessManager();
  const first = mobileAccess.rotateAccessKey();
  const controlPlane = await createControlPlane({ logLevel: "silent", mobileAccess });
  const address = await controlPlane.start({ host: "127.0.0.1", port: 0 });
  const socket = new WebSocket(
    `${address.url.replace(/^http/, "ws")}/v1/events?after=0`,
    ["rhzycode.v1", `rhzycode.auth.${first.key}`],
  );
  await waitForSocket(socket, "open");
  const closed = waitForSocket(socket, "close");
  mobileAccess.rotateAccessKey();
  assert.equal((await closed as CloseEvent).code, 4001);
  await controlPlane.stop();
});

test("restores valid encrypted access state while discarding malformed audit records", () => {
  const original = new MobileAccessManager();
  const accessKey = original.rotateAccessKey();
  original.recordTaskCommand("desktop-mobile-access-key", "task.thread_deleted", "thread-restored");
  const state = original.exportState();
  const normalized = normalizeMobileAccessState({
    accessKey: state.accessKey,
    audit: [...state.audit, { action: "unknown" }],
  });
  assert.equal(normalized?.discardedInvalidRecords, true);
  const restored = new MobileAccessManager(normalized?.state);
  assert.equal(restored.authenticate(accessKey.key)?.id, "desktop-mobile-access-key");
  assert.equal(restored.status().audit.length, 1);
});

test("serves only managed generated images with mobile authentication", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-mobile-images-"));
  const mobileAccess = new MobileAccessManager();
  const accessKey = mobileAccess.rotateAccessKey().key;
  const stored = materializeGeneratedImage(directory, { id: "mobile-1", result: ONE_PIXEL_PNG });
  assert.ok(stored);
  const controlPlane = await createControlPlane({
    logLevel: "silent",
    mobileAccess,
    generatedImageDirectory: directory,
  });

  try {
    const unauthorized = await controlPlane.app.inject({
      method: "GET",
      url: `/v1/generated-images/${stored.name}`,
    });
    assert.equal(unauthorized.statusCode, 401);

    const authorized = await controlPlane.app.inject({
      method: "GET",
      url: `/v1/generated-images/${stored.name}`,
      headers: { authorization: `Bearer ${accessKey}` },
    });
    assert.equal(authorized.statusCode, 200);
    assert.equal(authorized.headers["content-type"], "image/png");
    assert.equal(authorized.headers["cache-control"], "private, max-age=31536000, immutable");
    assert.deepEqual(authorized.rawPayload, Buffer.from(ONE_PIXEL_PNG, "base64"));

    const unmanaged = await controlPlane.app.inject({
      method: "GET",
      url: "/v1/generated-images/not-managed.png",
      headers: { authorization: `Bearer ${accessKey}` },
    });
    assert.equal(unmanaged.statusCode, 404);
  } finally {
    await controlPlane.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("downloads only managed conversation files with mobile authentication", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-mobile-files-"));
  const source = path.join(root, "report.txt");
  fs.writeFileSync(source, "mobile attachment", "utf8");
  const managedFiles = new ManagedFileStore(path.join(root, "managed"));
  const [record] = managedFiles.registerUploads("thread-mobile", [{
    path: source,
    name: "report.txt",
    kind: "file",
    size: fs.statSync(source).size,
  }]);
  const mobileAccess = new MobileAccessManager();
  const accessKey = mobileAccess.rotateAccessKey().key;
  const controlPlane = await createControlPlane({ logLevel: "silent", mobileAccess, managedFiles });
  try {
    assert.equal((await controlPlane.app.inject({ method: "GET", url: `/v1/files/${record.id}` })).statusCode, 401);
    const response = await controlPlane.app.inject({
      method: "GET",
      url: `/v1/files/${record.id}`,
      headers: { authorization: `Bearer ${accessKey}` },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "text/plain");
    assert.match(String(response.headers["content-disposition"]), /report\.txt/);
    assert.equal(response.body, "mobile attachment");
    const missing = await controlPlane.app.inject({
      method: "GET",
      url: "/v1/files/file-not-managed",
      headers: { authorization: `Bearer ${accessKey}` },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await controlPlane.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function waitForSocket(socket: WebSocket, event: "open" | "message" | "close"): Promise<Event | MessageEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for WebSocket ${event}`)), 3000);
    socket.addEventListener(event, (value) => {
      clearTimeout(timeout);
      resolve(value);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket failed"));
    }, { once: true });
  });
}
