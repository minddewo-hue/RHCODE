import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const updateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(updateRoot, "..");
const artifactsRoot = path.join(updateRoot, "artifacts");
const desktopRelease = path.join(root, "desktop", "release");
const desktopPackage = readJson(path.join(root, "desktop", "package.json"));
const mobileConfig = readJson(path.join(root, "mobile", "app.json")).expo;
const desktopTarget = path.join(artifactsRoot, "desktop");
const mobileTarget = path.join(artifactsRoot, "mobile");

fs.mkdirSync(desktopTarget, { recursive: true });
fs.mkdirSync(mobileTarget, { recursive: true });

const setupName = `RHZYCODE-Setup-${desktopPackage.version}-x64.exe`;
const desktopFiles = ["latest.yml", setupName, `${setupName}.blockmap`];
for (const name of desktopFiles) copyRequired(path.join(desktopRelease, name), path.join(desktopTarget, name));

const apkSource = process.env.RHZYCODE_ANDROID_APK?.trim()
  ? path.resolve(process.env.RHZYCODE_ANDROID_APK)
  : path.join(root, "mobile", "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
const apkName = `RHZYCODE-Android-${mobileConfig.version}.apk`;
const apkTarget = path.join(mobileTarget, apkName);
copyRequired(apkSource, apkTarget);

const channel = {
  schemaVersion: 1,
  publishedAt: new Date().toISOString(),
  desktop: {
    version: desktopPackage.version,
    path: `desktop/${setupName}`,
    bytes: fs.statSync(path.join(desktopTarget, setupName)).size,
    sha256: sha256(path.join(desktopTarget, setupName)),
    releaseNotes: "RHZYCODE local desktop release",
  },
  android: {
    version: mobileConfig.version,
    versionCode: Number(mobileConfig.android?.versionCode || 1),
    path: `mobile/${apkName}`,
    bytes: fs.statSync(apkTarget).size,
    sha256: sha256(apkTarget),
    releaseNotes: "RHZYCODE local Android release",
  },
};
fs.writeFileSync(path.join(updateRoot, "channel.json"), `${JSON.stringify(channel, null, 2)}\n`, "utf8");
console.log(`Published desktop ${channel.desktop.version}`);
console.log(`Published Android ${channel.android.version} (${channel.android.versionCode})`);

function copyRequired(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Required update artifact is missing: ${source}`);
  fs.copyFileSync(source, destination);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
