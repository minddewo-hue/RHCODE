import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("multi-model gateway integration", async (t) => {
  const calls = [];
  const mockState = {
    stickyFails: false,
    emptyStreamCalls: 0,
    bufferedStreamCalls: 0,
    bufferedTimeoutCalls: 0,
    bufferedPowerShellCalls: 0,
    bufferedListenerCalls: 0,
    bufferedBoundedCalls: 0,
    bufferedRepeatCalls: 0,
    bufferedCrossRequestCalls: 0,
    bufferedStubbornCalls: 0,
  };
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    calls.push({ path: req.url, body, authorization: req.headers.authorization });

    if (req.url === "/primary/v1/responses") {
      const errorStatus = /^error-(401|403|404|429|500)$/.exec(body.input)?.[1];
      if (errorStatus) {
        const status = Number(errorStatus);
        writeJson(res, status, {
          error: {
            message:
              status === 401 ? "bad upstream token token=secret-value" : `mock HTTP ${status}`,
          },
        });
        return;
      }
      if (body.model === "sticky-upstream" && mockState.stickyFails) {
        writeJson(res, 503, { error: { message: "primary unavailable" } });
        return;
      }
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_native_stream", object: "response", model: body.model } })}\n\n`,
        );
        res.end(
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_native_stream", object: "response", model: body.model, status: "completed", marker: "preserved" } })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      writeJson(res, 200, {
        id: body.model === "sticky-upstream" ? "resp_sticky" : "resp_native",
        object: "response",
        status: "completed",
        model: body.model,
        output: [{ type: "message", content: [{ type: "output_text", text: "native ok" }] }],
      });
      return;
    }

    if (req.url === "/failing/v1/responses") {
      writeJson(res, 503, { error: { message: "try the replica" } });
      return;
    }

    if (req.url === "/backup/v1/responses") {
      writeJson(res, 200, {
        id: "resp_backup",
        object: "response",
        status: "completed",
        model: body.model,
        output: [],
      });
      return;
    }

    if (req.url === "/slow/v1/responses") {
      await delay(200);
      if (!res.writableEnded) {
        writeJson(res, 200, { id: "resp_too_slow", object: "response", status: "completed" });
      }
      return;
    }

    if (req.url === "/broken/v1/responses") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_broken","object":"response"}}\n\n',
      );
      setTimeout(() => res.destroy(), 20);
      return;
    }

    if (req.url === "/chat/v1/chat/completions") {
      const toolName = body.tools?.[0]?.function?.name || "weather";
      const toolArguments = toolName === "apply_patch"
        ? JSON.stringify({ patch: "*** Begin Patch\n*** End Patch" })
        : '{"city":"Shanghai"}';
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (body.model === "buffered-upstream") {
          mockState.bufferedStreamCalls += 1;
          if (mockState.bufferedStreamCalls === 1) {
            res.end(
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_truncated", type: "function", function: { name: "weather", arguments: '{"city":' } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
            );
            return;
          }
          if (mockState.bufferedStreamCalls === 2) {
            res.end(
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
                { index: 0, id: "call_one", type: "function", function: { name: "weather", arguments: '{"city":"one"}' } },
                { index: 1, id: "call_two", type: "function", function: { name: "weather", arguments: '{"city":"two"}' } },
              ] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
            );
            return;
          }
        }
        if (body.model === "buffered-timeout-upstream") {
          mockState.bufferedTimeoutCalls += 1;
          if (mockState.bufferedTimeoutCalls === 1) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" } }] })}\n\n`);
            await delay(100);
            if (!res.writableEnded) res.end("data: [DONE]\n\n");
            return;
          }
        }
        if (body.model === "buffered-powershell-upstream") {
          mockState.bufferedPowerShellCalls += 1;
          const command = mockState.bufferedPowerShellCalls === 1
            ? "Get-Content file.txt -C 1,2"
            : "Get-Content file.txt | Select-Object -First 2";
          res.end(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_powershell", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
          );
          return;
        }
        if (body.model === "buffered-listener-upstream") {
          mockState.bufferedListenerCalls += 1;
          let command = "Start-Process python -ArgumentList 'worker.py','--listen' -RedirectStandardOutput listener.log -RedirectStandardError listener.err";
          if (mockState.bufferedListenerCalls === 1) {
            command = "python worker.py --listen > listener.log 2>&1";
          }
          if (mockState.bufferedListenerCalls === 2) {
            command = "Start-Process python -ArgumentList 'worker.py','--listen'; Start-Sleep -Seconds 5; Get-Content listener.log";
          }
          res.end(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_listener", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
          );
          return;
        }
        if (body.model === "buffered-bounded-upstream") {
          mockState.bufferedBoundedCalls += 1;
          let command = "rg --files src | Select-Object -First 20";
          if (mockState.bufferedBoundedCalls === 1) command = "Get-ChildItem . -Recurse -Filter *.js";
          if (mockState.bufferedBoundedCalls === 2) {
            command = `@'\n${Array.from({ length: 12 }, (_, index) => `print(${index})`).join("\n")}\n'@ | python`;
          }
          res.end(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_bounded", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
          );
          return;
        }
        if (body.model === "buffered-repeat-upstream") {
          mockState.bufferedRepeatCalls += 1;
          const command = mockState.bufferedRepeatCalls === 1
            ? "Get-Item missing.txt"
            : "Test-Path missing.txt";
          res.end(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_repeat", type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
          );
          return;
        }
        if (body.model === "buffered-cross-request-upstream") {
          mockState.bufferedCrossRequestCalls += 1;
          const callNumber = mockState.bufferedCrossRequestCalls;
          const command = callNumber <= 3
            ? "Get-Item cross-request-missing.txt"
            : "Test-Path cross-request-missing.txt";
          res.end(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_cross_${callNumber}`, type: "function", function: { name: "shell_command", arguments: JSON.stringify({ command }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
          );
          return;
        }
        if (body.model === "buffered-stubborn-upstream") {
          mockState.bufferedStubbornCalls += 1;
          res.end(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_stubborn", type: "function", function: { name: "shell_command", arguments: '{"command":"Get-Item stubborn-missing.txt"}' } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
          );
          return;
        }
        if (body.model === "empty-retry-upstream") {
          mockState.emptyStreamCalls += 1;
          if (mockState.emptyStreamCalls <= 2) {
            res.end(
              `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            );
            return;
          }
        }
        if (body.tools) {
          const split = Math.ceil(toolArguments.length / 2);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_stream_tool", type: "function", function: { name: toolName, arguments: toolArguments.slice(0, split) } }] } }] })}\n\n`);
          res.end(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: toolArguments.slice(split) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
          );
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}\n\n`);
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      writeJson(res, 200, {
        id: "chat_1",
        object: "chat.completion",
        created: 123,
        model: body.model,
        choices: [
          {
            message: body.tools
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_weather",
                      type: "function",
                      function: { name: toolName, arguments: toolArguments },
                    },
                  ],
                }
              : { role: "assistant", content: "chat ok" },
            finish_reason: body.tools ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      });
      return;
    }

    writeJson(res, 404, { error: { message: "mock route not found" } });
  });

  const upstreamPort = await listen(upstream);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-test-"));
  const configPath = path.join(tempDir, "gateway.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      providers: {
        primary: {
          base_url: `http://127.0.0.1:${upstreamPort}/primary/v1`,
          protocol: "responses",
          api_key_env: "TEST_UPSTREAM_KEY",
        },
        failing: {
          base_url: `http://127.0.0.1:${upstreamPort}/failing/v1`,
          protocol: "responses",
        },
        backup: {
          base_url: `http://127.0.0.1:${upstreamPort}/backup/v1`,
          protocol: "responses",
        },
        chat: {
          base_url: `http://127.0.0.1:${upstreamPort}/chat/v1`,
          protocol: "chat_completions",
        },
        chat_bridge: {
          base_url: `http://127.0.0.1:${upstreamPort}/chat/v1`,
          protocol: "chat_completions",
          custom_tool_bridges: ["apply_patch"],
        },
        chat_retry: {
          base_url: `http://127.0.0.1:${upstreamPort}/chat/v1`,
          protocol: "chat_completions",
          empty_response_retries: 2,
        },
        chat_buffer: {
          base_url: `http://127.0.0.1:${upstreamPort}/chat/v1`,
          protocol: "chat_completions",
          timeout_ms: 50,
        },
        slow: {
          base_url: `http://127.0.0.1:${upstreamPort}/slow/v1`,
          protocol: "responses",
          timeout_ms: 50,
        },
        broken: {
          base_url: `http://127.0.0.1:${upstreamPort}/broken/v1`,
          protocol: "responses",
        },
      },
      models: {
        "native/model": {
          provider: "primary",
          upstream_model: "native-upstream",
          capabilities: { streaming: true, function_tools: true },
        },
        "native/restricted": {
          provider: "primary",
          upstream_model: "restricted-upstream",
        },
        "fail/model": {
          provider: "failing",
          upstream_model: "same-model",
          fallbacks: [{ provider: "backup", upstream_model: "same-model" }],
        },
        "sticky/model": {
          provider: "primary",
          upstream_model: "sticky-upstream",
          fallbacks: [{ provider: "backup", upstream_model: "sticky-upstream" }],
        },
        "chat/model": {
          provider: "chat",
          upstream_model: "chat-upstream",
          capabilities: { streaming: true, function_tools: true, parallel_tool_calls: true },
        },
        "chat/bridged": {
          provider: "chat_bridge",
          upstream_model: "chat-bridged-upstream",
          capabilities: { streaming: true, function_tools: true, parallel_tool_calls: true },
        },
        "chat/empty-retry": {
          provider: "chat_retry",
          upstream_model: "empty-retry-upstream",
          capabilities: { streaming: true },
        },
        "chat/serial": {
          provider: "chat",
          upstream_model: "serial-upstream",
          force_serial_tool_calls: true,
          capabilities: { function_tools: true, parallel_tool_calls: true },
        },
        "chat/buffered": {
          provider: "chat_buffer",
          upstream_model: "buffered-upstream",
          force_serial_tool_calls: true,
          buffer_chat_stream: true,
          pre_output_retries: 2,
          max_buffered_stream_size: "64kb",
          capabilities: { streaming: true, function_tools: true, parallel_tool_calls: true },
        },
        "chat/buffered-timeout": {
          provider: "chat_buffer",
          upstream_model: "buffered-timeout-upstream",
          buffer_chat_stream: true,
          pre_output_retries: 1,
          capabilities: { streaming: true },
        },
        "chat/buffered-powershell": {
          provider: "chat_buffer",
          upstream_model: "buffered-powershell-upstream",
          force_serial_tool_calls: true,
          buffer_chat_stream: true,
          pre_output_retries: 1,
          capabilities: { streaming: true, function_tools: true, parallel_tool_calls: true },
        },
        "chat/buffered-listener": {
          provider: "chat_buffer",
          upstream_model: "buffered-listener-upstream",
          force_serial_tool_calls: true,
          buffer_chat_stream: true,
          pre_output_retries: 2,
          capabilities: { streaming: true, function_tools: true, parallel_tool_calls: true },
        },
        "chat/buffered-bounded": {
          provider: "chat_buffer",
          upstream_model: "buffered-bounded-upstream",
          force_serial_tool_calls: true,
          buffer_chat_stream: true,
          pre_output_retries: 2,
          capabilities: { streaming: true, function_tools: true, parallel_tool_calls: true },
        },
        "chat/buffered-repeat": {
          provider: "chat_buffer",
          upstream_model: "buffered-repeat-upstream",
          force_serial_tool_calls: true,
          buffer_chat_stream: true,
          pre_output_retries: 1,
          capabilities: { streaming: true, function_tools: true, parallel_tool_calls: true },
        },
        "chat/buffered-cross-request": {
          provider: "chat_buffer",
          upstream_model: "buffered-cross-request-upstream",
          force_serial_tool_calls: true,
          buffer_chat_stream: true,
          pre_output_retries: 1,
          capabilities: { streaming: true, function_tools: true, parallel_tool_calls: true },
        },
        "chat/buffered-stubborn": {
          provider: "chat_buffer",
          upstream_model: "buffered-stubborn-upstream",
          force_serial_tool_calls: true,
          buffer_chat_stream: true,
          pre_output_retries: 4,
          capabilities: { streaming: true, function_tools: true, parallel_tool_calls: true },
        },
        "limited/model": {
          provider: "chat",
          upstream_model: "limited-upstream",
          capabilities: { parallel_tool_calls: false },
        },
        "timeout/model": {
          provider: "slow",
          upstream_model: "same-model",
          fallbacks: [{ provider: "backup", upstream_model: "same-model" }],
        },
        "broken/model": {
          provider: "broken",
          upstream_model: "same-model",
          fallbacks: [{ provider: "backup", upstream_model: "same-model" }],
        },
      },
      access: [
        {
          api_key_env: "TEST_GATEWAY_KEY",
          models: [
            "native/model",
            "fail/*",
            "sticky/*",
            "chat/*",
            "limited/*",
            "timeout/*",
            "broken/*"
          ],
        },
        { api_key_env: "TEST_LIMITED_KEY", models: ["native/model"] },
      ],
      circuit_breaker: { failure_threshold: 2, cooldown_ms: 10000 },
    }),
  );

  const gatewayPort = await reservePort();
  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(gatewayPort),
      GATEWAY_CONFIG: configPath,
      TEST_GATEWAY_KEY: "gateway-secret",
      TEST_LIMITED_KEY: "limited-secret",
      TEST_UPSTREAM_KEY: "upstream-secret",
      PROXY_API_KEY: "",
      LOG_LEVEL: "error",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  gateway.stdout.on("data", (chunk) => (childOutput += chunk));
  gateway.stderr.on("data", (chunk) => (childOutput += chunk));

  t.after(async () => {
    gateway.kill();
    await Promise.race([new Promise((resolve) => gateway.once("exit", resolve)), delay(2000)]);
    await close(upstream);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  await waitForHealth(baseUrl, gateway, () => childOutput);

  await t.test("requires gateway auth and filters the model list", async () => {
    const missing = await fetch(`${baseUrl}/v1/models`);
    assert.equal(missing.status, 401);

    const limited = await gatewayFetch(baseUrl, "/v1/models", { key: "limited-secret" });
    assert.equal(limited.status, 200);
    assert.deepEqual((await limited.json()).data.map((model) => model.id), ["native/model"]);

    const health = await (await fetch(`${baseUrl}/health`)).text();
    assert.doesNotMatch(health, /gateway-secret|upstream-secret|127\.0\.0\.1/);
  });

  await t.test("transparently forwards native Responses with isolated upstream auth", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "native/model", input: "hello" },
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.id, "resp_native");
    assert.equal(result.model, "native-upstream");

    const call = calls.find((entry) => entry.body.input === "hello");
    assert.equal(call.body.model, "native-upstream");
    assert.equal(call.authorization, "Bearer upstream-secret");
  });

  await t.test("preserves native Responses SSE events", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "native/model", input: "stream", stream: true },
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: response\.created/);
    assert.match(text, /"marker":"preserved"/);
    assert.match(text, /data: \[DONE\]/);
  });

  await t.test("converts Chat Completions text and function calls", async () => {
    const textResponse = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "chat/model", input: "hello chat" },
    });
    const textResult = await textResponse.json();
    assert.equal(textResult.model, "chat/model");
    assert.equal(textResult.output[0].content[0].text, "chat ok");
    assert.equal(textResult.usage.input_tokens, 8);

    const toolResponse = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model: "chat/model",
        input: [
          { type: "message", role: "user", content: "weather?" },
          {
            type: "function_call",
            call_id: "prior_call",
            name: "lookup",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "prior_call", output: "done" },
        ],
        tools: [
          {
            type: "function",
            name: "weather",
            description: "Get weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
      },
    });
    const toolResult = await toolResponse.json();
    assert.equal(toolResult.output[0].type, "function_call");
    assert.equal(toolResult.output[0].name, "weather");
    assert.equal(toolResult.output[0].arguments, '{"city":"Shanghai"}');

    const call = calls.find((entry) => entry.body.tools);
    assert.equal(call.body.model, "chat-upstream");
    assert.equal(call.body.messages[1].tool_calls[0].id, "prior_call");
    assert.equal(call.body.messages[2].role, "tool");
  });

  await t.test("round-trips Responses custom tools through Chat functions", async () => {
    const priorPatch = "*** Begin Patch\n*** Update File: example.txt\n*** End Patch";
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model: "chat/model",
        input: [
          {
            type: "custom_tool_call",
            call_id: "prior_patch",
            name: "apply_patch",
            input: priorPatch,
          },
          { type: "custom_tool_call_output", call_id: "prior_patch", output: "Done" },
        ],
        tools: [
          {
            type: "custom",
            name: "apply_patch",
            description: "Apply a patch",
            format: { type: "text" },
          },
        ],
      },
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.output[0].type, "custom_tool_call");
    assert.equal(result.output[0].name, "apply_patch");
    assert.equal(result.output[0].input, "*** Begin Patch\n*** End Patch");

    const call = calls
      .filter((entry) => entry.body.tools?.[0]?.function?.name === "apply_patch")
      .at(-1);
    assert.equal(call.body.tools[0].function.parameters.required[0], "patch");
    assert.deepEqual(JSON.parse(call.body.messages[0].tool_calls[0].function.arguments), {
      patch: priorPatch,
    });
    assert.equal(call.body.messages[1].role, "tool");
    assert.equal(call.body.messages[1].content, "Done");
  });

  await t.test("forces configured Chat models to execute tools serially", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model: "chat/serial",
        input: "run one tool at a time",
        parallel_tool_calls: true,
        tools: [{ type: "function", name: "weather", parameters: { type: "object" } }],
      },
    });
    assert.equal(response.status, 200);
    const call = calls.filter((entry) => entry.body.model === "serial-upstream").at(-1);
    assert.equal(call.body.parallel_tool_calls, false);
  });

  await t.test("injects configured custom tool bridges for Codex Chat routes", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "chat/bridged", input: "apply a patch" },
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.output[0].type, "function_call");
    assert.equal(result.output[0].name, "shell_command");
    const shellArguments = JSON.parse(result.output[0].arguments);
    assert.match(shellArguments.command, /--codex-run-as-apply-patch/);
    const encoded = /FromBase64String\('([^']+)'\)/.exec(shellArguments.command)?.[1];
    assert.equal(
      Buffer.from(encoded, "base64").toString("utf8"),
      "*** Begin Patch\n*** End Patch",
    );

    const call = calls
      .filter((entry) => entry.body.tools?.[0]?.function?.name === "apply_patch")
      .at(-1);
    assert.ok(call);
    assert.equal(call.body.tools[0].function.parameters.required[0], "patch");
  });

  await t.test("converts URL image input for a Chat Completions vision model", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model: "chat/model",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "inspect" },
              { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" },
            ],
          },
        ],
      },
    });
    assert.equal(response.status, 200);
    const call = calls.find((entry) =>
      entry.body.messages?.some((message) => Array.isArray(message.content)),
    );
    assert.equal(call.body.messages[0].content[1].type, "image_url");
    assert.equal(call.body.messages[0].content[1].image_url.detail, "low");
  });

  await t.test("drops Responses-only reasoning, namespaces, and web search on Chat routes", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model: "chat/model",
        input: "use the regular function",
        reasoning: { effort: "medium", summary: "auto" },
        tools: [
          {
            type: "namespace",
            name: "mcp__example",
            tools: [{ type: "function", name: "remote_tool", parameters: {} }],
          },
          { type: "web_search" },
          {
            type: "function",
            name: "weather",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    });
    assert.equal(response.status, 200);
    const call = calls.filter((entry) => entry.body.model === "chat-upstream").at(-1);
    assert.equal(call.body.tools.length, 1);
    assert.equal(call.body.tools[0].function.name, "weather");
    assert.equal(call.body.reasoning, undefined);
  });

  await t.test("converts Chat Completions SSE in Responses event order", async () => {
    const callsBefore = calls.filter((entry) => entry.body.model === "chat-upstream").length;
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "chat/model", input: "stream chat", stream: true },
    });
    const text = await response.text();
    const created = text.indexOf("event: response.created");
    const delta = text.indexOf("event: response.output_text.delta");
    const completed = text.indexOf("event: response.completed");
    assert.ok(created >= 0 && delta > created && completed > delta);
    assert.match(text, /"text":"hello"/);
    assert.match(text, /"total_tokens":5/);
    assert.equal(
      calls.filter((entry) => entry.body.model === "chat-upstream").length - callsBefore,
      1,
    );
  });

  await t.test("buffers and retries malformed or parallel Gamma-style tool streams", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model: "chat/buffered",
        input: "run one validated tool",
        stream: true,
        parallel_tool_calls: true,
        tools: [{ type: "function", name: "weather", parameters: { type: "object" } }],
      },
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(mockState.bufferedStreamCalls, 3);
    assert.match(text, /call_stream_tool/);
    assert.match(text, /Shanghai/);
    assert.doesNotMatch(text, /call_truncated|call_one|call_two/);
    const bufferedCalls = calls.filter((entry) => entry.body.model === "buffered-upstream");
    assert.equal(bufferedCalls.length, 3);
    assert.ok(bufferedCalls.every((entry) => entry.body.parallel_tool_calls === false));
    assert.match(bufferedCalls[1].body.messages.at(-1).content, /RHZY Gamma runtime retry/);
    assert.match(bufferedCalls[1].body.messages.at(-1).content, /incomplete/);
    assert.match(bufferedCalls[2].body.messages.at(-1).content, /serial policy/);
  });

  await t.test("retries a buffered Gamma-style stream timeout before output", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "chat/buffered-timeout", input: "recover", stream: true },
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(mockState.bufferedTimeoutCalls, 2);
    assert.match(text, /"text":"hello"/);
  });

  await t.test("rejects invalid Gamma PowerShell before executing it and retries with feedback", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model: "chat/buffered-powershell",
        input: "read two lines",
        stream: true,
        parallel_tool_calls: true,
        tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }],
      },
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(mockState.bufferedPowerShellCalls, 2);
    assert.doesNotMatch(text, /-C 1,2/);
    assert.match(text, /Select-Object -First 2/);
    const powerShellCalls = calls.filter((entry) => entry.body.model === "buffered-powershell-upstream");
    assert.equal(powerShellCalls.length, 2);
    assert.ok(powerShellCalls.every((entry) => entry.body.parallel_tool_calls === false));
    assert.match(powerShellCalls[1].body.messages.at(-1).content, /RHZY Gamma runtime retry/);
    assert.match(powerShellCalls[1].body.messages.at(-1).content, /Get-Content/);
  });

  await t.test("keeps Gamma listeners out of the foreground tool process", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model: "chat/buffered-listener",
        input: "start a persistent listener",
        stream: true,
        tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }],
      },
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(mockState.bufferedListenerCalls, 3);
    assert.doesNotMatch(text, /python worker\.py --listen/);
    assert.match(text, /Start-Process/);
    const listenerCalls = calls.filter((entry) => entry.body.model === "buffered-listener-upstream");
    assert.match(listenerCalls[1].body.messages.at(-1).content, /long-running --listen/);
    assert.match(listenerCalls[1].body.messages.at(-1).content, /Start-Process/);
    assert.match(listenerCalls[2].body.messages.at(-1).content, /Start-Sleep/);
    assert.match(listenerCalls[2].body.messages.at(-1).content, /3 seconds/);
  });

  await t.test("bounds Gamma recursion and long inline Python after a tool timeout", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model: "chat/buffered-bounded",
        input: [
          { type: "function_call", call_id: "call_timed_out", name: "shell_command", arguments: '{"command":"slow command"}' },
          { type: "function_call_output", call_id: "call_timed_out", output: "Exit code: 124 Wall time: 14.1 seconds" },
        ],
        stream: true,
        tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }],
      },
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(mockState.bufferedBoundedCalls, 3);
    assert.doesNotMatch(text, /Get-ChildItem|print\(11\)/);
    assert.match(text, /rg --files/);
    const boundedCalls = calls.filter((entry) => entry.body.model === "buffered-bounded-upstream");
    assert.ok(boundedCalls.every((entry) => entry.body.messages.some((message) => String(message.content || "").startsWith("[RHZY Gamma tool result]"))));
    assert.match(boundedCalls[1].body.messages.at(-1).content, /unbounded Get-ChildItem/);
    assert.match(boundedCalls[2].body.messages.at(-1).content, /multiline Python/);
  });

  await t.test("stops Gamma from replaying an identical failed shell command", async () => {
    const failedCall = { type: "function_call", name: "shell_command", arguments: '{"command":"Get-Item missing.txt"}' };
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model: "chat/buffered-repeat",
        input: [
          { ...failedCall, call_id: "call_failed_one" },
          { type: "function_call_output", call_id: "call_failed_one", output: "Exit code: 1 Wall time: 0.4 seconds" },
          { ...failedCall, call_id: "call_failed_two" },
          { type: "function_call_output", call_id: "call_failed_two", output: "Exit code: 1 Wall time: 0.4 seconds" },
        ],
        stream: true,
        tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }],
      },
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(mockState.bufferedRepeatCalls, 1);
    assert.doesNotMatch(text, /Get-Item missing\.txt/);
    assert.match(text, /Gamma runtime stopped this turn/);
    const repeatCalls = calls.filter((entry) => entry.body.model === "buffered-repeat-upstream");
    assert.ok(repeatCalls[0].body.messages.some((message) => String(message.content || "").includes("already returned a nonzero exit at least twice")));
  });

  await t.test("tracks repeated Gamma failures across Responses requests", async () => {
    const model = "chat/buffered-cross-request";
    const promptCacheKey = "gamma-cross-request-thread";
    const first = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model, prompt_cache_key: promptCacheKey, input: "start", stream: true, tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }] },
    });
    const firstText = await first.text();
    assert.match(firstText, /call_cross_1/);

    const second = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model,
        prompt_cache_key: promptCacheKey,
        input: [
          { type: "function_call", call_id: "call_cross_1", name: "shell_command", arguments: '{"command":"Get-Item cross-request-missing.txt"}' },
          { type: "function_call_output", call_id: "call_cross_1", output: "Exit code: 1 Wall time: 0.4 seconds" },
        ],
        stream: true,
        tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }],
      },
    });
    const secondText = await second.text();
    assert.match(secondText, /call_cross_2/);

    const third = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model,
        prompt_cache_key: promptCacheKey,
        input: [
          { type: "function_call", call_id: "call_cross_2", name: "shell_command", arguments: '{"command":"Get-Item cross-request-missing.txt"}' },
          { type: "function_call_output", call_id: "call_cross_2", output: "Exit code: 1 Wall time: 0.4 seconds" },
        ],
        stream: true,
        tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }],
      },
    });
    const thirdText = await third.text();
    assert.equal(third.status, 200);
    assert.equal(mockState.bufferedCrossRequestCalls, 3);
    assert.doesNotMatch(thirdText, /Get-Item cross-request-missing\.txt/);
    assert.match(thirdText, /Gamma runtime stopped this turn/);
  });

  await t.test("ends a stubborn Gamma turn cleanly instead of replaying a blocked command", async () => {
    const failedCall = { type: "function_call", name: "shell_command", arguments: '{"command":"Get-Item stubborn-missing.txt"}' };
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model: "chat/buffered-stubborn",
        input: [
          { ...failedCall, call_id: "call_stubborn_one" },
          { type: "function_call_output", call_id: "call_stubborn_one", output: "Exit code: 1 Wall time: 0.4 seconds" },
          { ...failedCall, call_id: "call_stubborn_two" },
          { type: "function_call_output", call_id: "call_stubborn_two", output: "Exit code: 1 Wall time: 0.4 seconds" },
        ],
        stream: true,
        tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }],
      },
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(mockState.bufferedStubbornCalls, 1);
    assert.match(text, /Gamma runtime stopped this turn/);
    assert.doesNotMatch(text, /call_stubborn/);
    assert.match(text, /response\.completed/);
  });

  await t.test("retries empty Chat streams before emitting Responses output", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "chat/empty-retry", input: "retry empty stream", stream: true },
    });
    const text = await response.text();
    assert.match(text, /"text":"hello"/);
    assert.equal(mockState.emptyStreamCalls, 3);
    assert.equal(
      calls.filter((entry) => entry.body.model === "empty-retry-upstream").length,
      3,
    );
  });

  await t.test("streams Chat custom tools as Responses custom tool events", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model: "chat/model",
        input: "patch the file",
        stream: true,
        tools: [
          { type: "custom", name: "apply_patch", description: "Apply a patch" },
        ],
      },
    });
    const text = await response.text();
    assert.match(text, /"type":"custom_tool_call"/);
    assert.match(text, /event: response\.custom_tool_call_input\.delta/);
    assert.match(text, /event: response\.custom_tool_call_input\.done/);
    assert.match(text, /\*\*\* Begin Patch/);
    assert.doesNotMatch(text, /"type":"function_call"/);
  });

  await t.test("fails over only before output starts", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "fail/model", input: "fail over" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, "resp_backup");
    assert.ok(calls.some((entry) => entry.path === "/failing/v1/responses"));
    assert.ok(calls.some((entry) => entry.path === "/backup/v1/responses"));
  });

  await t.test("fails over after a first-byte timeout", async () => {
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "timeout/model", input: "too slow" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, "resp_backup");
    assert.ok(calls.some((entry) => entry.path === "/slow/v1/responses"));
  });

  await t.test("does not fail over after an SSE stream starts", async () => {
    const backupCallsBefore = calls.filter((entry) => entry.path === "/backup/v1/responses").length;
    const response = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "broken/model", input: "break", stream: true },
    });
    await assert.rejects(response.text());
    const backupCallsAfter = calls.filter((entry) => entry.path === "/backup/v1/responses").length;
    assert.equal(backupCallsAfter, backupCallsBefore);
  });

  await t.test("keeps previous_response_id on its original route", async () => {
    const first = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "sticky/model", input: "first" },
    });
    assert.equal((await first.json()).id, "resp_sticky");
    mockState.stickyFails = true;
    const backupCallsBefore = calls.filter((entry) => entry.path === "/backup/v1/responses").length;
    const second = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "sticky/model", input: "second", previous_response_id: "resp_sticky" },
    });
    assert.equal(second.status, 503);
    const backupCallsAfter = calls.filter((entry) => entry.path === "/backup/v1/responses").length;
    assert.equal(backupCallsAfter, backupCallsBefore);

    const unknown = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "sticky/model", input: "unknown", previous_response_id: "resp_unknown" },
    });
    assert.equal(unknown.status, 409);
    assert.equal((await unknown.json()).error.code, "previous_response_route_unknown");
  });

  await t.test("enforces model permissions and declared capabilities", async () => {
    const forbidden = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "native/restricted", input: "no" },
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error.code, "model_not_allowed");

    const unsupported = await gatewayFetch(baseUrl, "/v1/responses", {
      body: { model: "limited/model", input: "no", parallel_tool_calls: true },
    });
    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json()).error.code, "unsupported_parallel_tool_calls");

    const defaulted = await gatewayFetch(baseUrl, "/v1/responses", {
      body: {
        model: "limited/model",
        input: "tool",
        tools: [
          {
            type: "function",
            name: "weather",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    });
    assert.equal(defaulted.status, 200);
    const limitedCall = calls.filter((entry) => entry.body.model === "limited-upstream").at(-1);
    assert.equal(limitedCall.body.parallel_tool_calls, false);
  });

  await t.test("normalizes common upstream errors without echoing secrets", async () => {
    const expectedCodes = new Map([
      [401, "upstream_unauthorized"],
      [403, "upstream_forbidden"],
      [404, "upstream_not_found"],
      [429, "upstream_rate_limited"],
      [500, "upstream_server_error"],
    ]);
    for (const [status, code] of expectedCodes) {
      const response = await gatewayFetch(baseUrl, "/v1/responses", {
        body: { model: "native/model", input: `error-${status}` },
      });
      assert.equal(response.status, status);
      const error = await response.json();
      assert.equal(error.error.code, code);
      assert.doesNotMatch(error.error.message, /secret-value/);
      if (status === 401) assert.match(error.error.message, /\[redacted\]/);
    }
  });
});

async function gatewayFetch(baseUrl, requestPath, options = {}) {
  return fetch(`${baseUrl}${requestPath}`, {
    method: options.body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${options.key || "gateway-secret"}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

async function waitForHealth(baseUrl, child, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Gateway exited early:\n${output()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Startup race.
    }
    await delay(25);
  }
  throw new Error(`Gateway did not become healthy:\n${output()}`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
