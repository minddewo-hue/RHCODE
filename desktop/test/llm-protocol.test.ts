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

test("ignores an HTML website route and detects the API under /v1", async (context) => {
  const paths: string[] = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url || "");
    if (request.url === "/chat/completions") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.writeHead(200).end("<!doctype html><title>Website</title>");
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/chat/completions") {
      response.writeHead(400).end(JSON.stringify({ error: { message: "Unknown probe model" } }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: { message: "Route not found" } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const detected = await detectLlmProtocol({
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: "test-key",
    protocol: "auto",
  });
  assert.deepEqual(detected, {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    protocol: "chat_completions",
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
  });
  assert.ok(paths.includes("/chat/completions"));
  assert.ok(paths.includes("/v1/chat/completions"));
});

test("probes /v1 when a protocol is selected for an origin URL", async () => {
  const calls: string[] = [];
  const detected = await detectLlmProtocol(
    {
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      protocol: "chat_completions",
    },
    (async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://api.example.com/v1/chat/completions") {
        return new Response(JSON.stringify({ error: { message: "Unknown probe model" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("<!doctype html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch,
  );
  assert.deepEqual(detected, {
    baseUrl: "https://api.example.com/v1",
    protocol: "chat_completions",
    endpoint: "https://api.example.com/v1/chat/completions",
  });
  assert.deepEqual(calls, [
    "https://api.example.com/chat/completions",
    "https://api.example.com/v1/chat/completions",
  ]);
});

test("keeps a manually selected protocol when the URL hints at another one", async () => {
  const calls: string[] = [];
  const detected = await detectLlmProtocol(
    {
      baseUrl: "https://api.example.com/v1/responses",
      apiKey: "test-key",
      protocol: "chat_completions",
    },
    (async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ error: { message: "Unknown probe model" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  );
  assert.deepEqual(detected, {
    baseUrl: "https://api.example.com/v1",
    protocol: "chat_completions",
    endpoint: "https://api.example.com/v1/chat/completions",
  });
  assert.deepEqual(calls, ["https://api.example.com/v1/chat/completions"]);
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

test("uses an explicitly selected full endpoint without probing the network", async () => {
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
