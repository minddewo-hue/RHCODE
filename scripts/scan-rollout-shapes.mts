import fs from "node:fs";
import path from "node:path";

const home = path.join(process.env.APPDATA!, "@rhzycode", "desktop", "codex-home", "sessions");
function find(id: string): string {
  for (const y of fs.readdirSync(home))
    for (const m of fs.readdirSync(path.join(home, y)))
      for (const d of fs.readdirSync(path.join(home, y, m)))
        for (const n of fs.readdirSync(path.join(home, y, m, d)))
          if (n.includes(id)) return path.join(home, y, m, d, n);
  throw new Error("missing");
}

const files = [] as string[];
for (const y of fs.readdirSync(home))
  for (const m of fs.readdirSync(path.join(home, y)))
    for (const d of fs.readdirSync(path.join(home, y, m)))
      for (const n of fs.readdirSync(path.join(home, y, m, d)))
        if (n.startsWith("rollout-") && n.endsWith(".jsonl"))
          files.push(path.join(home, y, m, d, n));

const stats = [] as any[];
for (const file of files) {
  const id = /([0-9a-f-]{36})/i.exec(path.basename(file))?.[1] || path.basename(file);
  let respUser=0, respAsst=0, eventAgent=0, eventUser=0, otherAsst=0;
  const types = new Map<string, number>();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    types.set(r.type, (types.get(r.type)||0)+1);
    if (r.type === "response_item" && r.payload?.type === "message") {
      if (r.payload.role === "user") respUser++;
      if (r.payload.role === "assistant") respAsst++;
    }
    if (r.type === "event_msg") {
      const t = r.payload?.type;
      if (t === "agent_message" || t === "assistant_message") eventAgent++;
      if (t === "user_message") eventUser++;
    }
  }
  const size = fs.statSync(file).size;
  if (respUser > 0 || eventAgent > 0) {
    stats.push({
      id: id.slice(0,8), mb:+(size/1024/1024).toFixed(2),
      respUser, respAsst, eventAgent, eventUser,
      sparseResp: respUser>0 && respAsst<respUser,
      types: Object.fromEntries([...types.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8)),
    });
  }
}
stats.sort((a,b)=>b.mb-a.mb);
for (const s of stats.slice(0,15)) console.log(JSON.stringify(s));
console.log("--- sparse response_item ---");
for (const s of stats.filter(s=>s.sparseResp).slice(0,20)) console.log(JSON.stringify(s));
