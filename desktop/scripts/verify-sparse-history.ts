import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopRuntime } from "../src/main/runtime.ts";

async function main() {
  const sourceHome = path.join(process.env.APPDATA!, "@rhzycode", "desktop", "codex-home");
  const threadId = "019fad89-d596-7362-a80a-3c97c5f0cb96";

  function findRollout(root: string, id: string): string {
    const sessions = path.join(root, "sessions");
    for (const year of fs.readdirSync(sessions)) {
      for (const month of fs.readdirSync(path.join(sessions, year))) {
        for (const day of fs.readdirSync(path.join(sessions, year, month))) {
          const dir = path.join(sessions, year, month, day);
          for (const name of fs.readdirSync(dir)) {
            if (name.includes(id)) return path.join(dir, name);
          }
        }
      }
    }
    throw new Error("rollout not found");
  }

  const sourceRollout = findRollout(sourceHome, threadId);
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-live-sparse-"));
  const rel = path.relative(path.join(sourceHome, "sessions"), path.dirname(sourceRollout));
  const targetDir = path.join(codexHome, "sessions", rel);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(sourceRollout, path.join(targetDir, path.basename(sourceRollout)));
  const firstLine = fs.readFileSync(sourceRollout, "utf8").split(/\r?\n/).find(Boolean)!;
  const meta = JSON.parse(firstLine) as { payload?: { cwd?: string } };
  const projectPath = meta.payload?.cwd || path.join(codexHome, "project");
  fs.mkdirSync(projectPath, { recursive: true });

  const runtime = new DesktopRuntime(".", codexHome);
  let resumeCalls = 0;
  runtime.agent.request = async (method: string) => {
    if (method !== "thread/resume") throw new Error(`unexpected ${method}`);
    resumeCalls += 1;
    if (resumeCalls <= 2) throw new Error(resumeCalls === 1 ? "socket hang up" : "upstream timeout");
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
        turns: [{
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
        }],
      },
    };
  };

  await runtime.listThreads();
  const firstOpen = await runtime.openThread(threadId, true);
  console.log(JSON.stringify({
    phase: "after-flaky-resume-fallback",
    resumeCalls,
    users: firstOpen.messages.filter((m) => m.role === "user").length,
    assistants: firstOpen.messages.filter((m) => m.role === "assistant").length,
  }, null, 2));

  const secondOpen = await runtime.openThread(threadId, true);
  console.log(JSON.stringify({
    phase: "after-retry-requireAgent",
    resumeCalls,
    users: secondOpen.messages.filter((m) => m.role === "user").length,
    assistants: secondOpen.messages.filter((m) => m.role === "assistant").length,
    sample: secondOpen.messages.slice(0, 6).map((m) => [m.role, m.content.slice(0, 48)]),
  }, null, 2));

  assert.ok(resumeCalls >= 3, "sparse cache must allow resume retries");
  assert.equal(secondOpen.messages.filter((m) => m.role === "assistant").length, 3);
  assert.equal(secondOpen.messages.filter((m) => m.role === "user").length, 3);

  resumeCalls = 0;
  runtime.agent.request = async (method: string) => {
    if (method !== "thread/resume") throw new Error(`unexpected ${method}`);
    resumeCalls += 1;
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
        turns: [{
          id: "turn-1",
          status: "completed",
          items: [
            { id: "u1", type: "userMessage", content: [{ type: "input_text", text: "question one" }] },
            { id: "a1", type: "agentMessage", text: "assistant one" },
            { id: "u2", type: "userMessage", content: [{ type: "input_text", text: "question two" }] },
            { id: "a2", type: "agentMessage", text: "assistant two" },
          ],
        }],
      },
    };
  };
  (runtime as any).loadedThreadIds?.clear?.();
  (runtime as any).threadDetailCache?.clear?.();
  const display = await runtime.openThread(threadId, false);
  console.log(JSON.stringify({
    phase: "display-open-forces-resume",
    resumeCalls,
    users: display.messages.filter((m) => m.role === "user").length,
    assistants: display.messages.filter((m) => m.role === "assistant").length,
  }, null, 2));
  assert.equal(resumeCalls, 1);
  assert.equal(display.messages.filter((m) => m.role === "assistant").length, 2);

  fs.rmSync(codexHome, { recursive: true, force: true });
  console.log("PASS live sparse recovery against large rollout");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
