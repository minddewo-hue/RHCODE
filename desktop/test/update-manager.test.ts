import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  DESKTOP_UPDATE_INTERVAL_MS,
  UpdateManager,
  isDesktopUpdateWindow,
} from "../src/main/update-manager.js";

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  forceDevUpdateConfig = false;
  feedUrl = "";
  installed = false;

  setFeedURL(options: { url: string }) { this.feedUrl = options.url; }
  async checkForUpdates() { this.emit("update-available", { version: "0.2.0" }); }
  async downloadUpdate() { this.emit("download-progress", { percent: 42 }); this.emit("update-downloaded", { version: "0.2.0" }); }
  quitAndInstall() { this.installed = true; }
}

test("tracks a configured update through check, download, and install", async () => {
  const updater = new FakeUpdater();
  const manager = new UpdateManager(updater, true, "https://updates.example.test/rhzycode");

  assert.equal(updater.feedUrl, "https://updates.example.test/rhzycode");
  assert.equal(updater.forceDevUpdateConfig, true);
  assert.equal(updater.autoDownload, false);
  await manager.check();
  assert.deepEqual(manager.getStatus(), {
    enabled: true,
    state: "available",
    version: "0.2.0",
    percent: null,
    error: null,
  });
  await manager.download();
  assert.equal(manager.getStatus().state, "downloaded");
  assert.equal(manager.getStatus().percent, 100);
  manager.install();
  assert.equal(updater.installed, true);
});

test("keeps updates disabled when no signed channel is configured", async () => {
  const manager = new UpdateManager(new FakeUpdater(), false);
  assert.equal(manager.getStatus().state, "disabled");
  await assert.rejects(manager.check(), /not configured/);
});

test("runs periodic desktop checks every two hours only from 10:00 until 20:00", () => {
  assert.equal(DESKTOP_UPDATE_INTERVAL_MS, 7_200_000);
  assert.equal(isDesktopUpdateWindow(new Date(2026, 6, 16, 9, 59)), false);
  assert.equal(isDesktopUpdateWindow(new Date(2026, 6, 16, 10, 0)), true);
  assert.equal(isDesktopUpdateWindow(new Date(2026, 6, 16, 19, 59)), true);
  assert.equal(isDesktopUpdateWindow(new Date(2026, 6, 16, 20, 0)), false);
});
