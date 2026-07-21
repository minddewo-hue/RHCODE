import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startEmbeddedGateway } from "../src/embedded.js";

test("routes the Codex Responses format through Anthropic Messages", async (context) => {
  const environmentName = "RHZYCODE_ANTHROPIC_GATEWAY_TEST_KEY";
  const previousKey = process.env[environmentName];
  process.env[environmentName] = "anthropic-secret";
  let upstreamRequest;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    upstreamRequest = {
      path: request.url,
      authorization: request.headers.authorization,
      apiKey: request.headers["x-api-key"],
      version: request.headers["anthropic-version"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      id: "msg_upstream",
      type: "message",
      role: "assistant",
      model: "claude-upstream",
      content: [{
        type: "tool_use",
        id: "toolu_weather",
        name: "weather",
        input: { city: "Shanghai" },
      }],
      stop_reason: "tool_use",
      usage: { input_tokens: 9, output_tokens: 4 },
    }));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-anthropic-gateway-"));
  fs.writeFileSync(path.join(rootDir, "gateway.config.json"), JSON.stringify({
    providers: {
      anthropic: {
        base_url: `http://127.0.0.1:${address.port}/v1`,
        protocol: "anthropic_messages",
        api_key_env: environmentName,
      },
    },
    models: {
      "anthropic/claude": {
        provider: "anthropic",
        upstream_model: "claude-upstream",
        capabilities: { function_tools: true },
      },
    },
  }));
  const gateway = await startEmbeddedGateway({ rootDir, port: 0 });
  context.after(async () => {
    await gateway.stop();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
    if (previousKey == null) delete process.env[environmentName];
    else process.env[environmentName] = previousKey;
  });

  const response = await fetch(`${gateway.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/claude",
      instructions: "Use tools when needed.",
      input: "Weather?",
      tools: [{
        type: "function",
        name: "weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      }],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.output[0].type, "function_call");
  assert.equal(body.output[0].call_id, "toolu_weather");
  assert.equal(body.usage.total_tokens, 13);
  assert.equal(upstreamRequest.path, "/v1/messages");
  assert.equal(upstreamRequest.authorization, "Bearer anthropic-secret");
  assert.equal(upstreamRequest.apiKey, "anthropic-secret");
  assert.equal(upstreamRequest.version, "2023-06-01");
  assert.equal(upstreamRequest.body.system, "Use tools when needed.");
  assert.equal(upstreamRequest.body.model, "claude-upstream");
});
