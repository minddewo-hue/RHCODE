import assert from "node:assert/strict";
import test from "node:test";
import {
  createControlPlane,
  MobileAccessManager,
  normalizeMobileAccessState,
} from "../src/app.js";

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
