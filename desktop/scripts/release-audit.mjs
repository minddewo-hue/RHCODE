import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage, uncache } from "@electron/asar";

const sensitiveNames = new Set([
  ".env",
  "auth.json",
  "config.toml",
  "gateway-credentials.json",
  "mobile-access-state.bin",
  "control-state.bin",
]);
const sensitiveExtensions = new Set([".pem", ".pfx", ".p12"]);

export function auditRelease({
  desktopDir,
  artifactPaths,
  version,
  electronVersion,
  codexVersion,
  signingRequired = false,
  updateConfigured,
}) {
  const releaseDir = path.join(desktopDir, "release");
  const unpackedDir = path.join(releaseDir, "win-unpacked");
  const resourcesDir = path.join(unpackedDir, "resources");
  const asarPath = path.join(resourcesDir, "app.asar");
  const unpackedExecutable = path.join(unpackedDir, "RHZYCODE.exe");
  if (!fs.existsSync(asarPath) || !fs.existsSync(unpackedExecutable)) {
    throw new Error("Release audit requires release/win-unpacked with app.asar and RHZYCODE.exe.");
  }

  uncache(asarPath);
  const asarMatches = listPackage(asarPath)
    .map(normalizeArchivePath)
    .filter(isSensitivePath);
  const resourceMatches = walkFiles(resourcesDir)
    .filter((filePath) => filePath !== asarPath)
    .map((filePath) => path.relative(resourcesDir, filePath).replace(/\\/g, "/"))
    .filter(isSensitivePath);
  const sensitiveMatches = [
    ...asarMatches.map((entry) => `app.asar/${entry}`),
    ...resourceMatches.map((entry) => `resources/${entry}`),
  ];
  if (sensitiveMatches.length > 0) {
    throw new Error(`Release contains forbidden sensitive files: ${sensitiveMatches.join(", ")}`);
  }

  const updaterConfigPath = path.join(resourcesDir, "app-update.yml");
  const hasUpdaterConfig = fs.existsSync(updaterConfigPath);
  const expectsUpdater = updateConfigured ?? hasUpdaterConfig;
  if (expectsUpdater !== hasUpdaterConfig) {
    throw new Error(expectsUpdater
      ? "Configured update channel is missing app-update.yml."
      : "Unsigned release unexpectedly contains app-update.yml.");
  }

  const artifactCandidates = new Set([
    asarPath,
    unpackedExecutable,
    ...(artifactPaths || []),
    ...(artifactPaths == null ? walkFiles(releaseDir).filter((filePath) => {
      const extension = path.extname(filePath).toLowerCase();
      return path.dirname(filePath) === releaseDir && (extension === ".exe" || extension === ".blockmap");
    }) : []),
  ]);
  const artifacts = [...artifactCandidates]
    .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
    .map((filePath) => {
      const relativePath = path.relative(releaseDir, filePath).replace(/\\/g, "/");
      const extension = path.extname(filePath).toLowerCase();
      return {
        path: relativePath,
        bytes: fs.statSync(filePath).size,
        sha256: hashFile(filePath),
        ...(extension === ".exe" ? { authenticode: getAuthenticodeStatus(filePath) } : {}),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  if (signingRequired) {
    const invalidSignatures = artifacts.filter((artifact) => artifact.authenticode && artifact.authenticode !== "Valid");
    if (invalidSignatures.length > 0) {
      throw new Error(`Required Authenticode validation failed: ${invalidSignatures.map((value) => value.path).join(", ")}`);
    }
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    product: "RHZYCODE",
    version,
    platform: "win32",
    arch: "x64",
    electronVersion,
    codexVersion,
    updateConfigured: expectsUpdater,
    signingRequired,
    audit: {
      sensitiveFileMatches: 0,
      updaterConfigPresent: hasUpdaterConfig,
    },
    artifacts,
  };
  const manifestPath = path.join(releaseDir, "release-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, manifestPath };
}

function normalizeArchivePath(value) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isSensitivePath(value) {
  const normalized = value.replace(/\\/g, "/");
  const name = normalized.split("/").at(-1)?.toLowerCase() || "";
  return sensitiveNames.has(name) || sensitiveExtensions.has(path.extname(name));
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      if (entry.isFile()) files.push(entryPath);
    }
  }
  return files;
}

function hashFile(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function getAuthenticodeStatus(filePath) {
  if (process.platform !== "win32") return "Unsupported";
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "(Get-AuthenticodeSignature -LiteralPath $env:RHZYCODE_AUDIT_FILE).Status.ToString()",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, RHZYCODE_AUDIT_FILE: filePath },
    },
  );
  return result.status === 0 ? result.stdout.trim() || "UnknownError" : "UnknownError";
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
  const codexVersion = JSON.parse(fs.readFileSync(path.join(desktopDir, "codex-version.json"), "utf8")).cli;
  const result = auditRelease({
    desktopDir,
    version: packageJson.version,
    electronVersion: packageJson.devDependencies.electron,
    codexVersion,
    signingRequired: process.env.RHZYCODE_REQUIRE_SIGNING === "1",
  });
  console.log(`Release audit passed: ${result.manifestPath}`);
}
