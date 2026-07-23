import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Arch, build, Platform } from "electron-builder";
import { auditRelease } from "./release-audit.mjs";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(desktopDir, "..");
const desktopPackage = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const directoryOnly = process.argv.includes("--dir");
const requestedPlatform = process.argv.find((argument) => argument.startsWith("--platform="))?.split("=", 2)[1] || "windows";
if (requestedPlatform !== "windows" && requestedPlatform !== "macos") {
  throw new Error(`Unsupported desktop release platform: ${requestedPlatform}.`);
}
const requiredNodePlatform = requestedPlatform === "macos" ? "darwin" : "win32";
if (process.platform !== requiredNodePlatform) {
  throw new Error(`${requestedPlatform} releases must be built on ${requiredNodePlatform}. Current platform: ${process.platform}.`);
}
const requestedArch = process.argv.find((argument) => argument.startsWith("--arch="))?.split("=", 2)[1]
  || (requestedPlatform === "windows" ? "x64" : process.arch === "arm64" ? "arm64" : "x64");
if (requestedArch !== "x64" && requestedArch !== "arm64") {
  throw new Error(`Unsupported desktop release architecture: ${requestedArch}.`);
}
const releaseArch = requestedArch === "arm64" ? Arch.arm64 : Arch.x64;
const signingRequired = process.env.RHZYCODE_REQUIRE_SIGNING === "1";
const signingConfigured = Boolean(
  process.env.CSC_LINK || process.env.WIN_CSC_LINK || process.env.CSC_NAME,
);
const defaultUpdateUrl = `https://minio.gshbzw.com/wxfile/rhzycode/${requestedPlatform}`;
const configuredUpdateUrl = process.env.RHZYCODE_UPDATE_URL?.trim() || "";
const updateUrl = configuredUpdateUrl || defaultUpdateUrl;
const electronDist = resolveElectronDist(desktopPackage.devDependencies.electron);
if (signingRequired && !signingConfigured) {
  throw new Error(
    "Code signing is required, but CSC_LINK, WIN_CSC_LINK, or CSC_NAME is not configured.",
  );
}
const iconPath = requestedPlatform === "macos"
  ? path.join(desktopDir, "build", "icon.icns")
  : path.join(desktopDir, "build", "icon.png");
const iconResult = requestedPlatform === "macos"
  ? spawnSync(process.execPath, [path.join(desktopDir, "scripts", "generate-mac-icon.mjs")], { encoding: "utf8" })
  : spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(desktopDir, "scripts", "generate-icon.ps1"), "-OutputPath", iconPath],
      { encoding: "utf8" },
    );
if (iconResult.status !== 0 || !fs.existsSync(iconPath)) {
  throw new Error(`Unable to generate the ${requestedPlatform} release icon: ${iconResult.stderr.trim()}`);
}
const codexPath = resolveCodexPath();
const expectedVersion = JSON.parse(
  fs.readFileSync(path.join(desktopDir, "codex-version.json"), "utf8"),
).cli;
const actualVersion = spawnSync(codexPath, ["--version"], { encoding: "utf8" });
if (actualVersion.status !== 0) {
  throw new Error(`Unable to execute the Codex binary at ${codexPath}.`);
}
if (!actualVersion.stdout.trim().endsWith(expectedVersion)) {
  throw new Error(
    `Codex version mismatch: expected ${expectedVersion}, got ${actualVersion.stdout.trim()}.`,
  );
}

const gatewayConfig = path.join(desktopDir, "gateway.config.json");
const gatewayConfigText = fs.readFileSync(gatewayConfig, "utf8");
if (/"api_key"\s*:/i.test(gatewayConfigText)) {
  throw new Error("The release gateway config contains an inline API key.");
}

const codexExecutableName = requestedPlatform === "windows" ? "codex.exe" : "codex";
const codeModeHostName = requestedPlatform === "windows" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
const codeModeHost = path.join(path.dirname(codexPath), codeModeHostName);
const extraResources = [
  {
    from: gatewayConfig,
    to: "gateway/gateway.config.json",
  },
  {
    from: path.join(desktopDir, "codex-model-catalog.json"),
    to: "gateway/codex-model-catalog.json",
  },
  {
    from: path.join(desktopDir, "model-context-windows.json"),
    to: "gateway/model-context-windows.json",
  },
  {
    from: codexPath,
    to: `codex/${codexExecutableName}`,
  },
];
if (fs.existsSync(codeModeHost)) {
  extraResources.push({
    from: codeModeHost,
    to: `codex/${codeModeHostName}`,
  });
}

const artifacts = await build({
  projectDir: desktopDir,
  targets: requestedPlatform === "windows"
    ? Platform.WINDOWS.createTarget(directoryOnly ? "dir" : "nsis", releaseArch)
    : Platform.MAC.createTarget(directoryOnly ? "dir" : ["dmg", "zip"], releaseArch),
  config: {
    appId: "ai.rhzycode.desktop",
    productName: "RHZYCODE",
    electronDist,
    artifactName: requestedPlatform === "windows"
      ? "${productName}-Setup-${version}-${arch}.${ext}"
      : "${productName}-${version}-${arch}.${ext}",
    asar: true,
    forceCodeSigning: signingRequired,
    npmRebuild: false,
    directories: {
      output: "release",
    },
    files: [
      "out/**/*",
      "package.json",
      "!**/.env",
      "!**/auth.json",
      "!**/config.toml",
    ],
    extraResources,
    ...(updateUrl ? { publish: [{ provider: "generic", url: updateUrl }] } : {}),
    win: {
      executableName: "RHZYCODE",
      icon: iconPath,
      ...(!signingConfigured ? { signExecutable: false } : {}),
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
    },
    mac: {
      category: "public.app-category.developer-tools",
      icon: iconPath,
      hardenedRuntime: true,
      minimumSystemVersion: "12.0",
      notarize: signingRequired,
    },
  },
});

const audit = auditRelease({
  desktopDir,
  artifactPaths: artifacts,
  version: desktopPackage.version,
  electronVersion: desktopPackage.devDependencies.electron,
  codexVersion: expectedVersion,
  signingRequired,
  updateConfigured: Boolean(updateUrl),
  platform: requiredNodePlatform,
  arch: requestedArch,
});

for (const artifact of artifacts) console.log(artifact);
console.log(audit.manifestPath);

function resolveCodexPath() {
  if (process.env.RHZYCODE_CODEX_PATH) return path.resolve(process.env.RHZYCODE_CODEX_PATH);
  const command = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(command, ["codex"], { encoding: "utf8" });
  const executable = result.stdout.split(/\r?\n/).find(Boolean);
  if (result.status !== 0 || !executable) {
    throw new Error("Codex CLI was not found. Set RHZYCODE_CODEX_PATH before packaging.");
  }
  return path.resolve(executable.trim());
}

function resolveElectronDist(expectedVersion) {
  const electronDist = path.resolve(
    process.env.RHZYCODE_ELECTRON_DIST || path.join(rootDir, "node_modules", "electron", "dist"),
  );
  const executable = path.join(electronDist, process.platform === "win32" ? "electron.exe" : "electron");
  if (!fs.existsSync(executable)) {
    throw new Error(`Installed Electron distribution was not found at ${electronDist}.`);
  }
  const version = spawnSync(
    executable,
    ["-e", "process.stdout.write(process.versions.electron || '')"],
    {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
    },
  );
  if (version.status !== 0 || version.stdout.trim() !== expectedVersion) {
    throw new Error(`Electron distribution mismatch: expected ${expectedVersion}, got ${version.stdout.trim() || "unknown"}.`);
  }
  return electronDist;
}
