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
  checks = 0;

  setFeedURL(options: { url: string }) { this.feedUrl = options.url; }
  async checkForUpdates() { this.checks += 1; this.emit("update-available", { version: "0.2.0" }); }
  async downloadUpdate() { this.emit("download-progress", { percent: 42 }); this.emit("update-downloaded", { version: "0.2.0" }); }
  quitAndInstall() { this.installed = true; }
}

test("tracks a configured update through check, download, and install", async () => {
  const updater = new FakeUpdater();
  const manager = new UpdateManager(updater, true, {
    currentVersion: "0.1.0",
    platform: "windows",
    manifestUrl: "https://updates.example.test/rhzycode/version.json",
    fetchImpl: async () => new Response(JSON.stringify(validManifest)),
  });

  assert.equal(updater.autoDownload, false);
  await manager.check();
  assert.equal(updater.feedUrl, "https://updates.example.test/rhzycode/windows");
  assert.equal(updater.forceDevUpdateConfig, true);
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

test("does not ask electron-updater to download metadata when the manifest version is current", async () => {
  const updater = new FakeUpdater();
  const manager = new UpdateManager(updater, true, {
    currentVersion: "0.2.0",
    platform: "windows",
    fetchImpl: async () => new Response(JSON.stringify(validManifest)),
  });
  const status = await manager.check();
  assert.equal(status.state, "not_available");
  assert.equal(status.version, "0.2.0");
  assert.equal(updater.checks, 0);
});

test("selects the macOS feed for a macOS desktop", async () => {
  const updater = new FakeUpdater();
  const manager = new UpdateManager(updater, true, {
    currentVersion: "0.1.0",
    platform: "macos",
    fetchImpl: async () => new Response(JSON.stringify({
      schemaVersion: 2,
      platforms: {
        macos: {
          version: "0.2.0",
          architecture: "arm64",
          downloadUrl: "https://updates.example.test/rhzycode/macos/RHZYCODE-0.2.0-arm64.dmg",
          feedUrl: "https://updates.example.test/rhzycode/macos",
          metadataUrl: "https://updates.example.test/rhzycode/macos/latest-mac.yml",
          bytes: 1234,
          sha256: "b".repeat(64),
          releaseNotes: "Release",
        },
      },
    })),
  });

  await manager.check();
  assert.equal(updater.feedUrl, "https://updates.example.test/rhzycode/macos");
  assert.equal(manager.getStatus().state, "available");
});

test("runs periodic desktop checks every two hours only from 10:00 until 20:00", () => {
  assert.equal(DESKTOP_UPDATE_INTERVAL_MS, 7_200_000);
  assert.equal(isDesktopUpdateWindow(new Date(2026, 6, 16, 9, 59)), false);
  assert.equal(isDesktopUpdateWindow(new Date(2026, 6, 16, 10, 0)), true);
  assert.equal(isDesktopUpdateWindow(new Date(2026, 6, 16, 19, 59)), true);
  assert.equal(isDesktopUpdateWindow(new Date(2026, 6, 16, 20, 0)), false);
});

const validManifest = {
  schemaVersion: 2,
  platforms: {
    windows: {
      version: "0.2.0",
      architecture: "x64",
      downloadUrl: "https://updates.example.test/rhzycode/windows/RHZYCODE-Setup-0.2.0-x64.exe",
      feedUrl: "https://updates.example.test/rhzycode/windows",
      metadataUrl: "https://updates.example.test/rhzycode/windows/latest.yml",
      bytes: 1234,
      sha256: "a".repeat(64),
      releaseNotes: "Release",
    },
  },
};
