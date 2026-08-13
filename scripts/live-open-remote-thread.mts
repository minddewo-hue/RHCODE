import { performance } from "node:perf_hooks";
import path from "node:path";
import { DesktopRuntime } from "../desktop/src/main/runtime.ts";

const codexHome = path.join(process.env.APPDATA!, "@rhzycode", "desktop", "codex-home");
const largeId = "019fad89-d596-7362-a80a-3c97c5f0cb96";

const runtime = new DesktopRuntime(".", codexHome);
let resumeCalls = 0;
const originalRequest = runtime.agent.request.bind(runtime.agent);
runtime.agent.request = async (method: string, params?: unknown) => {
  if (method === "thread/resume") {
    resumeCalls += 1;
    throw new Error("simulated flaky resume timeout");
  }
  return originalRequest(method, params as never);
};

await runtime.listThreads();
const threads = [...(runtime as any).threads.values()] as Array<{ id: string; title?: string }>;
console.log(JSON.stringify({ threadCount: threads.length }));

async function probe(id: string, label: string) {
  resumeCalls = 0;
  const t0 = performance.now();
  const result = await (runtime as any).openRemoteThread(id);
  const ms = Math.round(performance.now() - t0);
  let users = 0, assistants = 0;
  for (const item of result.timeline) {
    if (item.kind === "user") users += 1;
    if (item.kind === "assistant") assistants += 1;
  }
  console.log(JSON.stringify({
    label,
    id,
    ms,
    resumeCalls,
    users,
    assistants,
    sparse: users > 0 && assistants < users,
    title: result.thread?.title || null,
  }));
  return { users, assistants, ms, resumeCalls };
}

const large = threads.find((t) => t.id === largeId);
if (large) {
  await probe(large.id, "large-complete");
} else {
  console.log(JSON.stringify({ label: "large-missing", id: largeId }));
}

// Probe a handful of recent threads for sparse/complete mix.
for (const thread of threads.slice(0, 10)) {
  if (thread.id === largeId) continue;
  try {
    await probe(thread.id, "sample");
  } catch (error) {
    console.log(JSON.stringify({ label: "sample-error", id: thread.id, error: String(error) }));
  }
}
