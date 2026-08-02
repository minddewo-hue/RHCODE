import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseUpdateManifest } from "@rhzycode/update-contract";

const updateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(updateRoot, "..");
const config = readJson(path.join(updateRoot, "config.json"));
const desktopPackage = readJson(path.join(root, "desktop", "package.json"));
const mobileConfig = readJson(path.join(root, "mobile", "app.json")).expo;
const updatesRoot = path.resolve(root, config.updatesDirectory);
const publicOrigin = validatedPublicOrigin(config.publicOrigin);
const requestedPlatform = process.argv.find((argument) => argument.startsWith("--platform="))?.split("=", 2)[1];
if (requestedPlatform && !new Set(["windows", "android"]).has(requestedPlatform)) {
  throw new Error(`Unsupported update publish platform: ${requestedPlatform}.`);
}

const previousManifest = readExistingManifest(path.join(updatesRoot, "version.json"));
const platforms = requestedPlatform
  ? Object.fromEntries(Object.entries(previousManifest?.platforms || {}).filter(([name]) => name !== requestedPlatform))
  : {};

if (requestedPlatform !== "android") platforms.windows = await stageWindows();
if (requestedPlatform !== "windows") platforms.android = await stageAndroid();

const manifest = {
  schemaVersion: 2,
  publishedAt: new Date().toISOString(),
  platforms,
};
parseUpdateManifest(manifest);
fs.mkdirSync(updatesRoot, { recursive: true });
writeAtomic(path.join(updatesRoot, "version.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Staged update files in ${updatesRoot}`);
if (manifest.platforms.windows) console.log(`Windows ${manifest.platforms.windows.version}`);
if (manifest.platforms.android) {
  console.log(`Android ${manifest.platforms.android.version} (${manifest.platforms.android.versionCode})`);
}
console.log(`Public manifest: ${publicOrigin}/v1/updates/manifest`);

async function stageWindows() {
  const name = `RHZYCODE-Setup-${desktopPackage.version}-x64.exe`;
  const sourceRoot = path.join(root, "desktop", "release");
  const targetRoot = path.join(updatesRoot, "windows");
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const file of [name, `${name}.blockmap`, "latest.yml"]) {
    copyRequired(path.join(sourceRoot, file), path.join(targetRoot, file));
  }
  const installer = path.join(targetRoot, name);
  return {
    version: desktopPackage.version,
    architecture: "x64",
    file: `windows/${name}`,
    downloadUrl: `${publicOrigin}/updates/windows/${name}`,
    feedUrl: `${publicOrigin}/updates/windows`,
    metadataUrl: `${publicOrigin}/updates/windows/latest.yml`,
    bytes: fs.statSync(installer).size,
    sha256: await sha256(installer),
    releaseNotes: "RHZYCODE Windows release",
  };
}

async function stageAndroid() {
  const name = `RHZYCODE-Android-${mobileConfig.version}.apk`;
  const source = process.env.RHZYCODE_ANDROID_APK?.trim()
    ? path.resolve(process.env.RHZYCODE_ANDROID_APK)
    : path.join(root, "mobile", "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
  const targetRoot = path.join(updatesRoot, "android");
  const target = path.join(targetRoot, name);
  fs.mkdirSync(targetRoot, { recursive: true });
  copyRequired(source, target);
  return {
    version: mobileConfig.version,
    versionCode: Number(mobileConfig.android?.versionCode || 1),
    file: `android/${name}`,
    downloadUrl: `${publicOrigin}/updates/android/${name}`,
    bytes: fs.statSync(target).size,
    sha256: await sha256(target),
    releaseNotes: "RHZYCODE Android release",
  };
}

function copyRequired(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Required update artifact is missing: ${source}`);
  if (path.resolve(source) !== path.resolve(destination)) fs.copyFileSync(source, destination);
}

function writeAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readExistingManifest(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const manifest = readJson(filePath);
  parseUpdateManifest(manifest);
  return manifest;
}

function validatedPublicOrigin(value) {
  const url = new URL(String(value || ""));
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("appupdate/config.json publicOrigin must be an HTTP(S) origin without credentials or a path.");
  }
  return url.origin;
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
