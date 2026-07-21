import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicToResponse,
  responsesToAnthropicRequest,
  streamAnthropicAsResponses,
} from "../src/anthropic-adapter.js";

test("converts Responses messages and tools to Anthropic Messages", () => {
  const request = {
    instructions: "Follow repository rules.",
    input: [
      { role: "user", type: "message", content: [{ type: "input_text", text: "Inspect" }] },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
      { type: "function_call_output", call_id: "call_1", output: "contents" },
    ],
    tools: [{
      type: "function",
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    }],
    tool_choice: "auto",
    stream: true,
  };

  const converted = responsesToAnthropicRequest(request, "claude-sonnet-test");
  assert.equal(converted.model, "claude-sonnet-test");
  assert.equal(converted.system, "Follow repository rules.");
  assert.deepEqual(converted.messages[1].content[0], {
    type: "tool_use",
    id: "call_1",
    name: "read_file",
    input: { path: "a.ts" },
  });
  assert.deepEqual(converted.messages[2].content[0], {
    type: "tool_result",
    tool_use_id: "call_1",
    content: "contents",
  });
  assert.equal(converted.tools[0].input_schema.type, "object");
  assert.deepEqual(converted.tool_choice, { type: "auto" });
});

test("converts an Anthropic message to a Responses result", () => {
  const response = anthropicToResponse(
    { input: "test", tools: [{ type: "function", name: "weather" }] },
    {
      content: [
        { type: "text", text: "Checking" },
        { type: "tool_use", id: "toolu_1", name: "weather", input: { city: "Shanghai" } },
      ],
      usage: { input_tokens: 7, output_tokens: 3 },
    },
    "resp_test",
    "anthropic/test",
  );
  assert.equal(response.output[0].content[0].text, "Checking");
  assert.equal(response.output[1].type, "function_call");
  assert.equal(response.output[1].call_id, "toolu_1");
  assert.equal(response.output[1].arguments, '{"city":"Shanghai"}');
  assert.deepEqual(response.usage, { input_tokens: 7, output_tokens: 3, total_tokens: 10 });
});

test("streams Anthropic text as ordered Responses SSE events", async () => {
  const encoder = new TextEncoder();
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames.slice(1)) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  const output = [];
  const clientRes = {
    writeHead() {},
    write(value) { output.push(String(value)); },
    end() {},
  };
  await streamAnthropicAsResponses({
    reader: stream.getReader(),
    firstChunk: encoder.encode(frames[0]),
    clientRes,
    request: { input: "hello", stream: true },
    responseId: "resp_stream",
    publicModel: "anthropic/test",
  });
  const text = output.join("");
  assert.match(text, /event: response\.created/);
  assert.match(text, /event: response\.output_text\.delta/);
  assert.match(text, /"delta":"Hello"/);
  assert.match(text, /event: response\.completed/);
  assert.match(text, /"total_tokens":6/);
  assert.match(text, /data: \[DONE\]/);
});
