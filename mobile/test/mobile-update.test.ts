import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, fetchMobileUpdate } from "../src/update/mobile-update";

const validManifest = {
  schemaVersion: 1,
  android: {
    version: "0.2.0",
    versionCode: 2,
    apkUrl: "http://192.168.11.103:8791/mobile/RHZYCODE-Android-0.2.0.apk",
    bytes: 1234,
    sha256: "a".repeat(64),
    releaseNotes: "Local release",
  },
};

test("compares stable semantic versions", () => {
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
});

test("detects an available Android APK from the local update manifest", async () => {
  const status = await fetchMobileUpdate("0.1.0", {
    fetchImpl: async () => new Response(JSON.stringify(validManifest), { status: 200 }),
  });
  assert.equal(status.state, "available");
  assert.equal(status.latest.versionCode, 2);
  assert.match(status.latest.apkUrl, /192\.168\.11\.103:8791/);
});

test("reports the installed Android version as current", async () => {
  const status = await fetchMobileUpdate("0.2.0", {
    fetchImpl: async () => new Response(JSON.stringify(validManifest), { status: 200 }),
  });
  assert.equal(status.state, "current");
});

test("rejects malformed Android update metadata", async () => {
  await assert.rejects(fetchMobileUpdate("0.1.0", {
    fetchImpl: async () => new Response(JSON.stringify({ android: { ...validManifest.android, sha256: "bad" } }), { status: 200 }),
  }), /checksum/i);
});
