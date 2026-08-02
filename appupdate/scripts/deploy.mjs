import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseUpdateManifest } from "@rhzycode/update-contract";

const updateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(updateRoot, "..");
const config = JSON.parse(fs.readFileSync(path.join(updateRoot, "config.json"), "utf8"));
const updatesRoot = path.resolve(root, config.updatesDirectory);
const manifestPath = path.join(updatesRoot, "version.json");
const manifest = parseUpdateManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
const destination = `${config.sshUser}@${config.sshHost}`;
const remoteUpdates = `${String(config.remoteProject).replace(/\/+$/, "")}/updates`;
const files = releaseFiles(manifest);

run("ssh", [destination, `mkdir -p '${remoteUpdates}/windows' '${remoteUpdates}/android'`]);
for (const relativePath of files) {
  const localPath = safeLocalPath(relativePath);
  const remotePath = `${remoteUpdates}/${relativePath}`;
  console.log(`Uploading ${relativePath}`);
  run("scp", [localPath, `${destination}:${remotePath}`]);
}
const temporaryManifest = `${remoteUpdates}/.version.json.${Date.now()}.tmp`;
run("scp", [manifestPath, `${destination}:${temporaryManifest}`]);
run("ssh", [destination, `chmod 0644 '${temporaryManifest}' && mv -f '${temporaryManifest}' '${remoteUpdates}/version.json'`]);
console.log(`Deployed updates to ${destination}:${remoteUpdates}`);

function releaseFiles(value) {
  const result = [];
  if (value.platforms.windows) {
    const name = path.posix.basename(new URL(value.platforms.windows.downloadUrl).pathname);
    result.push(`windows/${name}`, `windows/${name}.blockmap`, "windows/latest.yml");
  }
  if (value.platforms.android) {
    const name = path.posix.basename(new URL(value.platforms.android.downloadUrl).pathname);
    result.push(`android/${name}`);
  }
  return result;
}

function safeLocalPath(relativePath) {
  if (!/^(?:windows|android)\/[A-Za-z0-9._-]+$/.test(relativePath)) {
    throw new Error(`Unsafe release path: ${relativePath}`);
  }
  const resolved = path.resolve(updatesRoot, ...relativePath.split("/"));
  if (!resolved.startsWith(`${updatesRoot}${path.sep}`) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Release file is missing: ${resolved}`);
  }
  return resolved;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
