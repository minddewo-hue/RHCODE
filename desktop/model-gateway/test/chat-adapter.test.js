import assert from "node:assert/strict";
import test from "node:test";
import { chatToResponse, responsesToChatRequest, streamChatAsResponses } from "../src/chat-adapter.js";

function chunk(delta = {}, finish_reason = null, index = 0) {
  return { choices: [{ index, delta, finish_reason }] };
}

async function stream(frames, { request = {}, splitBytes = false, failAfterFrames = false, failure } = {}) {
  const bytes = new TextEncoder().encode(frames.map((frame) =>
    `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\r\n\r\n`,
  ).join(""));
  const chunks = splitBytes ? Array.from(bytes, (byte) => Uint8Array.of(byte)) : [bytes];
  let cancelled = false;
  const reader = {
    async read() {
      if (chunks.length) return { done: false, value: chunks.shift() };
      if (failAfterFrames) throw failure || new Error("Connection reset");
      return { done: true };
    },
    async cancel() { cancelled = true; },
  };
  const writes = [];
  let response;
  let error;
  let outcome;
  await streamChatAsResponses({
    reader,
    firstChunk: chunks.shift(),
    clientRes: { writeHead() {}, write(value) { writes.push(value); }, end() {} },
    request,
    responseId: "resp_test",
    publicModel: "local/qwen",
    onComplete(value) { response = value; },
    onError(value) { error = value; },
    onFinish(value) { outcome = value; },
  });
  const events = writes.join("").split("\n\n")
    .filter((frame) => frame.startsWith("event:"))
    .map((frame) => JSON.parse(frame.split("\ndata: ")[1]));
  return { response, error, outcome, events, cancelled };
}

test("maps nonstream length and content filtering to incomplete responses without tool execution", () => {
  for (const [reason, expected] of [["length", "max_output_tokens"], ["content_filter", "content_filter"]]) {
    const response = chatToResponse({}, {
      choices: [{ finish_reason: reason, message: {
        content: "Partial answer",
        tool_calls: [{ function: { name: "shell_command", arguments: '{"command":' } }],
      } }],
    }, "resp_test", "local/qwen");
    assert.equal(response.status, "incomplete");
    assert.deepEqual(response.incomplete_details, { reason: expected });
    assert.equal(response.output.length, 1);
    assert.equal(response.output[0].status, "incomplete");
  }
});

test("rejects nonstream missing terminals and malformed tool arguments", () => {
  assert.throws(() => chatToResponse({}, { choices: [{ message: { content: "partial" } }] }),
    { code: "upstream_missing_terminal" });
  assert.throws(() => chatToResponse({}, { choices: [{ finish_reason: "tool_calls", message: {
    tool_calls: [{ function: { name: "shell_command", arguments: '{"command":' } }],
  } }] }), { code: "invalid_tool_arguments" });
});

test("preserves fragmented Unicode, CRLF, usage and a natural stop", async () => {
  const result = await stream([
    chunk({ content: "检查完成。" }), chunk({}, "stop"),
    { choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }, "[DONE]",
  ], { splitBytes: true });
  assert.equal(result.error, undefined);
  assert.equal(result.response.status, "completed");
  assert.equal(result.response.output[0].content[0].text, "检查完成。");
  assert.equal(result.outcome.finish_reason, "stop");
  assert.equal(result.outcome.done_received, true);
  assert.equal(result.outcome.usage.output_tokens, 3);
  assert.equal(result.cancelled, true);
});

test("accepts an explicit finish reason followed by EOF without requiring DONE", async () => {
  const result = await stream([chunk({ content: "done" }, "stop")]);
  assert.equal(result.response.status, "completed");
  assert.equal(result.outcome.terminal_received, true);
  assert.equal(result.outcome.done_received, false);
});

test("length emits one incomplete terminal and retains text without completing truncated tools", async () => {
  const result = await stream([
    chunk({ content: "Partial", tool_calls: [{ index: 0, id: "call_1", function: {
      name: "shell_command", arguments: '{"command":',
    } }] }), chunk({}, "length"), "[DONE]",
  ], { request: { max_output_tokens: 100 } });
  assert.equal(result.response.status, "incomplete");
  assert.deepEqual(result.response.incomplete_details, { reason: "max_output_tokens" });
  assert.deepEqual(result.response.output.map((item) => item.type), ["message"]);
  assert.equal(result.outcome.tool_call_count, 1);
  assert.equal(result.outcome.max_output_tokens, 100);
  assert.equal(result.events.filter((event) => event.type === "response.incomplete").length, 1);
  assert.ok(!result.events.some((event) => event.type === "response.completed"));
  assert.ok(!result.events.some((event) => event.type === "response.function_call_arguments.done"));
  assert.ok(!result.events.some((event) => event.type === "response.output_item.done" && event.item.type === "function_call"));
});

test("EOF and DONE without a finish reason fail instead of reporting success", async () => {
  for (const tail of [[], ["[DONE]"]]) {
    const result = await stream([chunk({ content: "Partial" }), ...tail]);
    assert.equal(result.response, undefined);
    assert.equal(result.error.code, "upstream_missing_terminal");
    assert.equal(result.outcome.response_status, "failed");
    const failure = result.events.find((event) => event.type === "response.failed");
    assert.equal(failure.response.output[0].content[0].text, "Partial");
    assert.ok(!result.events.some((event) => event.type === "response.completed"));
  }
});

test("transport errors and upstream SSE errors fail without finalizing tools", async () => {
  for (const options of [{ failAfterFrames: true }, {}]) {
    const result = await stream([
      chunk({ tool_calls: [{ index: 0, function: { name: "shell_command", arguments: '{"command":' } }] }),
      ...(options.failAfterFrames ? [] : [{ error: { message: "private provider details" } }]),
    ], options);
    assert.ok(result.error);
    assert.ok(!result.events.some((event) => event.type === "response.output_item.done"));
    assert.ok(!JSON.stringify(result.events).includes("private provider details"));
  }
});

test("validates all tool arguments before marking any tool executable", async () => {
  const result = await stream([
    chunk({ tool_calls: [
      { index: 0, id: "valid", function: { name: "read_file", arguments: '{"path":"a"}' } },
      { index: 1, id: "invalid", function: { name: "shell_command", arguments: '{"command":' } },
    ] }, "tool_calls"), "[DONE]",
  ]);
  assert.equal(result.error.code, "invalid_tool_arguments");
  assert.ok(!result.events.some((event) => event.type === "response.output_item.done"));
});

test("valid function and custom tool calls still complete", async () => {
  for (const name of ["read_file", "apply_patch"]) {
    const result = await stream([
      chunk({ tool_calls: [{ index: 0, id: "call_ok", function: {
        name, arguments: JSON.stringify(name === "apply_patch" ? { patch: "*** Begin Patch\n*** End Patch" } : { path: "a" }),
      } }] }, "tool_calls"), "[DONE]",
    ], { request: { tools: [{ type: name === "apply_patch" ? "custom" : "function", name }] } });
    assert.equal(result.error, undefined);
    assert.equal(result.response.status, "completed");
    assert.equal(result.response.output[0].call_id, "call_ok");
  }
});

test("native patch calls preserve source newlines and backslashes through Chat JSON", async () => {
  const patch = '*** Begin Patch\n*** Add File: src/csv.mjs\n+const newline = "\\n";\n+const pattern = /\\r?\\n/g;\n*** End Patch';
  const request = { tools: [{ type: "custom", name: "apply_patch" }] };
  const converted = responsesToChatRequest(request, "qwen3.8-27b-uncensored-fp8");
  assert.ok(converted.tools[0].function.parameters.properties.patch.description.includes("*** Begin Patch"));
  const call = { index: 0, id: "patch_call", function: { name: "apply_patch", arguments: JSON.stringify({ patch }) } };
  const result = await stream([chunk({ tool_calls: [call] }, "tool_calls"), "[DONE]"], { request, splitBytes: true });
  assert.equal(result.response.output[0].type, "custom_tool_call");
  assert.equal(result.response.output[0].input, patch);
  const response = chatToResponse(request, { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [call] } }] });
  assert.equal(response.output[0].input, patch);
});

test("ignores alternative choices and closes on DONE even if the connection stays open", async () => {
  const result = await stream([
    chunk({ content: "primary" }, "stop"), chunk({ content: "alternative" }, "length", 1), "[DONE]",
  ], { failAfterFrames: true });
  assert.equal(result.response.output[0].content[0].text, "primary");
  assert.equal(result.response.status, "completed");
});

test("forwards reasoning-only chunks immediately without mixing them into the final answer", async () => {
  const result = await stream([
    chunk({ reasoning_content: "Inspecting the requirements." }),
    chunk({ reasoning_content: "Checking the edge cases." }),
    chunk({ content: "Done." }, "stop"), "[DONE]",
  ]);
  assert.equal(result.response.status, "completed");
  assert.deepEqual(result.response.output.map((item) => item.type), ["reasoning", "message"]);
  assert.equal(result.response.output[0].content[0].text, "Inspecting the requirements.Checking the edge cases.");
  assert.equal(result.response.output[1].content[0].text, "Done.");
  assert.equal(result.events.filter((event) => event.type === "response.reasoning_text.delta").length, 2);
  assert.ok(result.events.findIndex((event) => event.type === "response.reasoning_text.delta")
    < result.events.findIndex((event) => event.type === "response.output_text.delta"));
  assert.equal(result.outcome.reasoning_text_chars, 52);
  assert.equal(result.outcome.output_text_chars, 5);
});

test("preserves nonstream reasoning and alternative reasoning field", async () => {
  const response = chatToResponse({}, { choices: [{ finish_reason: "stop", message: {
    reasoning_content: "Checking.", content: "Done.",
  } }] }, "resp_reasoning", "local/qwen");
  assert.equal(response.output[0].type, "reasoning");
  const result = await stream([chunk({ reasoning: "Checking." }), chunk({ content: "Done." }, "stop"), "[DONE]"]);
  assert.equal(result.response.output[0].content[0].text, "Checking.");
});

test("does not emit DOMException numeric codes as Responses API error codes", async () => {
  const result = await stream([chunk({ reasoning_content: "Partial thinking." })], {
    failAfterFrames: true, failure: new DOMException("Aborted", "AbortError"),
  });
  assert.equal(result.outcome.reasoning_text_chars, 17);
  assert.equal(result.outcome.error_code, "upstream_timeout");
  assert.equal(result.events.find((event) => event.type === "response.failed").response.error.code, "upstream_timeout");
  assert.equal(result.events.find((event) => event.type === "response.failed").response.output[0].status, "incomplete");
});
