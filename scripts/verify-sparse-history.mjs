import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopRuntime } from "./desktop/src/main/runtime.ts";

const sourceHome = path.join(process.env.APPDATA, "@rhzycode", "desktop", "codex-home");
const threadId = "019fad89-d596-7362-a80a-3c97c5f0cb96";
const sourceRollout = (() => {
  const sessions = path.join(sourceHome, "sessions");
  for (const year of fs.readdirSync(sessions)) {
    for (const month of fs.readdirSync(path.join(sessions, year))) {
      for (const day of fs.readdirSync(path.join(sessions, year, month))) {
        const dir = path.join(sessions, year, month, day);
        for (const name of fs.readdirSync(dir)) {
          if (name.includes(threadId)) return path.join(dir, name);
        }
      }
    }
  }
  throw new Error("rollout not found");
})();

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-live-sparse-"));
const rel = path.relative(path.join(sourceHome, "sessions"), path.dirname(sourceRollout));
const targetDir = path.join(codexHome, "sessions", rel);
fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(sourceRollout, path.join(targetDir, path.basename(sourceRollout)));
// Minimal project path from rollout first line session_meta if present
const first = fs.readFileSync(sourceRollout, "utf8").split(/\r?\n/).find(Boolean);
const meta = JSON.parse(first);
const projectPath = meta?.payload?.cwd || path.join(codexHome, "project");
fs.mkdirSync(projectPath, { recursive: true });

const runtime = new DesktopRuntime(".", codexHome);
let resumeCalls = 0;
runtime.agent.request = async (method) => {
  if (method !== "thread/resume") throw new Error(`unexpected ${method}`);
  resumeCalls += 1;
  if (resumeCalls <= 2) {
    const err = new Error(resumeCalls === 1 ? "socket hang up" : "upstream timeout");
    throw err;
  }
  // Simulate a recovered history with matching assistant replies.
  return {
    model: "test/model",
    cwd: projectPath,
    thread: {
      id: threadId,
      cwd: projectPath,
      name: "Recovered large thread",
      preview: "Recovered",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "idle",
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            { id: "u1", type: "userMessage", content: [{ type: "input_text", text: "question one" }] },
            { id: "a1", type: "agentMessage", text: "assistant one" },
            { id: "u2", type: "userMessage", content: [{ type: "input_text", text: "question two" }] },
            { id: "a2", type: "agentMessage", text: "assistant two" },
            { id: "u3", type: "userMessage", content: [{ type: "input_text", text: "question three" }] },
            { id: "a3", type: "agentMessage", text: "assistant three" },
          ],
        },
      ],
    },
  };
};

await runtime.listThreads();
const firstOpen = await runtime.openThread(threadId, true);
const firstAssistants = firstOpen.messages.filter((m) => m.role === "assistant").length;
const firstUsers = firstOpen.messages.filter((m) => m.role === "user").length;
console.log(JSON.stringify({
  phase: "after-flaky-resume-fallback",
  resumeCalls,
  users: firstUsers,
  assistants: firstAssistants,
  incomplete: firstAssistants < firstUsers,
}, null, 2));

const secondOpen = await runtime.openThread(threadId, true);
const secondAssistants = secondOpen.messages.filter((m) => m.role === "assistant").length;
const secondUsers = secondOpen.messages.filter((m) => m.role === "user").length;
console.log(JSON.stringify({
  phase: "after-retry-requireAgent",
  resumeCalls,
  users: secondUsers,
  assistants: secondAssistants,
  sample: secondOpen.messages.slice(0, 6).map((m) => [m.role, m.content.slice(0, 40)]),
}, null, 2));

assert.ok(resumeCalls >= 3, "sparse cache must allow resume retries");
assert.ok(secondAssistants >= 3, "recovered assistants must appear after retry");
assert.ok(secondAssistants >= secondUsers, "assistant replies should catch up with users");

// openRemote path
const remote = await runtime.controlPlaneCommands?.openThread?.(threadId, { client: { id: "mobile-test" } });
// fallback: call private via any openRemote if exposed through commands registration
const remoteResult = await (runtime).openRemoteThread?.(threadId).catch(() => null);
console.log(JSON.stringify({
  phase: "remote-open",
  hasRemoteHelper: typeof (runtime).openRemoteThread === "function",
  resumeCalls,
}, null, 2));

fs.rmSync(codexHome, { recursive: true, force: true });
console.log("PASS live sparse recovery against large rollout");
