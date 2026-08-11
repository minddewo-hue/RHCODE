import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadGatewayConfig } from "../src/config.js";
import { startEmbeddedGateway } from "../src/embedded.js";

test("allows models from one provider to use different protocols", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-model-protocol-config-"));
  const configPath = path.join(root, "gateway.config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    providers: {
      mixed: { base_url: "https://models.example/v1", protocol: "responses" },
    },
    models: {
      "mixed/native": { provider: "mixed", upstream_model: "native" },
      "mixed/chat": {
        provider: "mixed",
        upstream_model: "chat",
        protocol: "chat_completions",
      },
    },
  }));

  try {
    const config = loadGatewayConfig({ configPath });
    const nativeRoute = config.models.get("mixed/native").routes[0];
    const chatRoute = config.models.get("mixed/chat").routes[0];
    assert.equal(nativeRoute.protocol, "responses");
    assert.equal(nativeRoute.path, "/responses");
    assert.equal(chatRoute.protocol, "chat_completions");
    assert.equal(chatRoute.path, "/chat/completions");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retries transient pre-output failures once for Chat Completions models by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-chat-retry-config-"));
  const configPath = path.join(root, "gateway.config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    providers: {
      chat: { base_url: "https://models.example/v1", protocol: "chat_completions" },
    },
    models: {
      "chat/default": { provider: "chat", upstream_model: "default" },
      "chat/no-retry": { provider: "chat", upstream_model: "no-retry", pre_output_retries: 0 },
    },
  }));

  try {
    const config = loadGatewayConfig({ configPath });
    assert.equal(config.models.get("chat/default").preOutputRetries, 1);
    assert.equal(config.models.get("chat/no-retry").preOutputRetries, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selects protocol separately for every discovered provider model", async (context) => {
  const routeCalls = [];
  const upstream = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      writeJson(response, 200, {
        data: [
          { id: "native-model" },
          { id: "chat-model", context_length: 65_536 },
        ],
      });
      return;
    }
    const body = await readJson(request);
    routeCalls.push({ path: request.url, model: body.model });
    if (request.url === "/v1/responses" && body.model === "native-model") {
      writeJson(response, 200, {
        id: "resp_native",
        object: "response",
        status: "completed",
        model: body.model,
        output: [],
      });
      return;
    }
    if (request.url === "/v1/chat/completions" && body.model === "chat-model") {
      writeJson(response, 200, { choices: [{ message: { role: "assistant", content: "OK" } }] });
      return;
    }
    writeJson(response, 400, {
      error: { code: "request_not_supported_by_route", message: "route does not support model" },
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-model-protocol-detect-"));
  fs.writeFileSync(path.join(root, "gateway.config.json"), JSON.stringify({
    providers: {
      mixed: {
        base_url: `http://127.0.0.1:${address.port}/v1`,
        protocol: "chat_completions",
        model_discovery: { prefix: "mixed/", detect_protocol: true },
      },
    },
    models: {},
  }));

  const gateway = await startEmbeddedGateway({ rootDir: root, port: 0, discoveryTimeoutMs: 500 });
  context.after(async () => {
    await gateway.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const nativeResponse = await fetch(`${gateway.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mixed/native-model", input: "hello" }),
  });
  const chatResponse = await fetch(`${gateway.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mixed/chat-model", input: "hello" }),
  });

  assert.equal(nativeResponse.status, 200);
  assert.equal(chatResponse.status, 200);
  assert.equal(gateway.models.find((model) => model.id === "mixed/chat-model")?.contextWindow, 65_536);
  assert.deepEqual(routeCalls.filter((call) => call.model === "native-model").map((call) => call.path), [
    "/v1/chat/completions",
    "/v1/responses",
  ]);
  assert.deepEqual(routeCalls.filter((call) => call.model === "chat-model").map((call) => call.path), [
    "/v1/chat/completions",
  ]);
});

test("falls back across protocols for models from a custom provider", async (context) => {
  const routeCalls = [];
  const upstream = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      writeJson(response, 200, { data: [{ id: "gemma-local" }] });
      return;
    }
    const body = await readJson(request);
    routeCalls.push({ path: request.url, model: body.model });
    if (request.url === "/v1/chat/completions") {
      writeJson(response, 200, { choices: [{ message: { role: "assistant", content: "OK" } }] });
      return;
    }
    writeJson(response, 503, { error: { message: "temporarily unavailable" } });
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-custom-protocol-fallback-"));
  fs.writeFileSync(path.join(root, "gateway.config.json"), JSON.stringify({
    providers: {
      custom: {
        base_url: `http://127.0.0.1:${address.port}/v1`,
        protocol: "responses",
        model_discovery: { prefix: "custom/", detect_protocol: true },
      },
    },
    models: { "custom/gemma-local": { provider: "custom", upstream_model: "gemma-local" } },
  }));

  const gateway = await startEmbeddedGateway({ rootDir: root, port: 0 });
  context.after(async () => {
    await gateway.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const response = await fetch(`${gateway.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "custom/gemma-local", input: "hello" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(routeCalls.map((call) => call.path), [
    "/v1/responses",
    "/v1/chat/completions",
  ]);
});

test("falls back to an equivalent discovered model from another provider", async (context) => {
  const first = await startProtocolUpstream((request, body, response) => {
    if (request.url === "/v1/models") return writeJson(response, 200, { data: [{ id: "gpt-5.6-luna" }] });
    writeJson(response, 503, { error: { message: "temporarily unavailable" } });
  });
  const second = await startProtocolUpstream((request, body, response) => {
    if (request.url === "/v1/models") return writeJson(response, 200, { data: [{ id: "gpt-5.6-luna" }] });
    if (request.url === "/v1/responses") {
      return writeJson(response, 200, { id: "resp_luna", object: "response", status: "completed", output: [] });
    }
    writeJson(response, 404, { error: { message: "not found" } });
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-provider-fallback-"));
  fs.writeFileSync(path.join(root, "gateway.config.json"), JSON.stringify({
    providers: {
      first: { base_url: `${first.baseUrl}/v1`, protocol: "chat_completions", model_discovery: { prefix: "first/", detect_protocol: true } },
      second: { base_url: `${second.baseUrl}/v1`, protocol: "responses", model_discovery: { prefix: "second/", detect_protocol: true } },
    },
    models: {},
  }));
  const gateway = await startEmbeddedGateway({ rootDir: root, port: 0 });
  context.after(async () => {
    await gateway.stop();
    await first.stop();
    await second.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const response = await fetch(`${gateway.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "first/gpt-5.6-luna", input: "hello" }),
  });

  assert.equal(response.status, 200);
  assert.ok(first.calls.some((call) => call.path === "/v1/chat/completions"));
  assert.ok(second.calls.some((call) => call.path === "/v1/responses"));
});

async function startProtocolUpstream(handle) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const body = request.url === "/v1/models" ? null : await readJson(request);
    calls.push({ path: request.url, model: body?.model });
    handle(request, body, response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
