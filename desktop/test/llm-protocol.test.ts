import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { detectLlmProtocol, normalizeLlmBaseUrl } from "../src/main/llm-protocol.js";

test("normalizes full OpenAI and Anthropic endpoint URLs", () => {
  assert.deepEqual(normalizeLlmBaseUrl("https://api.example.com/v1/chat/completions"), {
    baseUrl: "https://api.example.com/v1",
    hintedProtocol: "chat_completions",
  });
  assert.deepEqual(normalizeLlmBaseUrl("https://api.example.com/v1/messages/"), {
    baseUrl: "https://api.example.com/v1",
    hintedProtocol: "anthropic_messages",
  });
});

test("auto-detects Chat Completions without sending a real model request", async (context) => {
  const paths: string[] = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url || "");
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/responses") {
      response.writeHead(401).end(JSON.stringify({ error: { message: "Invalid API key" } }));
    } else if (request.url === "/v1/chat/completions") {
      response.writeHead(400).end(JSON.stringify({ error: { message: "Unknown probe model" } }));
    } else {
      response.writeHead(404).end(JSON.stringify({ error: { message: "Route not found" } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const detected = await detectLlmProtocol({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "test-key",
    protocol: "auto",
  });
  assert.equal(detected.protocol, "chat_completions");
  assert.ok(paths.includes("/v1/responses"));
  assert.ok(paths.includes("/v1/chat/completions"));
  assert.ok(paths.includes("/v1/messages"));
});

test("does not save a protocol when every endpoint rejects the API key", async () => {
  await assert.rejects(
    detectLlmProtocol(
      {
        baseUrl: "https://api.example.com/v1",
        apiKey: "invalid-key",
        protocol: "auto",
      },
      (async () => new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    ),
    /Could not detect a supported LLM protocol/,
  );
});

test("uses an explicitly selected protocol without probing the network", async () => {
  let calls = 0;
  const detected = await detectLlmProtocol(
    {
      baseUrl: "https://api.example.com/v1/messages",
      apiKey: "test-key",
      protocol: "anthropic_messages",
    },
    (async () => {
      calls += 1;
      throw new Error("not expected");
    }) as typeof fetch,
  );
  assert.equal(calls, 0);
  assert.deepEqual(detected, {
    baseUrl: "https://api.example.com/v1",
    protocol: "anthropic_messages",
    endpoint: "https://api.example.com/v1/messages",
  });
});
