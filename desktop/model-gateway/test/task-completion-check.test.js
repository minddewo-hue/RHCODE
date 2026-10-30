import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startEmbeddedGateway } from "../src/embedded.js";

async function fixture(context, reviewer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-task-check-"));
  const model = "qwen3.8-27b-uncensored-fp8";
  fs.writeFileSync(path.join(root, "gateway.config.json"), JSON.stringify({
    providers: { local: { base_url: "http://127.0.0.1:1/v1", protocol: "chat_completions" } },
    models: { [`local/${model}`]: { provider: "local", upstream_model: model } }, log_level: "error",
  }));
  const logs = [];
  const gateway = await startEmbeddedGateway({ rootDir: root, onLog: (entry) => logs.push(entry),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (!body.stream) return reviewer(body, options.signal);
      assert.equal(body.chat_template_kwargs.enable_thinking, false);
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Now I will write tests." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    },
  });
  context.after(async () => { await gateway.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const response = await fetch(`${gateway.baseUrl}/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      model: `local/${model}`, input: "Implement modules and tests.", stream: true,
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      client_metadata: { turn_id: "turn-check" },
    }),
  });
  await response.text();
  return { gateway, logs };
}

test("reviews completion using the same model without tools and consumes the turn context", async (context) => {
  let calls = 0;
  const { gateway, logs } = await fixture(context, async (body) => {
    calls++;
    assert.equal(body.model, "qwen3.8-27b-uncensored-fp8");
    assert.ok(!body.tools);
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.ok(body.messages[1].content.includes("Now I will write tests."));
    return Response.json({ choices: [{ message: { content: '{"status":"continue","next_step":"Write the missing tests."}' } }] });
  });
  assert.equal(gateway.canCheckTurnCompletion("turn-check"), true);
  assert.deepEqual(await gateway.checkTurnCompletion("turn-check"), { status: "continue", nextStep: "Write the missing tests." });
  assert.equal(gateway.canCheckTurnCompletion("turn-check"), false);
  assert.deepEqual(await gateway.checkTurnCompletion("turn-check"), { status: "unknown" });
  assert.equal(calls, 1);
  assert.equal(logs.find((entry) => entry.event === "task_completion_checked")?.verdict, "continue");
});

test("interrupting a turn also cancels its completion review", async (context) => {
  const { gateway } = await fixture(context, (_body, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
  }));
  const review = gateway.checkTurnCompletion("turn-check");
  assert.equal(gateway.interruptTurn("turn-check"), 1);
  assert.deepEqual(await review, { status: "unknown" });
});
