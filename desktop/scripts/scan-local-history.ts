import fs from "node:fs";
import path from "node:path";
import { loadLocalRolloutThread } from "../src/main/local-rollout-thread.ts";

const home = path.join(process.env.APPDATA!, "@rhzycode", "desktop", "codex-home");
const sessions = path.join(home, "sessions");
const files = [];
for (const year of fs.readdirSync(sessions)) {
  for (const month of fs.readdirSync(path.join(sessions, year))) {
    for (const day of fs.readdirSync(path.join(sessions, year, month))) {
      const dir = path.join(sessions, year, month, day);
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
          const full = path.join(dir, name);
          files.push({ full, size: fs.statSync(full).size, name });
        }
      }
    }
  }
}
files.sort((a, b) => b.size - a.size);
for (const file of files.slice(0, 12)) {
  const idMatch = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(file.name);
  const id = idMatch?.[1] || file.name;
  const detail = await loadLocalRolloutThread(home, {
    id,
    hostId: "local-desktop",
    title: id,
    projectPath: "x",
    model: "x",
    status: "idle",
    updatedAt: new Date().toISOString(),
  }, []);
  const users = detail?.messages.filter((m) => m.role === "user").length || 0;
  const assistants = detail?.messages.filter((m) => m.role === "assistant").length || 0;
  console.log(JSON.stringify({
    mb: +(file.size / 1024 / 1024).toFixed(2),
    users,
    assistants,
    sparse: users > 0 && assistants < users,
    id,
  }));
}
