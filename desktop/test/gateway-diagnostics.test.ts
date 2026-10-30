import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GatewayDiagnostics } from "../src/main/gateway-diagnostics";

test("persists only outcome metadata and rotates the bounded diagnostic log", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rhzycode-outcomes-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const log = new GatewayDiagnostics(directory);
  log.record({ time: "now", level: "debug", event: "chat_request", request: { api_key: "private" } });
  log.record({
    time: "now", level: "info", event: "chat_response_finished", turn_id: "turn-1",
    finish_reason: "length", response_status: "incomplete", terminal_received: true,
    max_output_tokens: 8192, output_text_chars: 20, reasoning_text_chars: 42, tool_call_count: 0,
    request: { api_key: "private" }, content: "private prompt", message: "private error",
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, private: "private" },
  });
  await log.flush();
  const file = path.join(directory, "gateway-outcomes.jsonl");
  const text = await fs.readFile(file, "utf8");
  assert.equal(text.trim().split("\n").length, 1);
  assert.ok(!text.includes("private"));
  const entry = JSON.parse(text);
  assert.equal(entry.finish_reason, "length");
  assert.equal(entry.max_output_tokens, 8192);
  assert.equal(entry.reasoning_text_chars, 42);
  assert.deepEqual(entry.usage, { input_tokens: 100, output_tokens: 20, total_tokens: 120 });
  await fs.writeFile(file, "x".repeat(2 * 1024 * 1024));
  log.record({ time: "now", level: "info", event: "chat_response_finished", finish_reason: "stop" });
  await log.flush();
  assert.equal((await fs.stat(`${file}.1`)).size, 2 * 1024 * 1024);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).finish_reason, "stop");
});

test("diagnostic write failures do not fail tasks", async () => {
  const log = new GatewayDiagnostics("\0invalid");
  log.record({ time: "now", level: "info", event: "chat_response_finished" });
  await log.flush();
});
