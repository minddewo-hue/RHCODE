import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const e = 'D:/work_space/RHZYCODE/node_modules/electron/dist/electron.exe';
const r = spawnSync(e, ['--version'], { encoding: 'utf8', timeout: 30000 });
const out = [
  `exit=${r.status}`,
  `signal=${r.signal}`,
  `stdout=${JSON.stringify(r.stdout)}`,
  `stderr=${JSON.stringify(r.stderr)}`,
  `error=${r.error ? String(r.error) : 'none'}`,
];
fs.writeFileSync('D:/work_space/RHZYCODE/__probe.log', out.join('\n'), 'utf8');
