import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startEmbeddedGateway } from "../src/embedded.js";

test("embedded gateway uses an ephemeral loopback port", async (context) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-embedded-gateway-"));
  fs.writeFileSync(
    path.join(rootDir, "gateway.config.json"),
    JSON.stringify({
      providers: {
        local: {
          base_url: "http://127.0.0.1:65534/v1",
          protocol: "responses",
        },
      },
      models: {
        "local/test": {
          provider: "local",
          upstream_model: "test",
          runtime_instructions: "Run tools serially.",
        },
      },
    }),
  );

  const gateway = await startEmbeddedGateway({ rootDir, port: 0 });
  context.after(async () => {
    await gateway.stop();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  assert.ok(Number.isInteger(gateway.port));
  assert.ok(gateway.port > 0 && gateway.port <= 65_535);
  assert.equal(gateway.baseUrl, `http://127.0.0.1:${gateway.port}/v1`);
  assert.equal(gateway.models[0].runtimeInstructions, "Run tools serially.");
  const response = await fetch(`${gateway.baseUrl}/models`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map((model) => model.id), ["local/test"]);
});

test("actively probes provider health without exposing credentials", async (context) => {
  let requestedPath = "";
  const upstream = http.createServer((request, response) => {
    requestedPath = request.url || "";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-provider-probe-"));
  fs.writeFileSync(
    path.join(rootDir, "gateway.config.json"),
    JSON.stringify({
      providers: {
        healthy: {
          base_url: `http://127.0.0.1:${upstreamAddress.port}/v1`,
          protocol: "responses",
        },
        unavailable: {
          base_url: "http://127.0.0.1:65534/v1",
          protocol: "chat_completions",
        },
      },
      models: {
        "healthy/test": { provider: "healthy", upstream_model: "test" },
      },
    }),
  );

  const gateway = await startEmbeddedGateway({ rootDir, port: 0 });
  context.after(async () => {
    await gateway.stop();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const providers = await gateway.probeProviders({ timeoutMs: 500 });
  assert.equal(requestedPath, "/v1/models");
  assert.equal(providers.find((provider) => provider.id === "healthy")?.health.state, "healthy");
  assert.equal(providers.find((provider) => provider.id === "healthy")?.health.httpStatus, 200);
  assert.equal(providers.find((provider) => provider.id === "unavailable")?.health.state, "degraded");
  assert.doesNotMatch(JSON.stringify(providers), /authorization|apiKey/i);
});

test("discovers provider models at startup and makes them routable", async (context) => {
  const upstream = http.createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gemma-4-31b-it-uncensored-bf16" }] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-model-discovery-"));
  fs.writeFileSync(path.join(rootDir, "gateway.config.json"), JSON.stringify({
    providers: {
      relay: {
        base_url: `http://127.0.0.1:${address.port}/v1`,
        protocol: "chat_completions",
        model_discovery: {
          prefix: "relay/",
          rules: [{ pattern: "^gemma-", prefix: "vllm/", owned_by: "vllm" }],
        },
      },
    },
    models: { "relay/fallback": { provider: "relay", upstream_model: "fallback" } },
  }));
  const gateway = await startEmbeddedGateway({ rootDir, port: 0 });
  context.after(async () => {
    await gateway.stop();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  const response = await fetch(`${gateway.baseUrl}/models`);
  const ids = (await response.json()).data.map((model) => model.id);
  assert.ok(ids.includes("vllm/gemma-4-31b-it-uncensored-bf16"));
  assert.equal(gateway.models.find((model) => model.id.includes("31b"))?.upstreamModel, "gemma-4-31b-it-uncensored-bf16");
});

test("keeps disabled static and discovered models out of the catalog", async (context) => {
  const upstream = http.createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [
        { id: "allowed-dynamic" },
        { id: "blocked-dynamic" },
      ] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-disabled-models-"));
  fs.writeFileSync(path.join(rootDir, "gateway.config.json"), JSON.stringify({
    providers: {
      relay: {
        base_url: `http://127.0.0.1:${address.port}/v1`,
        protocol: "chat_completions",
        model_discovery: { prefix: "relay/" },
      },
    },
    disabled_models: {
      "relay/blocked-static": { reason: "failed validation" },
      "relay/blocked-dynamic": { reason: "failed validation" },
    },
    models: {
      "relay/allowed-static": { provider: "relay", upstream_model: "allowed-static" },
      "relay/blocked-static": { provider: "relay", upstream_model: "blocked-static" },
    },
  }));
  const gateway = await startEmbeddedGateway({ rootDir, port: 0 });
  context.after(async () => {
    await gateway.stop();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const response = await fetch(`${gateway.baseUrl}/models`);
  assert.deepEqual(
    (await response.json()).data.map((model) => model.id).sort(),
    ["relay/allowed-dynamic", "relay/allowed-static"],
  );
  assert.equal(gateway.modelCount, 2);
});
