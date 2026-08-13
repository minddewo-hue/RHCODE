import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedFileStore } from "../src/main/managed-file-store.js";
import { DesktopRuntime } from "../src/main/runtime.js";

test("lists and opens local conversations when App Server is offline", async (context) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-offline-history-"));
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));

  const threadId = "019fa195-11c9-76b2-84c1-bf33068b561e";
  const projectPath = path.join(codexHome, "offline-project");
  const turnId = "019fa195-11c9-76b2-84c1-bf33068b562f";
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "07", "27");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDirectory, `rollout-offline-${threadId}.jsonl`),
    [
      record("session_meta", { id: threadId, cwd: projectPath }),
      record("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>internal</environment_context>" }],
      }),
      record("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Load this conversation offline" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }),
      record("event_msg", { type: "user_message", message: "Load this conversation offline" }),
      record("response_item", {
        type: "message",
        id: "assistant-message",
        role: "assistant",
        content: [{ type: "output_text", text: "Loaded from the local rollout." }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }),
    ].join("\n"),
    "utf8",
  );

  const runtime = new DesktopRuntime(".", codexHome);
  runtime.agent.request = async () => {
    throw new Error("Agent Host is not running.");
  };

  const threads = await runtime.listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.id, threadId);
  assert.equal(threads[0]?.title, "Load this conversation offline");

  const detail = await runtime.openThread(threadId);
  assert.deepEqual(detail.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "Load this conversation offline" },
    { role: "assistant", content: "Loaded from the local rollout." },
  ]);
});

test("recovers uploaded rollout images once and hides serialized image path markup", async (context) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-offline-uploaded-image-"));
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const threadId = "019fa195-11c9-76b2-84c1-bf33068b5900";
  const turnId = "019fa195-11c9-76b2-84c1-bf33068b5901";
  const projectPath = path.join(codexHome, "offline-project");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "07", "30");
  const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=";
  const sourceImage = path.join(codexHome, "screen.png");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const originalBytes = Buffer.concat([Buffer.from(imageBase64, "base64"), Buffer.from([0])]);
  fs.writeFileSync(sourceImage, originalBytes);
  const managedFiles = new ManagedFileStore(path.join(codexHome, "attachments"));
  const [originalRecord] = managedFiles.registerUploads(threadId, [
    { path: sourceImage, name: "screen.png", kind: "image", size: originalBytes.length },
  ]);
  managedFiles.bindTurn([originalRecord.id], turnId);
  const recoveredRecord = managedFiles.storeUploadedImageData(
    threadId,
    turnId,
    `data:image/png;base64,${imageBase64}`,
    "recovered-screen.png",
  );
  assert.ok(recoveredRecord);
  assert.notEqual(originalRecord.path, recoveredRecord.path);
  fs.writeFileSync(
    path.join(sessionDirectory, `rollout-offline-${threadId}.jsonl`),
    [
      record("session_meta", { id: threadId, cwd: projectPath }),
      record("response_item", {
        type: "message",
        id: "image-user",
        role: "user",
        content: [
          { type: "input_text", text: "What is shown here?" },
          { type: "input_text", text: '<image name=[Image #1] path="C:\\temp\\mobile-attachments\\screen.png">' },
          { type: "input_image", image_url: `data:image/png;base64,${imageBase64}` },
          { type: "input_text", text: "</image>" },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }),
      record("response_item", {
        type: "message",
        id: "image-assistant",
        role: "assistant",
        content: [{ type: "output_text", text: "It is visible." }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }),
    ].join("\n"),
    "utf8",
  );

  const openOffline = async () => {
    const runtime = new DesktopRuntime(".", codexHome);
    runtime.agent.request = async () => { throw new Error("Agent Host is not running."); };
    await runtime.listThreads();
    return runtime.openThread(threadId);
  };

  const first = await openOffline();
  const user = first.messages.find((message) => message.role === "user");
  assert.equal(user?.content, "What is shown here?");
  assert.equal(user?.files?.length, 1);
  assert.equal(user?.files?.[0]?.id, originalRecord.id);
  assert.equal(user?.files?.[0]?.name, "screen.png");
  assert.equal(user?.files?.[0]?.mimeType, "image/png");
  assert.equal(fs.existsSync(user?.files?.[0]?.path || ""), true);

  const restored = await openOffline();
  assert.equal(restored.messages.find((message) => message.role === "user")?.files?.[0]?.id, user?.files?.[0]?.id);
});

test("restores generated image links from local rollout without App Server", async (context) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-offline-generated-image-"));
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));

  const threadId = "019fa195-11c9-76b2-84c1-bf33068b6100";
  const turnId = "019fa195-11c9-76b2-84c1-bf33068b6101";
  const projectPath = path.join(codexHome, "offline-project");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "03");
  const imagePath = path.join(projectPath, "playwright-graph-drag-color-fixed.png");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=",
    "base64",
  ));
  fs.writeFileSync(
    path.join(sessionDirectory, `rollout-offline-${threadId}.jsonl`),
    [
      record("session_meta", { id: threadId, cwd: projectPath }),
      record("response_item", {
        type: "message",
        id: "user-image-link",
        role: "user",
        content: [{ type: "input_text", text: "Show the graph screenshot" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }),
      record("response_item", {
        type: "message",
        id: "assistant-image-link",
        role: "assistant",
        content: [{
          type: "output_text",
          text: `截图文件仍保存在\n\`${imagePath}\`。`,
        }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }),
    ].join("\n"),
    "utf8",
  );

  const openOffline = async () => {
    const runtime = new DesktopRuntime(".", codexHome);
    runtime.agent.request = async () => {
      throw new Error("Agent Host is not running.");
    };
    await runtime.listThreads();
    return runtime.openThread(threadId);
  };

  const first = await openOffline();
  const assistant = first.messages.find((message) => message.role === "assistant");
  assert.equal(assistant?.content.includes("截图文件仍保存在"), true);
  assert.equal(assistant?.images?.length, 1);
  assert.equal(assistant?.images?.[0]?.name, "playwright-graph-drag-color-fixed.png");
  assert.equal(assistant?.images?.[0]?.generated, true);
  assert.deepEqual(
    fs.readFileSync(assistant?.images?.[0]?.path || ""),
    fs.readFileSync(imagePath),
  );

  const restored = await openOffline();
  const restoredAssistant = restored.messages.find((message) => message.role === "assistant");
  assert.equal(restoredAssistant?.images?.[0]?.name, "playwright-graph-drag-color-fixed.png");
  assert.equal(restoredAssistant?.images?.[0]?.generated, true);
});
test("hides internal context-compaction handoff messages from local history", async (context) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-offline-compaction-"));
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));

  const threadId = "019fa195-11c9-76b2-84c1-bf33068b5700";
  const projectPath = path.join(codexHome, "offline-project");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "07", "30");
  const compactionSummary = "## Handoff Summary\n\n### Current State\n\n- Internal state only.";
  const compactionMessage = `Another language model started to solve this problem.\n${compactionSummary}`;
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDirectory, `rollout-offline-${threadId}.jsonl`),
    [
      record("session_meta", { id: threadId, cwd: projectPath }),
      record("response_item", {
        type: "message",
        id: "real-user",
        role: "user",
        content: [{ type: "input_text", text: "Keep my real question" }],
      }),
      record("response_item", {
        type: "message",
        id: "real-assistant",
        role: "assistant",
        content: [{ type: "output_text", text: "Keep the real answer." }],
      }),
      record("response_item", {
        type: "message",
        id: "handoff-user",
        role: "user",
        content: [{ type: "input_text", text: compactionMessage }],
      }),
      record("response_item", {
        type: "message",
        id: "handoff-assistant",
        role: "assistant",
        content: [{ type: "output_text", text: compactionSummary }],
      }),
      record("event_msg", { type: "token_count" }),
      record("compacted", { message: compactionMessage, replacement_history: [] }),
      record("response_item", {
        type: "message",
        id: "post-compaction-user",
        role: "user",
        content: [{ type: "input_text", text: "Keep the next question" }],
      }),
      record("response_item", {
        type: "message",
        id: "post-compaction-assistant",
        role: "assistant",
        content: [{ type: "output_text", text: "Keep the next answer." }],
      }),
    ].join("\n"),
    "utf8",
  );

  const runtime = new DesktopRuntime(".", codexHome);
  runtime.agent.request = async () => {
    throw new Error("Agent Host is not running.");
  };

  await runtime.listThreads();
  const detail = await runtime.openThread(threadId);
  assert.deepEqual(detail.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "Keep my real question" },
    { role: "assistant", content: "Keep the real answer." },
    { role: "user", content: "Keep the next question" },
    { role: "assistant", content: "Keep the next answer." },
  ]);
});

function record(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-07-27T10:00:00.000Z", type, payload });
}


test("ignores obsolete event_msg history rows", async (context) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-offline-legacy-ids-"));
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));

  const threadId = "019fa195-11c9-76b2-84c1-bf33068b5800";
  const projectPath = path.join(codexHome, "offline-project");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "07", "30");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDirectory, `rollout-offline-${threadId}.jsonl`),
    [
      record("session_meta", { id: threadId, cwd: projectPath }),
      record("event_msg", { type: "user_message", message: "First question" }),
      record("event_msg", { type: "agent_message", message: "First answer" }),
      record("event_msg", { type: "user_message", message: "Second question" }),
      record("event_msg", { type: "agent_message", message: "Second answer" }),
    ].join("\n"),
    "utf8",
  );

  const runtime = new DesktopRuntime(".", codexHome);
  runtime.agent.request = async () => {
    throw new Error("Agent Host is not running.");
  };

  await runtime.listThreads();
  const detail = await runtime.openThread(threadId);
  assert.deepEqual(detail.messages, []);
});


test("does not cache sparse local fallback as agent-loaded history", async (context) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-sparse-cache-"));
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));

  const threadId = "019fa195-11c9-76b2-84c1-bf33068b6000";
  const projectPath = path.join(codexHome, "offline-project");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "02");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDirectory, `rollout-sparse-${threadId}.jsonl`),
    [
      record("session_meta", { id: threadId, cwd: projectPath }),
      record("response_item", {
        type: "message",
        id: "user-1",
        role: "user",
        content: [{ type: "input_text", text: "First question" }],
      }),
      record("response_item", {
        type: "message",
        id: "user-2",
        role: "user",
        content: [{ type: "input_text", text: "Second question" }],
      }),
      record("response_item", {
        type: "message",
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "output_text", text: "Only one local answer" }],
      }),
    ].join("\n"),
    "utf8",
  );

  const runtime = new DesktopRuntime(".", codexHome);
  let resumeCalls = 0;
  runtime.agent.request = async (method: string) => {
    if (method === "thread/resume") {
      resumeCalls += 1;
      if (resumeCalls === 1) {
        throw new Error("temporary agent host timeout");
      }
      return {
        model: "test/model",
        cwd: projectPath,
        thread: {
          id: threadId,
          cwd: projectPath,
          name: "Recovered conversation",
          preview: "Recovered conversation",
          createdAt: 1,
          updatedAt: 2,
          status: "idle",
          turns: [{
            id: "turn-1",
            status: "completed",
            items: [
              { id: "u1", type: "userMessage", content: [{ type: "input_text", text: "First question" }] },
              { id: "a1", type: "agentMessage", text: "First recovered answer" },
              { id: "u2", type: "userMessage", content: [{ type: "input_text", text: "Second question" }] },
              { id: "a2", type: "agentMessage", text: "Second recovered answer" },
            ],
          }],
        },
      };
    }
    throw new Error(`Unexpected method ${method}`);
  };

  await runtime.listThreads();
  const first = await runtime.openThread(threadId, true);
  assert.deepEqual(first.messages.map((message) => message.role), ["user", "user", "assistant"]);
  assert.equal(resumeCalls, 1);

  const second = await runtime.openThread(threadId, true);
  assert.equal(resumeCalls, 2, "sparse fallback must not be treated as a loaded agent thread");
  assert.deepEqual(second.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "First question" },
    { role: "assistant", content: "First recovered answer" },
    { role: "user", content: "Second question" },
    { role: "assistant", content: "Second recovered answer" },
  ]);
});

test("forces resume when local history has fewer assistants than users", async (context) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-sparse-ratio-"));
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));

  const threadId = "019fa195-11c9-76b2-84c1-bf33068b6001";
  const projectPath = path.join(codexHome, "offline-project");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "02");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDirectory, `rollout-sparse-ratio-${threadId}.jsonl`),
    [
      record("session_meta", { id: threadId, cwd: projectPath }),
      record("response_item", {
        type: "message",
        id: "user-1",
        role: "user",
        content: [{ type: "input_text", text: "One" }],
      }),
      record("response_item", {
        type: "message",
        id: "user-2",
        role: "user",
        content: [{ type: "input_text", text: "Two" }],
      }),
      record("response_item", {
        type: "message",
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "output_text", text: "Only local" }],
      }),
    ].join("\n"),
    "utf8",
  );

  const runtime = new DesktopRuntime(".", codexHome);
  let resumeCalls = 0;
  runtime.agent.request = async (method: string) => {
    if (method === "thread/resume") {
      resumeCalls += 1;
      return {
        model: "test/model",
        cwd: projectPath,
        thread: {
          id: threadId,
          cwd: projectPath,
          name: "Full conversation",
          preview: "Full conversation",
          createdAt: 1,
          updatedAt: 2,
          status: "idle",
          turns: [{
            id: "turn-1",
            status: "completed",
            items: [
              { id: "u1", type: "userMessage", content: [{ type: "input_text", text: "One" }] },
              { id: "a1", type: "agentMessage", text: "Answer one" },
              { id: "u2", type: "userMessage", content: [{ type: "input_text", text: "Two" }] },
              { id: "a2", type: "agentMessage", text: "Answer two" },
            ],
          }],
        },
      };
    }
    throw new Error(`Unexpected method ${method}`);
  };

  await runtime.listThreads();
  const detail = await runtime.openThread(threadId);
  assert.equal(resumeCalls, 1);
  assert.deepEqual(detail.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "One" },
    { role: "assistant", content: "Answer one" },
    { role: "user", content: "Two" },
    { role: "assistant", content: "Answer two" },
  ]);
});
