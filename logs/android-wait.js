const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const root = process.cwd();
const pidFile = path.join(root, 'logs/android-release.pid');
const statusFile = path.join(root, 'logs/android-release-status.json');
const apk = path.join(root, 'mobile/android/app/build/outputs/apk/release/app-release.apk');
const logFile = path.join(root, 'logs/android-release.log');

function writeStatus(obj) {
  fs.writeFileSync(statusFile, JSON.stringify({ ...obj, ts: new Date().toISOString() }, null, 2));
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const start = Date.now();
const maxMs = 45 * 60 * 1000;

function tick() {
  let pid = null;
  try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); } catch {}
  const alive = pid && isPidAlive(pid);
  const apkExists = fs.existsSync(apk);
  let logTail = '';
  try {
    const txt = fs.readFileSync(logFile, 'utf8');
    logTail = txt.split(/\r?\n/).slice(-12).join('\n');
  } catch {}
  let apkSize = null;
  if (apkExists) apkSize = fs.statSync(apk).size;
  writeStatus({ pid, alive, apkExists, apkSize, elapsedSec: Math.round((Date.now()-start)/1000), logTail });
  if (!alive) {
    writeStatus({ pid, alive: false, apkExists, apkSize, elapsedSec: Math.round((Date.now()-start)/1000), done: true, logTail });
    process.exit(apkExists ? 0 : 1);
  }
  if (Date.now() - start > maxMs) {
    writeStatus({ pid, alive, apkExists, apkSize, done: true, timedOut: true, logTail });
    process.exit(2);
  }
  setTimeout(tick, 15000);
}
writeStatus({ started: true, pid: null });
tick();
