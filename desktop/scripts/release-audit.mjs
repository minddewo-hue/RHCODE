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
  platform = "win32",
  arch = "x64",
}) {
  const releaseDir = path.join(desktopDir, "release");
  const macAppBundle = platform === "darwin" ? findMacAppBundle(releaseDir) : null;
  const unpackedDir = platform === "darwin" ? macAppBundle : path.join(releaseDir, "win-unpacked");
  const resourcesDir = platform === "darwin"
    ? path.join(unpackedDir || "", "Contents", "Resources")
    : path.join(unpackedDir, "resources");
  const asarPath = path.join(resourcesDir, "app.asar");
  const unpackedExecutable = platform === "darwin"
    ? path.join(unpackedDir || "", "Contents", "MacOS", "RHZYCODE")
    : path.join(unpackedDir, "RHZYCODE.exe");
  if (!fs.existsSync(asarPath) || !fs.existsSync(unpackedExecutable)) {
    throw new Error(`Release audit could not find the unpacked ${platform} application, app.asar, and executable.`);
  }

  uncache(asarPath);
  const asarEntries = listPackage(asarPath).map(normalizeArchivePath);
  const asarMatches = asarEntries.filter(isSensitivePath);
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

  const runtimePackages = readRuntimePackageNames(desktopDir);
  const archiveEntrySet = new Set(asarEntries);
  const missingRuntimePackages = runtimePackages.filter((packageName) =>
    !archiveEntrySet.has(`node_modules/${packageName}/package.json`));
  if (missingRuntimePackages.length > 0) {
    throw new Error(`Release is missing runtime packages: ${missingRuntimePackages.join(", ")}`);
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
      const releaseExtensions = platform === "darwin"
        ? new Set([".dmg", ".zip", ".blockmap", ".yml"])
        : new Set([".exe", ".blockmap", ".yml"]);
      return path.dirname(filePath) === releaseDir && releaseExtensions.has(extension);
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
        ...(platform === "win32" && extension === ".exe" ? { authenticode: getAuthenticodeStatus(filePath) } : {}),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  if (signingRequired) {
    if (platform === "darwin") {
      verifyMacCodeSignature(unpackedDir);
    } else {
      const invalidSignatures = artifacts.filter((artifact) => artifact.authenticode && artifact.authenticode !== "Valid");
      if (invalidSignatures.length > 0) {
        throw new Error(`Required Authenticode validation failed: ${invalidSignatures.map((value) => value.path).join(", ")}`);
      }
    }
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    product: "RHZYCODE",
    version,
    platform,
    arch,
    electronVersion,
    codexVersion,
    updateConfigured: expectsUpdater,
    signingRequired,
    audit: {
      sensitiveFileMatches: 0,
      updaterConfigPresent: hasUpdaterConfig,
      runtimePackages,
    },
    artifacts,
  };
  const manifestPath = path.join(releaseDir, "release-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, manifestPath };
}

function readRuntimePackageNames(desktopDir) {
  const packagePath = path.join(desktopDir, "package.json");
  if (!fs.existsSync(packagePath)) return [];
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return Object.keys(packageJson.dependencies || {}).sort((left, right) => left.localeCompare(right));
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

function findMacAppBundle(releaseDir) {
  if (!fs.existsSync(releaseDir)) return null;
  const pending = [releaseDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.name === "RHZYCODE.app") return entryPath;
      if (path.relative(releaseDir, entryPath).split(path.sep).length < 3) pending.push(entryPath);
    }
  }
  return null;
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

function verifyMacCodeSignature(appBundle) {
  if (process.platform !== "darwin") {
    throw new Error("macOS code signature verification requires macOS.");
  }
  const result = spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appBundle], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Required macOS code signature validation failed: ${result.stderr.trim()}`);
  }
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
    platform: process.platform === "darwin" ? "darwin" : "win32",
    arch: process.arch === "arm64" ? "arm64" : "x64",
  });
  console.log(`Release audit passed: ${result.manifestPath}`);
}
