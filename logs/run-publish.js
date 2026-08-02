const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const out = fs.openSync(path.join(root, 'logs/update-publish.log'), 'w');
const err = fs.openSync(path.join(root, 'logs/update-publish.err.log'), 'w');
const child = spawn(process.execPath, ['appupdate/scripts/publish.mjs'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', out, err],
  env: process.env,
});
fs.writeFileSync(path.join(root, 'logs/update-publish.pid'), String(child.pid));
child.unref();
console.log('started', child.pid);
