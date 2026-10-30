import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ControlSnapshot, ThreadSummary } from "@rhzycode/protocol";
import { DesktopRuntime } from "../../desktop/src/main/runtime";
import { ControlStore, type RemoteCommandContext } from "../../desktop/src/main/control-plane/app";
import { buildChatEntries } from "../src/components/chat-screen-model";
import {
  applyAgentEvent,
  emptyControlSnapshot,
  hydrateThreadSnapshot,
  mergeControlSnapshot,
} from "../src/state/control-reducer";

test("keeps six identical consecutive questions and streamed answers paired in one conversation", async (context) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-continuous-mobile-"));
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const runtime = new DesktopRuntime(".", codexHome);
  const store = new ControlStore();
  const thread: ThreadSummary = {
    id: "one-continuous-thread", hostId: "local-desktop", title: "Continuous conversation",
    projectPath: ".", model: "test/model", status: "idle", updatedAt: new Date().toISOString(),
  };
  const internals = runtime as unknown as {
    controlPlane: { store: ControlStore };
    threads: Map<string, ThreadSummary>;
    loadedThreadIds: Set<string>;
    handleAgentMessage(message: unknown): void;
    handleSyncEvent(event: unknown): void;
  };
  internals.controlPlane = { store };
  internals.threads.set(thread.id, thread);
  internals.loadedThreadIds.add(thread.id);
  let mobile: ControlSnapshot = { ...emptyControlSnapshot, threads: [thread] };
  store.onEvent((event) => {
    internals.handleSyncEvent(event);
    mobile = applyAgentEvent(mobile, event);
  });
  const turns: Array<{ id: string; items: Array<Record<string, unknown>> }> = [];
  const requests: string[] = [];
  runtime.agent.request = async (method) => {
    requests.push(method);
    if (method === "turn/start") return { turn: { id: `turn-${turns.length}` } } as never;
    assert.ok(method === "thread/read" || method === "thread/resume");
    return { thread: { id: thread.id, cwd: ".", status: { type: "idle" }, turns }, model: thread.model } as never;
  };
  const remoteContext: RemoteCommandContext = {
    client: { id: "phone", name: "Phone", createdAt: thread.updatedAt, lastSeenAt: thread.updatedAt },
  };
  const body = () => buildChatEntries({
    selectedThreadId: thread.id, timeline: mobile.timeline,
    approvals: [], userInputs: [], pendingMessages: [],
  }, false).flatMap((entry) => entry.type === "timeline" ? [entry.item] : []);

  for (let round = 1; round <= 6; round += 1) {
    const turnId = `turn-${round}`;
    const answer = { id: "answer", type: "agentMessage", text: "" };
    turns.push({ id: turnId, items: [
      { id: "question", type: "userMessage", content: [{ type: "text", text: "continue" }] },
      answer,
    ] });
    await runtime.startTurn({ threadId: thread.id, text: "continue" });
    const emit = (method: string, params: Record<string, unknown>) => internals.handleAgentMessage({
      method, params: { threadId: thread.id, turnId, ...params },
    });
    emit("turn/started", { turn: { id: turnId } });
    emit("item/started", { item: { id: "reasoning", type: "reasoning" } });

    for (const chunk of ["Same", " streamed", " reply", " in every turn."]) {
      answer.text += chunk;
      emit("item/agentMessage/delta", { itemId: "answer", delta: chunk });
      const requestIndex = requests.length;
      const opened = await runtime.remoteCommandHandlers().openThread(thread.id, remoteContext);
      assert.ok(requests.slice(requestIndex).every((method) => method === "thread/read"));
      mobile = hydrateThreadSnapshot(mobile, opened);
      mobile = mergeControlSnapshot(mobile, store.snapshot());
      assert.equal(body().length, round * 2, `round ${round}: one question and one reply per turn`);
      assert.deepEqual(body().map((row) => row.kind), Array.from({ length: round }, () => ["user", "assistant"]).flat());
      assert.equal(body().at(-1)?.status, "running");
      assert.equal(body().at(-1)?.content, answer.text);
    }
    emit("item/completed", { item: answer });
    emit("turn/completed", { turn: { id: turnId, status: "completed" } });
    mobile = hydrateThreadSnapshot(mobile, await runtime.remoteCommandHandlers().openThread(thread.id, remoteContext));
    mobile = mergeControlSnapshot(mobile, store.snapshot());
    assert.deepEqual(body().map((row) => [row.kind, row.content, row.status]), Array.from({ length: round }, () => [
      ["user", "continue", "completed"],
      ["assistant", "Same streamed reply in every turn.", "completed"],
    ]).flat());
    const restored = new ControlStore(store.exportState());
    for (let previousRound = 1; previousRound <= round; previousRound += 1) {
      assert.ok(restored.clientMessageIdForTurn(`turn-${previousRound}`));
    }
  }
});
