import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopSettingsStore, isValidSyncPort } from "../src/main/desktop-settings.js";

test("persists a validated mobile sync port", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-desktop-settings-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new DesktopSettingsStore(path.join(directory, "desktop-settings.json"));

  assert.deepEqual(store.load(8790), { syncPort: 8790 });
  store.save({ syncPort: 9123 });
  assert.deepEqual(store.load(8790), { syncPort: 9123 });
});

test("ignores invalid persisted ports", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-desktop-settings-invalid-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "desktop-settings.json");
  fs.writeFileSync(filePath, JSON.stringify({ syncPort: 70_000 }));

  assert.deepEqual(new DesktopSettingsStore(filePath).load(8790), { syncPort: 8790 });
  assert.equal(isValidSyncPort(1), true);
  assert.equal(isValidSyncPort(65_535), true);
  assert.equal(isValidSyncPort(0), false);
  assert.equal(isValidSyncPort(1.5), false);
});
