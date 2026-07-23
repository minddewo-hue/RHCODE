import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("macOS releases must be built on macOS.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const npmCli = process.env.npm_execpath || path.join(root, "node_modules", "npm", "bin", "npm-cli.js");
const result = spawnSync(process.execPath, [npmCli, "run", "dist:mac"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    RHZYCODE_UPDATE_URL: "https://minio.gshbzw.com/wxfile/rhzycode/macos",
  },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
