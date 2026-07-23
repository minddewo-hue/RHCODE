import assert from "node:assert/strict";
import test from "node:test";
import { createLegacyUpdateServer } from "../server.mjs";

const manifest = {
  schemaVersion: 2,
  publishedAt: "2026-07-23T00:00:00.000Z",
  platforms: {
    android: {
      version: "0.2.0",
      versionCode: 2,
      downloadUrl: "https://minio.example.test/wxfile/rhzycode/android/app.apk",
      bytes: 10,
      sha256: "a".repeat(64),
    },
  },
};

test("adapts the MinIO manifest and redirects legacy artifact requests", async (context) => {
  const server = createLegacyUpdateServer({
    config: {
      endpoint: "https://minio.example.test",
      bucket: "wxfile",
      objectPrefix: "rhzycode",
      manifestFile: "version.json",
    },
    fetchImpl: async () => new Response(JSON.stringify(manifest)),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const legacy = await fetch(`${baseUrl}/manifest.json`).then((response) => response.json());
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.android.version, "0.2.0");
  assert.equal(legacy.android.apkUrl, manifest.platforms.android.downloadUrl);
  assert.equal("downloadUrl" in legacy.android, false);

  const metadata = await fetch(`${baseUrl}/desktop/latest.yml`, { redirect: "manual" });
  assert.equal(metadata.status, 302);
  assert.equal(metadata.headers.get("location"), "https://minio.example.test/wxfile/rhzycode/windows/latest.yml");

  const installer = await fetch(`${baseUrl}/desktop/RHZYCODE-Setup-0.2.0-x64.exe`, { redirect: "manual" });
  assert.equal(installer.status, 302);
  assert.equal(installer.headers.get("location"), "https://minio.example.test/wxfile/rhzycode/windows/RHZYCODE-Setup-0.2.0-x64.exe");
});
