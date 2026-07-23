import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mobile = path.join(root, "mobile");
const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "D:\\android_sdk";
if (!fs.existsSync(androidHome)) throw new Error(`Android SDK was not found at ${androidHome}.`);

const expoCli = path.join(root, "node_modules", "expo", "bin", "cli");
run(process.execPath, [expoCli, "prebuild", "--platform", "android", "--no-install"], mobile);
const gradle = path.join(mobile, "android", process.platform === "win32" ? "gradlew.bat" : "gradlew");
const noProxyInit = path.join(root, "appupdate", "scripts", "gradle-no-proxy.init.gradle");
if (process.platform === "win32") {
  const gradleCommand = `call ${gradle} --init-script ${noProxyInit} assembleRelease`;
  run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", gradleCommand], path.join(mobile, "android"));
} else {
  run(gradle, ["--init-script", noProxyInit, "assembleRelease"], path.join(mobile, "android"));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      ANDROID_HOME: androidHome,
      ANDROID_SDK_ROOT: androidHome,
      NODE_ENV: process.env.NODE_ENV || "production",
      EXPO_PUBLIC_UPDATE_URL: "https://minio.gshbzw.com/wxfile/rhzycode/version.json",
    },
  });
  if (result.error) console.error(result.error);
  if (result.status !== 0) process.exit(result.status || 1);
}
