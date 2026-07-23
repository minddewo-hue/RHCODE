import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, fetchMobileUpdate } from "../src/platform/update/mobile-update";

const validManifest = {
  schemaVersion: 2,
  platforms: {
    android: {
      version: "0.2.0",
      versionCode: 2,
      downloadUrl: "https://minio.gshbzw.com/wxfile/rhzycode/android/RHZYCODE-Android-0.2.0.apk",
      bytes: 1234,
      sha256: "a".repeat(64),
      releaseNotes: "MinIO release",
    },
  },
};

test("compares stable semantic versions", () => {
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
});

test("detects an available Android APK from the MinIO update manifest", async () => {
  const status = await fetchMobileUpdate("0.1.0", {
    platform: "android",
    fetchImpl: async () => new Response(JSON.stringify(validManifest), { status: 200 }),
  });
  assert.equal(status.state, "available");
  assert.equal(status.latest.versionCode, 2);
  assert.match(status.latest.downloadUrl, /minio\.gshbzw\.com/);
});

test("reports the installed Android version as current", async () => {
  const status = await fetchMobileUpdate("0.2.0", {
    platform: "android",
    fetchImpl: async () => new Response(JSON.stringify(validManifest), { status: 200 }),
  });
  assert.equal(status.state, "current");
});

test("uses Android versionCode when the visible version is unchanged", async () => {
  const status = await fetchMobileUpdate("0.2.0", {
    platform: "android",
    currentVersionCode: 1,
    fetchImpl: async () => new Response(JSON.stringify(validManifest), { status: 200 }),
  });
  assert.equal(status.state, "available");
});

test("rejects malformed Android update metadata", async () => {
  await assert.rejects(fetchMobileUpdate("0.1.0", {
    platform: "android",
    fetchImpl: async () => new Response(JSON.stringify({
      ...validManifest,
      platforms: { android: { ...validManifest.platforms.android, sha256: "bad" } },
    }), { status: 200 }),
  }), /checksum/i);
});

test("detects an iOS App Store update by version and build number", async () => {
  const iosManifest = {
    ...validManifest,
    platforms: {
      ios: {
        version: "0.2.0",
        buildNumber: "3",
        storeUrl: "https://apps.apple.com/app/id123456789",
        releaseNotes: "App Store release",
      },
    },
  };
  const versionUpdate = await fetchMobileUpdate("0.1.0", {
    platform: "ios",
    currentBuildNumber: "2",
    fetchImpl: async () => new Response(JSON.stringify(iosManifest), { status: 200 }),
  });
  assert.equal(versionUpdate.state, "available");
  assert.equal(versionUpdate.latest.platform, "ios");

  const buildUpdate = await fetchMobileUpdate("0.2.0", {
    platform: "ios",
    currentBuildNumber: "2",
    fetchImpl: async () => new Response(JSON.stringify(iosManifest), { status: 200 }),
  });
  assert.equal(buildUpdate.state, "available");
});
