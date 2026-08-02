import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const npmCli = process.env.npm_execpath || path.join(root, "node_modules", "npm", "bin", "npm-cli.js");
const result = spawnSync(process.execPath, [npmCli, "run", "dist:desktop"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    RHZYCODE_UPDATE_URL: "http://218.201.210.211:8000/updates/windows",
  },
});
if (result.error) console.error(result.error);
if (result.status !== 0) process.exit(result.status || 1);
