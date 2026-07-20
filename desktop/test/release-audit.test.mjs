import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPackage } from "@electron/asar";
import { auditRelease } from "../scripts/release-audit.mjs";

test("audits a clean release and rejects sensitive ASAR or resource files", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-release-audit-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const desktopDir = path.join(root, "desktop");
  const resources = path.join(desktopDir, "release", "win-unpacked", "resources");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(source, "index.js"), "console.log('clean');\n");
  fs.writeFileSync(path.join(desktopDir, "release", "win-unpacked", "RHZYCODE.exe"), "test executable");
  await createPackage(source, path.join(resources, "app.asar"));

  const clean = auditRelease({
    desktopDir,
    version: "0.1.0-test",
    electronVersion: "test-electron",
    codexVersion: "test-codex",
  });
  assert.equal(clean.manifest.audit.sensitiveFileMatches, 0);
  assert.equal(clean.manifest.artifacts.some((artifact) => artifact.path === "win-unpacked/RHZYCODE.exe"), true);
  assert.equal(fs.existsSync(clean.manifestPath), true);

  fs.writeFileSync(path.join(desktopDir, "release", "stale-installer.exe"), "old build");
  const currentBuild = auditRelease({
    desktopDir,
    artifactPaths: [],
    version: "0.1.0-test",
    electronVersion: "test-electron",
    codexVersion: "test-codex",
  });
  assert.equal(currentBuild.manifest.artifacts.some((artifact) => artifact.path === "stale-installer.exe"), false);

  fs.writeFileSync(path.join(source, "auth.json"), "{\"forbidden\":true}\n");
  fs.rmSync(path.join(resources, "app.asar"));
  await createPackage(source, path.join(resources, "app.asar"));
  assert.throws(
    () => auditRelease({ desktopDir, version: "test", electronVersion: "test", codexVersion: "test" }),
    /forbidden sensitive files.*auth\.json/i,
  );

  fs.rmSync(path.join(source, "auth.json"));
  fs.rmSync(path.join(resources, "app.asar"));
  await createPackage(source, path.join(resources, "app.asar"));
  fs.writeFileSync(path.join(resources, "control-private.pem"), "test certificate material");
  assert.throws(
    () => auditRelease({ desktopDir, version: "test", electronVersion: "test", codexVersion: "test" }),
    /forbidden sensitive files.*\.pem/i,
  );
});
