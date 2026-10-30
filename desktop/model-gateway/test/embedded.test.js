import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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

test("logs the requested public model when a removed provider model is rejected", async (context) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-missing-model-"));
  fs.writeFileSync(path.join(rootDir, "gateway.config.json"), JSON.stringify({
    providers: { current: { base_url: "http://127.0.0.1:65534/v1", protocol: "responses" } },
    models: { "current/test": { provider: "current", upstream_model: "test" } },
  }));
  const events = [];
  let upstreamRequests = 0;
  const gateway = await startEmbeddedGateway({
    rootDir,
    onLog: (event) => events.push(event),
    fetchImpl: async () => { upstreamRequests += 1; throw new Error("Unexpected upstream request"); },
  });
  context.after(async () => {
    await gateway.stop();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const response = await fetch(`${gateway.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "removed/test", input: "hello" }),
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "model_not_found");
  assert.equal(upstreamRequests, 0);
  assert.equal(events.find((event) => event.event === "request_failed")?.public_model, "removed/test");
});

test("uses the injected fetch implementation for upstream requests", async (context) => {
  const upstream = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "response-1",
      object: "response",
      status: "completed",
      output: [],
    }));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-injected-fetch-"));
  fs.writeFileSync(path.join(rootDir, "gateway.config.json"), JSON.stringify({
    providers: {
      injected: {
        base_url: `http://127.0.0.1:${address.port}/v1`,
        protocol: "responses",
      },
    },
    models: {
      "injected/test": { provider: "injected", upstream_model: "test" },
    },
  }));
  const requestedUrls = [];
  const logEvents = [];
  const fetchImpl = (input, init) => {
    requestedUrls.push(String(input));
    return fetch(input, init);
  };
  const gateway = await startEmbeddedGateway({
    rootDir,
    port: 0,
    fetchImpl,
    onLog: (event) => logEvents.push(event),
  });
  context.after(async () => {
    await gateway.stop();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  await gateway.probeProviders();
  const response = await fetch(`${gateway.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "injected/test",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-observed" },
      }],
    }),
  });
  assert.equal(response.status, 200);
  assert.ok(requestedUrls.some((url) => url.endsWith("/v1/models")));
  assert.ok(requestedUrls.some((url) => url.endsWith("/v1/responses")));
  assert.equal(
    logEvents.find((event) => event.event === "request_completed")?.turn_id,
    "turn-observed",
  );
});

test("does not report a downstream stream cancellation as an upstream interruption", async (context) => {
  const upstream = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    for await (const _chunk of request) {
      // Consume the request before starting the response stream.
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_cancel","object":"response","status":"in_progress"}}\n\n',
    );
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-downstream-cancel-"));
  fs.writeFileSync(path.join(rootDir, "gateway.config.json"), JSON.stringify({
    providers: {
      local: {
        base_url: `http://127.0.0.1:${address.port}/v1`,
        protocol: "responses",
      },
    },
    models: {
      "local/test": { provider: "local", upstream_model: "test" },
    },
  }));
  const logEvents = [];
  const gateway = await startEmbeddedGateway({
    rootDir,
    port: 0,
    onLog: (event) => logEvents.push(event),
  });
  context.after(async () => {
    await gateway.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const response = await fetch(`${gateway.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "local/test",
      stream: true,
      input: "run a tool",
      client_metadata: { turn_id: "turn-client-cancel" },
    }),
  });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  await reader.cancel();

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (logEvents.some((event) => event.event === "downstream_disconnected")) break;
    await delay(10);
  }
  assert.equal(
    logEvents.some((event) => event.event === "downstream_disconnected"
      && event.turn_id === "turn-client-cancel"),
    true,
  );
  assert.equal(logEvents.some((event) => event.event === "stream_interrupted"), false);
});

test("reroutes image-model compaction through the thread's selected text model", async (context) => {
  let upstreamBody = null;
  const upstream = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "response-compaction",
      object: "response",
      status: "completed",
      output: [],
    }));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-compaction-reroute-"));
  fs.writeFileSync(path.join(rootDir, "gateway.config.json"), JSON.stringify({
    providers: {
      local: {
        base_url: `http://127.0.0.1:${address.port}/v1`,
        protocol: "responses",
      },
    },
    models: {
      "local/gpt-image-2": { provider: "local", upstream_model: "image-upstream" },
      "local/gpt-text": { provider: "local", upstream_model: "text-upstream" },
    },
  }));
  const logEvents = [];
  const gateway = await startEmbeddedGateway({
    rootDir,
    port: 0,
    onLog: (event) => logEvents.push(event),
  });
  context.after(async () => {
    await gateway.stop();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  assert.equal(gateway.setThreadModel("thread-switch", "local/gpt-text"), true);
  const response = await fetch(`${gateway.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "local/gpt-image-2",
      input: [{
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "You are performing a CONTEXT CHECKPOINT COMPACTION. Summarize the thread.",
        }],
      }],
      client_metadata: {
        thread_id: "thread-switch",
        turn_id: "turn-switch",
        "x-codex-turn-metadata": JSON.stringify({
          request_kind: "compaction",
          thread_id: "thread-switch",
          turn_id: "turn-switch",
        }),
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamBody?.model, "text-upstream");
  const rerouteEvent = logEvents.find((event) => event.event === "compaction_model_rerouted");
  assert.equal(rerouteEvent?.turn_id, "turn-switch");
  assert.equal(rerouteEvent?.thread_id, "thread-switch");
  assert.equal(rerouteEvent?.from_model, "local/gpt-image-2");
  assert.equal(rerouteEvent?.to_model, "local/gpt-text");
});

test("recovers removed-model compaction only with the same thread's selected text model", async (context) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-removed-compaction-"));
  fs.writeFileSync(path.join(rootDir, "gateway.config.json"), JSON.stringify({
    providers: { local: { base_url: "http://127.0.0.1:65534/v1", protocol: "responses" } },
    models: {
      "provider-5/gpt-6.1-sol": { provider: "local", upstream_model: "gpt-6.1-sol" },
      "local/older-text": { provider: "local", upstream_model: "older-text" },
      "local/gpt-image-2": { provider: "local", upstream_model: "gpt-image-2" },
    },
  }));
  const upstreamBodies = [];
  const events = [];
  const gateway = await startEmbeddedGateway({
    rootDir,
    onLog: (event) => events.push(event),
    fetchImpl: async (_url, init) => {
      upstreamBodies.push(JSON.parse(init.body));
      return Response.json({ id: "resp_compacted", object: "response", status: "completed", output: [] });
    },
  });
  context.after(async () => {
    await gateway.stop();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  gateway.setThreadModel("selected-thread", "provider-5/gpt-6.1-sol");
  gateway.setThreadModel("image-thread", "local/gpt-image-2");
  const compactionInput = [{
    type: "message", role: "user", content: [{
      type: "input_text", text: "You are performing a CONTEXT CHECKPOINT COMPACTION. Summarize the thread.",
    }],
  }];
  const removedModel = "provider-4/gpt-6.1-sol";
  const cases = [
    {
      name: "pre-turn compaction after a provider was removed",
      body: { model: removedModel, input: compactionInput, prompt_cache_key: "selected-thread" },
      status: 200, upstreamModel: "gpt-6.1-sol",
    },
    {
      name: "metadata-marked compaction without the standard prompt",
      body: { model: removedModel, input: "summarize", client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", thread_id: "selected-thread" }),
      } },
      status: 200, upstreamModel: "gpt-6.1-sol",
    },
    {
      name: "an available previous text model keeps its original route",
      body: { model: "local/older-text", input: compactionInput, prompt_cache_key: "selected-thread" },
      status: 200, upstreamModel: "older-text",
    },
    {
      name: "ordinary turns still reject removed model IDs",
      body: { model: removedModel, input: "continue", prompt_cache_key: "selected-thread" },
      status: 404,
    },
    {
      name: "a different thread cannot use another thread's selection",
      body: { model: removedModel, input: compactionInput, prompt_cache_key: "unselected-thread" },
      status: 404,
    },
    {
      name: "compaction without a thread ID cannot infer a provider",
      body: { model: removedModel, input: compactionInput },
      status: 404,
    },
    {
      name: "a selected image model cannot summarize text history",
      body: { model: removedModel, input: compactionInput, prompt_cache_key: "image-thread" },
      status: 404,
    },
  ];
  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const before = upstreamBodies.length;
      const response = await fetch(`${gateway.baseUrl}/responses`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(entry.body),
      });
      assert.equal(response.status, entry.status);
      await response.json();
      assert.equal(upstreamBodies.length - before, entry.upstreamModel ? 1 : 0);
      if (entry.upstreamModel) assert.equal(upstreamBodies.at(-1).model, entry.upstreamModel);
    });
  }
  const recovered = events.filter((event) => event.event === "compaction_model_rerouted");
  assert.equal(recovered.length, 2);
  assert.ok(recovered.every((event) => event.from_model === removedModel
    && event.to_model === "provider-5/gpt-6.1-sol" && event.thread_id === "selected-thread"));
});

test("interrupts the active upstream stream for a matching turn", async (context) => {
  let upstreamClosedResolve;
  const upstreamClosed = new Promise((resolve) => {
    upstreamClosedResolve = resolve;
  });
  const upstream = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    for await (const _chunk of request) {
      // Consume the request before opening the stream.
    }
    response.once("close", () => upstreamClosedResolve());
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"response-interrupt","object":"response"}}\n\n',
    );
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-turn-interrupt-"));
  fs.writeFileSync(path.join(rootDir, "gateway.config.json"), JSON.stringify({
    providers: {
      local: {
        base_url: `http://127.0.0.1:${address.port}/v1`,
        protocol: "responses",
      },
    },
    models: {
      "local/test": {
        provider: "local",
        upstream_model: "test",
        capabilities: { streaming: true },
      },
    },
    upstream_timeout_ms: 5000,
    upstream_stream_idle_timeout_ms: 5000,
  }));
  const gateway = await startEmbeddedGateway({ rootDir, port: 0 });
  context.after(async () => {
    await gateway.stop();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const response = await fetch(`${gateway.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "local/test",
      stream: true,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "wait" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-interrupt" },
      }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(gateway.interruptTurn("turn-interrupt"), 1);
  await assert.rejects(response.text());
  await Promise.race([
    upstreamClosed,
    delay(1000).then(() => assert.fail("upstream connection was not closed")),
  ]);
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

test("loads a provider key from the desktop env path for the configured upstream URL", async (context) => {
  const environmentName = "RHZYCODE_DESKTOP_ENV_TEST_KEY";
  const previousValue = process.env[environmentName];
  delete process.env[environmentName];
  let usedConfiguredKey = false;
  let gateway;
  const desktopRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-desktop-env-"));
  const upstream = http.createServer((request, response) => {
    usedConfiguredKey = request.headers.authorization === "Bearer desktop-env-test-key";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
  });
  context.after(async () => {
    await gateway?.stop();
    if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(desktopRoot, { recursive: true, force: true });
    if (previousValue === undefined) delete process.env[environmentName];
    else process.env[environmentName] = previousValue;
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");

  const gatewayRoot = path.join(desktopRoot, "model-gateway");
  fs.mkdirSync(gatewayRoot);
  fs.writeFileSync(path.join(desktopRoot, ".env"), `${environmentName}=desktop-env-test-key\n`);
  fs.writeFileSync(path.join(gatewayRoot, "gateway.config.json"), JSON.stringify({
    providers: {
      configured: {
        base_url: `http://127.0.0.1:${upstreamAddress.port}/v1`,
        protocol: "responses",
        api_key_env: environmentName,
      },
    },
    models: {
      "configured/test": { provider: "configured", upstream_model: "test" },
    },
  }));

  gateway = await startEmbeddedGateway({
    rootDir: gatewayRoot,
    envPath: path.join(desktopRoot, ".env"),
    port: 0,
  });

  await gateway.probeProviders({ timeoutMs: 500 });
  assert.equal(usedConfiguredKey, true);
});

test("loads models from any provider with a configured credential", async (context) => {
  const firstKey = "RHZYCODE_OPTIONAL_PROVIDER_FIRST_KEY";
  const secondKey = "RHZYCODE_OPTIONAL_PROVIDER_SECOND_KEY";
  const previousFirst = process.env[firstKey];
  const previousSecond = process.env[secondKey];
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-optional-providers-"));
  fs.writeFileSync(path.join(rootDir, "gateway.config.json"), JSON.stringify({
    providers: {
      first: {
        base_url: "http://127.0.0.1:65534/v1",
        protocol: "responses",
        api_key_env: firstKey,
      },
      second: {
        base_url: "http://127.0.0.1:65533/v1",
        protocol: "chat_completions",
        api_key_env: secondKey,
      },
    },
    models: {
      "first/model": { provider: "first", upstream_model: "first-model" },
      "second/model": { provider: "second", upstream_model: "second-model" },
      "shared/model": {
        provider: "first",
        upstream_model: "shared-first",
        fallbacks: [{ provider: "second", upstream_model: "shared-second" }],
      },
    },
  }));

  context.after(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    if (previousFirst === undefined) delete process.env[firstKey];
    else process.env[firstKey] = previousFirst;
    if (previousSecond === undefined) delete process.env[secondKey];
    else process.env[secondKey] = previousSecond;
  });

  const cases = [
    {
      first: "first-key",
      second: undefined,
      providers: ["first"],
      models: ["first/model", "shared/model"],
    },
    {
      first: undefined,
      second: "second-key",
      providers: ["second"],
      models: ["second/model", "shared/model"],
    },
    {
      first: "first-key",
      second: "second-key",
      providers: ["first", "second"],
      models: ["first/model", "second/model", "shared/model"],
    },
  ];

  for (const testCase of cases) {
    if (testCase.first === undefined) delete process.env[firstKey];
    else process.env[firstKey] = testCase.first;
    if (testCase.second === undefined) delete process.env[secondKey];
    else process.env[secondKey] = testCase.second;

    const gateway = await startEmbeddedGateway({ rootDir, port: 0 });
    try {
      assert.equal(gateway.providerCount, testCase.providers.length);
      assert.deepEqual(
        [...new Set(gateway.models.map((model) => model.providerId))],
        testCase.providers,
      );
      assert.deepEqual(gateway.models.map((model) => model.id), testCase.models);
    } finally {
      await gateway.stop();
    }
  }

  delete process.env[firstKey];
  delete process.env[secondKey];
  await assert.rejects(
    startEmbeddedGateway({ rootDir, port: 0 }),
    /Configure at least one provider credential/,
  );
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

test("refreshes models added upstream after gateway startup", async (context) => {
  let modelIds = ["initial-model"];
  const upstream = http.createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: modelIds.map((id) => ({ id })) }));
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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-model-refresh-"));
  fs.writeFileSync(path.join(rootDir, "gateway.config.json"), JSON.stringify({
    providers: {
      relay: {
        base_url: `http://127.0.0.1:${address.port}/v1`,
        protocol: "responses",
        model_discovery: { prefix: "relay/" },
      },
    },
  }));
  const gateway = await startEmbeddedGateway({ rootDir, port: 0 });
  context.after(async () => {
    await gateway.stop();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  assert.deepEqual(gateway.models.map((model) => model.id), ["relay/initial-model"]);
  modelIds.push("qwen3.8-27b-uncensored-fp8");
  const refreshed = await gateway.refreshModels();
  assert.equal(refreshed.changed, true);
  assert.ok(refreshed.models.some((model) => model.id === "relay/qwen3.8-27b-uncensored-fp8"));
  assert.ok(gateway.models.some((model) => model.id === "relay/qwen3.8-27b-uncensored-fp8"));
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
