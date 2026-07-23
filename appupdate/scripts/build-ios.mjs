import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("iOS releases must be built on macOS with Xcode.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mobile = path.join(root, "mobile");
const appConfig = readJson(path.join(mobile, "app.json")).expo;
const expoCli = path.join(root, "node_modules", "expo", "bin", "cli");
const exportOptions = requireFileEnvironment("RHZYCODE_IOS_EXPORT_OPTIONS_PLIST");
const scheme = process.env.RHZYCODE_IOS_SCHEME?.trim() || appConfig.name;
const releaseRoot = path.join(mobile, "release-ios");
const archivePath = path.join(releaseRoot, `${scheme}.xcarchive`);
const exportPath = path.join(releaseRoot, "export");

fs.mkdirSync(releaseRoot, { recursive: true });
fs.rmSync(archivePath, { recursive: true, force: true });
fs.rmSync(exportPath, { recursive: true, force: true });
run(process.execPath, [expoCli, "prebuild", "--platform", "ios", "--no-install"], mobile);
run("xcodebuild", [
  "-workspace", path.join(mobile, "ios", `${scheme}.xcworkspace`),
  "-scheme", scheme,
  "-configuration", "Release",
  "-sdk", "iphoneos",
  "-archivePath", archivePath,
  "archive",
], mobile);
run("xcodebuild", [
  "-exportArchive",
  "-archivePath", archivePath,
  "-exportPath", exportPath,
  "-exportOptionsPlist", exportOptions,
], mobile);

const ipa = fs.readdirSync(exportPath).find((name) => name.endsWith(".ipa"));
if (!ipa) throw new Error(`Xcode did not produce an IPA in ${exportPath}.`);
const finalPath = path.join(releaseRoot, `RHZYCODE-iOS-${appConfig.version}.ipa`);
fs.copyFileSync(path.join(exportPath, ipa), finalPath);
console.log(finalPath);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function requireFileEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must point to an App Store export options plist.`);
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`${name} does not exist: ${resolved}`);
  return resolved;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
