import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(desktopDir, "build", "icon.png");
const iconset = path.join(desktopDir, "build", "icon.iconset");
const output = path.join(desktopDir, "build", "icon.icns");

if (process.platform !== "darwin") throw new Error("macOS icon generation requires macOS.");
if (!fs.existsSync(source)) throw new Error(`Icon source is missing: ${source}`);

fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  resize(size, path.join(iconset, `icon_${size}x${size}.png`));
  resize(size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`));
}
run("iconutil", ["-c", "icns", iconset, "-o", output]);
fs.rmSync(iconset, { recursive: true, force: true });
console.log(output);

function resize(size, destination) {
  run("sips", ["-z", String(size), String(size), source, "--out", destination]);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
}
