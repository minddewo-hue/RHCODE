import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { compareTimelineOrder } from "@rhzycode/protocol";
import { DesktopRuntime } from "../src/main/runtime";
import { MobileAccessManager } from "../src/main/control-plane/mobile-access";
import { ControlClient } from "../../mobile/src/api/control-client";
import { refreshThreadTimeline } from "../../mobile/src/api/timeline-refresh";
import { createConnectionState, createControlPlaneRuntime } from "../../mobile/src/hooks/control-connection-runtime";
import { mergeTimelineDelta } from "../../mobile/src/state/control-reducer";

// Isolate smoke threads and credentials; never register them on the public relay.
process.env.RHZYCODE_TRANSFER_SERVER_URL = "http://127.0.0.1:9";
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(desktopRoot, "..");
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-live-mobile-"));
const access = new MobileAccessManager();
const key = access.rotateAccessKey();
const runtime = new DesktopRuntime(desktopRoot, codexHome, undefined, access);
const model = process.env.RHZYCODE_SMOKE_MODEL || "sub2api/gpt-5.6-luna";
let state = createConnectionState("connecting");
let connection: ReturnType<typeof createControlPlaneRuntime> | undefined;
let threadId = "";
let finished = false;
let turnError: unknown = null;
let deltaCount = 0;
let streamingSamples = 0;
let mismatch: string | null = null;
let appState = "active";
const rawText = new Map<string, string>();
const rawCommands = new Set<string>();

runtime.on("agent:message", (message: { method?: string; params?: Record<string, any> }) => {
  const params = message.params || {};
  if (params.threadId !== threadId) return;
  const turnId = params.turnId || params.turn?.id;
  if (message.method === "item/agentMessage/delta") {
    const id = `${turnId}::${params.itemId}`;
    rawText.set(id, (rawText.get(id) || "") + String(params.delta || ""));
    deltaCount += 1;
  }
  if (message.method === "item/completed" && params.item?.type === "agentMessage") {
    rawText.set(`${turnId}::${params.item.id}`, String(params.item.text || ""));
  }
  if (message.method === "item/commandExecution/outputDelta") rawCommands.add(String(params.itemId));
  if (message.method === "item/completed" && params.item?.type === "commandExecution") {
    rawCommands.add(String(params.item.id));
  }
  if (message.method === "turn/completed") {
    finished = true;
    if (params.turn?.status !== "completed") turnError = params.turn;
  }
});

async function waitUntil(check: () => boolean, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}

try {
  await runtime.start();
  await waitUntil(() => Boolean(runtime.getSyncStatus().url), "desktop HTTP service");
  const client = new ControlClient(key.key, { controlUrl: runtime.getSyncStatus().url! });
  connection = createControlPlaneRuntime({
    client,
    readAppState: () => appState,
    onState: (value) => {
      state = typeof value === "function" ? value(state) : { ...state, ...value };
      for (const row of state.snapshot.timeline) {
        if (row.threadId !== threadId || row.kind !== "assistant") continue;
        const expected = rawText.get(row.id);
        if (expected !== undefined && !expected.startsWith(row.content)) {
          mismatch = `Mobile text differs from raw desktop events: ${row.id}`;
        }
        if (row.status === "running" && row.content) streamingSamples += 1;
      }
    },
    onCredentialsRejected: () => { mismatch = "Credentials unexpectedly rejected"; },
  });
  await waitUntil(() => state.status === "online", "mobile connection");
  const started = await runtime.startThread({ cwd: workspaceRoot, model }) as { thread?: { id?: string } };
  threadId = started.thread?.id || "";
  assert.ok(threadId);
  const prompts = [
    "Do not use tools. Write exactly 40 numbered lines about testing streaming text synchronization. Each line must be a complete sentence with at least 12 words. Include Unicode Chinese text in several lines. Do not abbreviate the output.",
    "First use the shell to run Write-Output RHZY_MOBILE_TOOL_OK without modifying any files. Then write 35 numbered complete sentences about reliable mobile cache refresh, at least 12 words each.",
    "Do not use tools. Write 40 numbered complete sentences about reconnecting a mobile streaming client, at least 12 words per line, followed by a small Markdown table and a code block. Include Chinese punctuation and text.",
  ];
  for (const [index, prompt] of prompts.entries()) {
    finished = false;
    turnError = null;
    const beforeDeltas = deltaCount;
    const beforeSamples = streamingSamples;
    await runtime.startTurn({ threadId, model, text: prompt, approvalPolicy: "never", sandboxMode: "read-only" });
    await waitUntil(() => deltaCount > beforeDeltas || finished, "first stream delta", 120_000);
    assert.equal(finished, false, "turn must stream before completion");
    // Race an authoritative history refresh against active WebSocket delivery.
    await refreshThreadTimeline(
      (cursor) => client.fetchThreadTimeline(threadId, cursor, 2),
      (page) => { state = { ...state, snapshot: mergeTimelineDelta(state.snapshot, page) }; },
    );
    if (index === 1) {
      appState = "background";
      connection.pause?.();
      await delay(700);
      appState = "active";
      connection.resume?.();
    }
    await waitUntil(() => finished, "turn completion", 180_000);
    assert.equal(turnError, null, JSON.stringify(turnError));
    await waitUntil(() => state.snapshot.lastSequence >= runtime.getSnapshot().lastSequence, "mobile event drain");
    assert.equal(mismatch, null);
    for (const [id, expected] of rawText) {
      const row = state.snapshot.timeline.find((item) => item.id === id);
      assert.equal(row?.content, expected, `final raw/mobile body ${id}`);
      assert.equal(row?.status, "completed", `final mobile status ${id}`);
    }
    assert.deepEqual(
      state.snapshot.timeline.filter((item) => item.threadId === threadId && item.kind === "assistant")
        .sort(compareTimelineOrder).map((item) => item.id),
      [...rawText.keys()],
      "mobile assistant count and display order must match the raw desktop stream",
    );
    const history = await client.openThread(threadId);
    for (const [id, expected] of rawText) {
      assert.equal(history.timeline.find((item) => item.id === id)?.content, expected, `history body ${id}`);
    }
    assert.ok(streamingSamples > beforeSamples, "must observe running mobile content");
    console.log(JSON.stringify({
      round: index + 1, ok: true, deltas: deltaCount - beforeDeltas,
      mobileStreamingSamples: streamingSamples - beforeSamples,
      assistantItems: rawText.size, assistantCharacters: [...rawText.values()].reduce((sum, text) => sum + text.length, 0),
    }));
  }
  let commandResult = "executed";
  if (rawCommands.size > 0) {
    assert.ok(state.snapshot.timeline.some((item) => item.kind === "command" && item.content.includes("RHZY_MOBILE_TOOL_OK")));
  } else {
    // Some App Server versions expose tools through exec. A sandbox rejection
    // produces no commandExecution event; report that coverage limit explicitly.
    const sessions = path.join(codexHome, "sessions");
    const rows = fs.readdirSync(sessions, { recursive: true })
      .filter((name) => String(name).endsWith(".jsonl"))
      .flatMap((name) => fs.readFileSync(path.join(sessions, String(name)), "utf8").split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { payload?: { type?: string; input?: string; output?: unknown } });
    const attempted = rows.some((row) => row.payload?.type === "custom_tool_call"
      && row.payload.input?.includes("RHZY_MOBILE_TOOL_OK"));
    const blocked = rows.some((row) => row.payload?.type === "custom_tool_call_output"
      && JSON.stringify(row.payload.output).includes("blocked by policy"));
    assert.ok(attempted && blocked, "tool round neither executed a command nor recorded a policy rejection");
    commandResult = "blocked_by_policy";
  }
  console.log(JSON.stringify({
    ok: true, threadId, rounds: prompts.length, codexHome, model, commandResult,
    coverage: "local HTTP/WebSocket and mobile state; not physical device/public relay",
  }));
} finally {
  connection?.dispose();
  await runtime.stop();
}
