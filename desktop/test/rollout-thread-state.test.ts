import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRolloutThreadState } from "../src/main/rollout-thread-state";

test("reads the latest token count and ignores failed model switches", (context) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-rollout-state-"));
  const sessions = path.join(codexHome, "sessions", "2026", "07", "22");
  fs.mkdirSync(sessions, { recursive: true });
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const threadId = "thread-state-1";
  const records = [
    { type: "turn_context", payload: { turn_id: "turn-ok", model: "provider-5/gpt-5.6-sol" } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 185_516 } } } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-ok" } },
    { type: "turn_context", payload: { turn_id: "turn-failed", model: "provider-2/grok-latest" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-failed", error: { message: "502" } } },
  ];
  fs.writeFileSync(
    path.join(sessions, `rollout-2026-07-22T00-00-00-${threadId}.jsonl`),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );

  assert.deepEqual(loadRolloutThreadState(codexHome, threadId), {
    currentTokens: 185_516,
    lastSuccessfulModel: "provider-5/gpt-5.6-sol",
  });
});

test("returns an empty state for an unknown thread", () => {
  assert.deepEqual(loadRolloutThreadState("missing-home", "missing-thread"), {
    currentTokens: null,
    lastSuccessfulModel: null,
  });
});
