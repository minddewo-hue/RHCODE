import path from "node:path";
import { DesktopRuntime } from "../desktop/src/main/runtime.ts";

const codexHome = path.join(process.env.APPDATA!, "@rhzycode", "desktop", "codex-home");
const runtime = new DesktopRuntime(".", codexHome);
runtime.agent.request = async (method: string) => {
  if (method === "thread/resume") throw new Error("no resume in size probe");
  throw new Error(`unexpected ${method}`);
};
await runtime.listThreads();
const ids = [
  "019fad89-d596-7362-a80a-3c97c5f0cb96",
  ...(runtime as any).threads.keys(),
].filter((v, i, a) => a.indexOf(v) === i).slice(0, 12);

for (const id of ids) {
  try {
    const t0 = performance.now();
    const result = await (runtime as any).openRemoteThread(id);
    const json = JSON.stringify(result);
    const b64 = Buffer.byteLength(Buffer.from(json).toString("base64"));
    let users = 0, assistants = 0, content = 0;
    for (const item of result.timeline) {
      if (item.kind === "user") users++;
      if (item.kind === "assistant") assistants++;
      content += (item.content || "").length;
    }
    console.log(JSON.stringify({
      id: id.slice(0, 8),
      ms: Math.round(performance.now() - t0),
      items: result.timeline.length,
      users,
      assistants,
      contentChars: content,
      jsonMB: +(Buffer.byteLength(json) / 1024 / 1024).toFixed(2),
      relayFrameMB: +(b64 / 1024 / 1024).toFixed(2),
      title: (result.thread.title || "").slice(0, 40),
    }));
  } catch (e) {
    console.log(JSON.stringify({ id: id.slice(0, 8), error: String(e) }));
  }
}
