import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlStore } from "@rhzycode/control-plane";
import { EncryptedControlPersistence } from "../src/main/control-persistence.js";

test("encrypts and restores durable control-plane state", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-control-state-"));
  const filePath = path.join(root, "control-state.bin");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const encryption = {
    isAvailable: () => true,
    encrypt: (value: string) => Buffer.from(value, "utf8").map((byte) => byte ^ 0xa5),
    decrypt: (value: Buffer) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString("utf8"),
  };
  const store = new ControlStore();
  const persistence = new EncryptedControlPersistence(filePath, encryption);
  persistence.attach(store);
  store.upsertThread({
    id: "thread-secure",
    hostId: "local-desktop",
    title: "Encrypted history",
    projectPath: "D:\\secure",
    model: "test/model",
    status: "completed",
    updatedAt: new Date().toISOString(),
  });
  persistence.flush();

  const encrypted = fs.readFileSync(filePath);
  assert.doesNotMatch(encrypted.toString("utf8"), /Encrypted history|D:\\secure/);
  const restoredState = new EncryptedControlPersistence(filePath, encryption).load();
  assert.ok(restoredState);
  const restored = new ControlStore(restoredState);
  assert.equal(restored.snapshot().threads[0]?.title, "Encrypted history");
  persistence.detach();
});

test("reports missing, partial, invalid, and unavailable restore states", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-control-status-"));
  const filePath = path.join(root, "control-state.bin");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const encryption = {
    isAvailable: () => true,
    encrypt: (value: string) => Buffer.from(value, "utf8"),
    decrypt: (value: Buffer) => value.toString("utf8"),
  };
  const persistence = new EncryptedControlPersistence(filePath, encryption);
  assert.equal(persistence.load(), null);
  assert.equal(persistence.getLoadStatus(), "missing");

  const snapshot = new ControlStore().snapshot();
  fs.writeFileSync(filePath, JSON.stringify({ snapshot, events: [{ type: "unknown" }] }));
  assert.ok(persistence.load());
  assert.equal(persistence.getLoadStatus(), "partial");

  fs.writeFileSync(filePath, "not-json");
  assert.equal(persistence.load(), null);
  assert.equal(persistence.getLoadStatus(), "invalid");

  const unavailable = new EncryptedControlPersistence(filePath, {
    ...encryption,
    isAvailable: () => false,
  });
  assert.equal(unavailable.load(), null);
  assert.equal(unavailable.getLoadStatus(), "unavailable");
});
