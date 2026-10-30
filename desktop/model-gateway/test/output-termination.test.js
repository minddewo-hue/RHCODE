import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startEmbeddedGateway } from "../src/embedded.js";

test("HTTP gateway exposes incomplete and interrupted output with correlated diagnostic metadata", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-termination-"));
  fs.writeFileSync(path.join(root, "gateway.config.json"), JSON.stringify({
    providers: { local: { base_url: "http://127.0.0.1:1/v1", protocol: "chat_completions" } },
    models: { "local/qwen": { provider: "local", upstream_model: "qwen" } },
    log_level: "error",
  }));
  let finishReason = "length";
  const logs = [];
  const gateway = await startEmbeddedGateway({
    rootDir: root,
    onLog: (entry) => logs.push(entry),
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body || "{}");
      const chunk = { choices: [{ index: 0, delta: { content: "partial" }, finish_reason: finishReason }] };
      return request.stream
        ? new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json({ choices: [{ finish_reason: finishReason, message: { content: "partial" } }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
    },
  });
  context.after(async () => { await gateway.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const streaming of [true, false]) {
    const response = await fetch(`${gateway.baseUrl}/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local/qwen", input: "private prompt", stream: streaming,
        max_output_tokens: 50, client_metadata: { turn_id: "turn-observed" } }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    if (streaming) assert.match(text, /event: response.incomplete/);
    else assert.equal(JSON.parse(text).status, "incomplete");
    const result = logs.filter((entry) => entry.event === "chat_response_finished").at(-1);
    assert.equal(result.request_id, response.headers.get("x-request-id"));
    assert.equal(result.public_model, "local/qwen");
    assert.equal(result.turn_id, "turn-observed");
    assert.equal(result.finish_reason, "length");
    assert.equal(result.max_output_tokens, 50);
    assert.equal(result.output_text_chars, 7);
    assert.ok(!JSON.stringify(result).includes("private prompt"));
    const requestLog = logs.filter((entry) => entry.event === "request_completed").at(-1);
    assert.equal(requestLog.response_status, "incomplete");
  }
  finishReason = null;
  const broken = await fetch(`${gateway.baseUrl}/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "local/qwen", input: "text", stream: true }),
  });
  assert.match(await broken.text(), /event: response.failed/);
  assert.equal(logs.filter((entry) => entry.event === "chat_response_finished").at(-1).terminal_received, false);
});
