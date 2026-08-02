import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("stages releases directly in the transfer server project", () => {
  const config = readJson(path.join(root, "appupdate", "config.json"));
  assert.equal(config.publicOrigin, "http://218.201.210.211:8000");
  assert.equal(config.updatesDirectory, "transferserver/updates");
  assert.equal(config.remoteProject, "/home/analyzer/work_space/rhzycode-transfer");
});

test("both clients check the transfer server update manifest", () => {
  const mobile = readJson(path.join(root, "mobile", "app.json"));
  const desktopSource = fs.readFileSync(path.join(root, "desktop", "src", "main", "update-manager.ts"), "utf8");
  assert.equal(mobile.expo.extra.updateManifestUrl, "http://218.201.210.211:8000/v1/updates/manifest");
  assert.match(desktopSource, /http:\/\/218\.201\.210\.211:8000/);
  assert.match(desktopSource, /\/v1\/updates\/manifest/);
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
