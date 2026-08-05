const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");

app.setPath("userData", path.join(process.env.APPDATA, "@rhzycode", "desktop"));

app.whenReady().then(() => {
  const statePath = path.join(
    process.env.APPDATA,
    "@rhzycode",
    "desktop",
    "control-state.bin",
  );
  const state = JSON.parse(safeStorage.decryptString(fs.readFileSync(statePath)));
  const matches = state.snapshot.timeline.filter((item) => item.content === "NEWDUPVERIFY1639");
  const mobilePath = path.join(path.dirname(statePath), "mobile-access-state.bin");
  const mobile = JSON.parse(safeStorage.decryptString(fs.readFileSync(mobilePath)));
  process.stdout.write(`${JSON.stringify({
    matches,
    mobileShape: Object.fromEntries(Object.entries(mobile).map(([key, value]) => [
      key,
      Array.isArray(value) ? `array:${value.length}` : typeof value,
    ])),
  }, null, 2)}\n`);
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
