import assert from "node:assert/strict";
import test from "node:test";
import {
  compareBuildNumbers,
  compareVersions,
  parseUpdateForPlatform,
  parseUpdateManifest,
} from "../src/index.js";

const manifest = {
  schemaVersion: 2,
  publishedAt: "2026-07-23T00:00:00.000Z",
  platforms: {
    windows: {
      version: "1.2.3",
      architecture: "x64",
      downloadUrl: "https://updates.example.test/windows/app.exe",
      feedUrl: "https://updates.example.test/windows/",
      metadataUrl: "https://updates.example.test/windows/latest.yml",
      bytes: 123,
      sha256: "a".repeat(64),
    },
    ios: {
      version: "1.2.3",
      buildNumber: "12",
      storeUrl: "https://apps.apple.com/app/id123456789",
    },
  },
};

test("parses a partial cross-platform update manifest", () => {
  const parsed = parseUpdateManifest(manifest);
  assert.equal(parsed.platforms.windows?.platform, "windows");
  assert.equal(parsed.platforms.ios?.platform, "ios");
  assert.equal(parsed.platforms.android, undefined);
});

test("selects and normalizes one platform", () => {
  const update = parseUpdateForPlatform(manifest, "windows");
  assert.equal(update.feedUrl, "https://updates.example.test/windows");
});

test("reports missing platform metadata", () => {
  assert.throws(() => parseUpdateForPlatform(manifest, "android"), /Android update metadata is unavailable/);
});

test("compares app versions and Apple build numbers", () => {
  assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
  assert.equal(compareBuildNumbers("12", "11"), 1);
  assert.equal(compareBuildNumbers("12.0", "12"), 0);
});
