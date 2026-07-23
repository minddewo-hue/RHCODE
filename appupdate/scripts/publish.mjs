import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseUpdateManifest } from "@rhzycode/update-contract";
import { publicObjectUrl, uploadBuffer, uploadFile } from "./minio-client.mjs";

const updateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(updateRoot, "..");
const stagingRoot = path.join(updateRoot, "rhzycode");
const desktopRelease = path.join(root, "desktop", "release");
const desktopPackage = readJson(path.join(root, "desktop", "package.json"));
const mobileConfig = readJson(path.join(root, "mobile", "app.json")).expo;
const config = readJson(path.join(updateRoot, "config.json"));
const dryRun = process.argv.includes("--dry-run");

validateConfig(config);
const prefix = trimSlashes(config.objectPrefix);
const manifestObject = `${prefix}/${config.manifestFile}`;
const windowsTarget = path.join(stagingRoot, "windows");
const androidTarget = path.join(stagingRoot, "android");
fs.mkdirSync(windowsTarget, { recursive: true });
fs.mkdirSync(androidTarget, { recursive: true });

const setupName = `RHZYCODE-Setup-${desktopPackage.version}-x64.exe`;
const windowsFiles = ["latest.yml", setupName, `${setupName}.blockmap`];
for (const name of windowsFiles) copyRequired(path.join(desktopRelease, name), path.join(windowsTarget, name));

const apkSource = process.env.RHZYCODE_ANDROID_APK?.trim()
  ? path.resolve(process.env.RHZYCODE_ANDROID_APK)
  : path.join(root, "mobile", "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
const apkName = `RHZYCODE-Android-${mobileConfig.version}.apk`;
const apkTarget = path.join(androidTarget, apkName);
copyRequired(apkSource, apkTarget);

const macosRelease = await prepareMacosRelease();
const iosRelease = prepareIosRelease();

const windowsObject = `${prefix}/windows/${setupName}`;
const androidObject = `${prefix}/android/${apkName}`;
const feedUrl = publicObjectUrl(config, `${prefix}/windows`).replace(/\/+$/, "");
const windowsInstallerPath = path.join(windowsTarget, setupName);
const windowsSha256 = await sha256(windowsInstallerPath);
const androidSha256 = await sha256(apkTarget);
const manifest = {
  schemaVersion: 2,
  publishedAt: new Date().toISOString(),
  platforms: {
    windows: {
      version: desktopPackage.version,
      architecture: "x64",
      file: `windows/${setupName}`,
      downloadUrl: publicObjectUrl(config, windowsObject),
      feedUrl,
      metadataUrl: `${feedUrl}/latest.yml`,
      bytes: fs.statSync(windowsInstallerPath).size,
      sha256: windowsSha256,
      releaseNotes: "RHZYCODE Windows release",
    },
    android: {
      version: mobileConfig.version,
      versionCode: Number(mobileConfig.android?.versionCode || 1),
      file: `android/${apkName}`,
      downloadUrl: publicObjectUrl(config, androidObject),
      bytes: fs.statSync(apkTarget).size,
      sha256: androidSha256,
      releaseNotes: "RHZYCODE Android release",
    },
    ...(macosRelease ? { macos: macosRelease.manifest } : {}),
    ...(iosRelease ? { ios: iosRelease } : {}),
  },
};
parseUpdateManifest(manifest);
const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
fs.mkdirSync(stagingRoot, { recursive: true });
fs.writeFileSync(path.join(stagingRoot, config.manifestFile), manifestBody);

if (dryRun) {
  console.log(`Staged Windows ${manifest.platforms.windows.version}`);
  console.log(`Staged Android ${manifest.platforms.android.version} (${manifest.platforms.android.versionCode})`);
  if (manifest.platforms.macos) console.log(`Staged macOS ${manifest.platforms.macos.version} (${manifest.platforms.macos.architecture})`);
  if (manifest.platforms.ios) console.log(`Staged iOS ${manifest.platforms.ios.version} (${manifest.platforms.ios.buildNumber})`);
  console.log(`Manifest: ${path.join(stagingRoot, config.manifestFile)}`);
  process.exit(0);
}

const accessKey = requireEnvironment(config.accessKeyEnv);
const secretKey = requireEnvironment(config.secretKeyEnv);
const credentials = { ...config, accessKey, secretKey };
const uploads = [
  { filePath: windowsInstallerPath, objectName: windowsObject, contentType: "application/octet-stream", cacheControl: "public, max-age=31536000, immutable" },
  { filePath: path.join(windowsTarget, `${setupName}.blockmap`), objectName: `${prefix}/windows/${setupName}.blockmap`, contentType: "application/octet-stream", cacheControl: "public, max-age=31536000, immutable" },
  { filePath: path.join(windowsTarget, "latest.yml"), objectName: `${prefix}/windows/latest.yml`, contentType: "application/yaml; charset=utf-8", cacheControl: "no-cache, no-store, must-revalidate" },
  { filePath: apkTarget, objectName: androidObject, contentType: "application/vnd.android.package-archive", cacheControl: "public, max-age=31536000, immutable" },
  ...(macosRelease?.uploads || []),
];

for (const upload of uploads) {
  console.log(`Uploading ${upload.objectName}...`);
  await uploadFile({ ...credentials, ...upload });
}

// Publish the manifest last so clients never observe references to missing packages.
console.log(`Uploading ${manifestObject}...`);
await uploadBuffer({
  ...credentials,
  objectName: manifestObject,
  body: manifestBody,
  contentType: "application/json; charset=utf-8",
  cacheControl: "no-cache, no-store, must-revalidate",
});
await verifyPublicRelease(manifest, publicObjectUrl(config, manifestObject));
console.log(`Published Windows ${manifest.platforms.windows.version}`);
console.log(`Published Android ${manifest.platforms.android.version} (${manifest.platforms.android.versionCode})`);
if (manifest.platforms.macos) console.log(`Published macOS ${manifest.platforms.macos.version} (${manifest.platforms.macos.architecture})`);
if (manifest.platforms.ios) console.log(`Published iOS metadata ${manifest.platforms.ios.version} (${manifest.platforms.ios.buildNumber})`);
console.log(`Manifest URL: ${publicObjectUrl(config, manifestObject)}`);

function copyRequired(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Required update artifact is missing: ${source}`);
  if (path.resolve(source) === path.resolve(destination)) return;
  fs.copyFileSync(source, destination);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

async function verifyPublicRelease(expected, manifestUrl) {
  const uncachedManifestUrl = new URL(manifestUrl);
  uncachedManifestUrl.searchParams.set("_", String(Date.now()));
  const response = await fetch(uncachedManifestUrl, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Published manifest is not publicly readable (HTTP ${response.status}).`);
  const actual = await response.json();
  if (actual.schemaVersion !== expected.schemaVersion
    || Object.entries(expected.platforms).some(([platform, release]) => (
      actual.platforms?.[platform]?.version !== release.version
    ))) {
    throw new Error("Published manifest does not match the release that was uploaded.");
  }
  for (const artifact of Object.values(expected.platforms).filter((release) => release.downloadUrl && release.bytes)) {
    const head = await fetch(artifact.downloadUrl, { method: "HEAD", cache: "no-store" });
    if (!head.ok) throw new Error(`Published artifact is not publicly readable: ${artifact.downloadUrl} (HTTP ${head.status}).`);
    if (Number(head.headers.get("content-length")) !== artifact.bytes) {
      throw new Error(`Published artifact size is incorrect: ${artifact.downloadUrl}`);
    }
  }
  for (const release of Object.values(expected.platforms).filter((candidate) => candidate.metadataUrl)) {
    const metadata = await fetch(release.metadataUrl, { method: "HEAD", cache: "no-store" });
    if (!metadata.ok) throw new Error(`Desktop update metadata is not publicly readable (HTTP ${metadata.status}).`);
  }
  console.log("Verified anonymous public access to the manifest and release packages.");
}

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable is missing: ${name}`);
  return value;
}

function trimSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function validateConfig(value) {
  for (const key of ["endpoint", "bucket", "objectPrefix", "manifestFile", "accessKeyEnv", "secretKeyEnv"]) {
    if (!String(value[key] || "").trim()) throw new Error(`appupdate/config.json is missing ${key}.`);
  }
  const endpoint = new URL(value.endpoint);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new Error("MinIO endpoint must use HTTP or HTTPS.");
}

async function prepareMacosRelease() {
  const dmgSource = optionalArtifactEnvironment("RHZYCODE_MAC_DMG");
  if (!dmgSource) return null;
  const zipSource = requireArtifactEnvironment("RHZYCODE_MAC_ZIP");
  const metadataSource = requireArtifactEnvironment("RHZYCODE_MAC_METADATA");
  const target = path.join(stagingRoot, "macos");
  fs.mkdirSync(target, { recursive: true });
  const dmgName = path.basename(dmgSource);
  const zipName = path.basename(zipSource);
  const dmgTarget = path.join(target, dmgName);
  const zipTarget = path.join(target, zipName);
  const metadataTarget = path.join(target, "latest-mac.yml");
  copyRequired(dmgSource, dmgTarget);
  copyRequired(zipSource, zipTarget);
  copyRequired(metadataSource, metadataTarget);

  const objectRoot = `${prefix}/macos`;
  const feedUrl = publicObjectUrl(config, objectRoot).replace(/\/+$/, "");
  const uploads = [
    uploadDescriptor(dmgTarget, `${objectRoot}/${dmgName}`, "application/x-apple-diskimage", true),
    uploadDescriptor(zipTarget, `${objectRoot}/${zipName}`, "application/zip", true),
    uploadDescriptor(metadataTarget, `${objectRoot}/latest-mac.yml`, "application/yaml; charset=utf-8", false),
  ];
  for (const artifact of [dmgSource, zipSource]) {
    const blockmapSource = `${artifact}.blockmap`;
    if (!fs.existsSync(blockmapSource)) continue;
    const blockmapTarget = path.join(target, path.basename(blockmapSource));
    copyRequired(blockmapSource, blockmapTarget);
    uploads.push(uploadDescriptor(blockmapTarget, `${objectRoot}/${path.basename(blockmapSource)}`, "application/octet-stream", true));
  }

  return {
    manifest: {
      version: desktopPackage.version,
      architecture: process.env.RHZYCODE_MAC_ARCH?.trim() || "arm64",
      file: `macos/${dmgName}`,
      downloadUrl: publicObjectUrl(config, `${objectRoot}/${dmgName}`),
      feedUrl,
      metadataUrl: `${feedUrl}/latest-mac.yml`,
      bytes: fs.statSync(dmgTarget).size,
      sha256: await sha256(dmgTarget),
      releaseNotes: "RHZYCODE macOS release",
    },
    uploads,
  };
}

function prepareIosRelease() {
  const storeUrl = process.env.RHZYCODE_IOS_STORE_URL?.trim();
  if (!storeUrl) return null;
  return {
    version: mobileConfig.version,
    buildNumber: String(mobileConfig.ios?.buildNumber || "1"),
    storeUrl,
    releaseNotes: "RHZYCODE iOS release",
  };
}

function uploadDescriptor(filePath, objectName, contentType, immutable) {
  return {
    filePath,
    objectName,
    contentType,
    cacheControl: immutable ? "public, max-age=31536000, immutable" : "no-cache, no-store, must-revalidate",
  };
}

function optionalArtifactEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`${name} does not exist: ${resolved}`);
  return resolved;
}

function requireArtifactEnvironment(name) {
  const value = optionalArtifactEnvironment(name);
  if (!value) throw new Error(`${name} is required when publishing a macOS release.`);
  return value;
}
