import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUpdateServer } from "../server.mjs";

test("serves the update manifest, artifacts, HEAD, and byte ranges", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-update-test-"));
  const artifacts = path.join(root, "artifacts");
  fs.mkdirSync(path.join(artifacts, "mobile"), { recursive: true });
  fs.mkdirSync(path.join(artifacts, "desktop"), { recursive: true });
  fs.writeFileSync(path.join(artifacts, "mobile", "app.apk"), "0123456789");
  fs.writeFileSync(path.join(artifacts, "desktop", "latest.yml"), "version: 0.2.0\n");
  fs.writeFileSync(path.join(root, "channel.json"), JSON.stringify({
    publishedAt: "2026-07-16T00:00:00.000Z",
    desktop: { version: "0.2.0", path: "desktop/setup.exe" },
    android: { version: "0.2.0", versionCode: 2, path: "mobile/app.apk", bytes: 10, sha256: "test" },
  }));
  const server = createUpdateServer({
    root,
    config: {
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: "http://192.168.11.103:8791",
      artifactsDirectory: "artifacts",
      channelFile: "channel.json",
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.equal(health.status, "ok");

  const manifest = await fetch(`${baseUrl}/manifest.json`).then((response) => response.json());
  assert.equal(manifest.desktop.feedUrl, "http://192.168.11.103:8791/desktop");
  assert.equal(manifest.android.apkUrl, "http://192.168.11.103:8791/mobile/app.apk");

  const partial = await fetch(`${baseUrl}/mobile/app.apk`, { headers: { Range: "bytes=2-5" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await partial.text(), "2345");

  const head = await fetch(`${baseUrl}/desktop/latest.yml`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(Buffer.byteLength("version: 0.2.0\n")));
  assert.equal(await head.text(), "");

  const invalidRange = await fetch(`${baseUrl}/mobile/app.apk`, { headers: { Range: "bytes=99-100" } });
  assert.equal(invalidRange.status, 416);
});
