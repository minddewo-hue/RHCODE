import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startEmbeddedGateway } from "../src/embedded.js";
import {
  applyGemma31bChatRequestPolicy,
  isGemma31bBf16Model,
} from "../src/gemma-31b-policy.js";

const upstreamModel = "gemma-4-31b-it-uncensored-bf16";

test("matches only the targeted Gemma 31B BF16 model", () => {
  assert.equal(isGemma31bBf16Model(upstreamModel), true);
  assert.equal(isGemma31bBf16Model(`provider-2/${upstreamModel}`), true);
  assert.equal(isGemma31bBf16Model("gemma-4-31b-it-uncensored"), false);
  assert.equal(isGemma31bBf16Model("gemma-4-31b-it-uncensored-bf16-fast"), false);
});

test("removes an orphaned tool choice only for the targeted model", () => {
  const request = {
    model: upstreamModel,
    messages: [{ role: "user", content: "hello" }],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  assert.deepEqual(applyGemma31bChatRequestPolicy(request, upstreamModel), {
    model: upstreamModel,
    messages: request.messages,
  });
  assert.equal(applyGemma31bChatRequestPolicy(request, "another-model"), request);

  const withTools = { ...request, tools: [{ type: "function", function: { name: "run" } }] };
  assert.equal(applyGemma31bChatRequestPolicy(withTools, upstreamModel), withTools);
});

test("keeps the isolated Gemma request policy in the embedded gateway", async (context) => {
  let receivedBody = null;
  const upstream = http.createServer(async (request, response) => {
    receivedBody = await readJson(request);
    writeJson(response, 200, {
      choices: [{ message: { role: "assistant", content: "OK" } }],
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-gemma-policy-"));
  fs.copyFileSync(
    path.resolve("desktop", "model-context-windows.json"),
    path.join(root, "model-context-windows.json"),
  );
  fs.writeFileSync(path.join(root, "gateway.config.json"), JSON.stringify({
    providers: {
      "provider-2": {
        base_url: `http://127.0.0.1:${address.port}/v1`,
        protocol: "chat_completions",
      },
    },
    models: {
      [`provider-2/${upstreamModel}`]: {
        provider: "provider-2",
        upstream_model: upstreamModel,
      },
    },
  }));

  const gateway = await startEmbeddedGateway({ rootDir: root, port: 0 });
  context.after(async () => {
    await gateway.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(gateway.models[0].contextWindow, 131_072);
  const response = await fetch(`${gateway.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: `provider-2/${upstreamModel}`,
      input: "Reply OK.",
      tools: [{ type: "namespace", name: "tools" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(receivedBody.model, upstreamModel);
  assert.equal(receivedBody.tool_choice, undefined);
  assert.equal(receivedBody.parallel_tool_calls, undefined);
  assert.equal(receivedBody.tools, undefined);
});

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
