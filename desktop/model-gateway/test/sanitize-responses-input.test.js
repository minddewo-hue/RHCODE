import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeResponsesRequestBody } from "../src/sanitize-responses-input.js";
import { responsesToChatRequest } from "../src/chat-adapter.js";

const LARGE_PNG_B64 = "iVBORw0KGgo" + "A".repeat(20_000);

test("strips oversized image_generation_call.result from Responses history", () => {
  const body = {
    model: "provider-2/grok-latest",
    store: false,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "draw a cat" }] },
      {
        type: "image_generation_call",
        id: "ig_test",
        status: "completed",
        revised_prompt: "a fluffy cat",
        result: LARGE_PNG_B64,
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ],
  };

  const sanitized = sanitizeResponsesRequestBody(body);
  assert.equal(sanitized.strippedCount, 1);
  assert.ok(sanitized.strippedBytes > 10_000);
  const imageItem = sanitized.body.input[1];
  assert.equal(imageItem.type, "message");
  assert.equal(imageItem.role, "assistant");
  assert.equal(imageItem.result, undefined);
  assert.match(imageItem.content[0].text, /generated image omitted from history/);
  assert.equal(sanitized.body.input[2].content[0].text, "hello");
  // Original body is not mutated.
  assert.equal(typeof body.input[1].result, "string");
});

test("leaves small non-binary image_generation results alone", () => {
  const body = {
    model: "native/model",
    input: [
      {
        type: "image_generation_call",
        id: "ig_small",
        status: "completed",
        result: "tiny",
      },
    ],
  };
  const sanitized = sanitizeResponsesRequestBody(body);
  assert.equal(sanitized.strippedCount, 0);
  assert.equal(sanitized.body, body);
});

test("moves Responses system and developer messages before conversation history", () => {
  const body = {
    model: "native/model",
    input: [
      { type: "message", role: "user", content: "Earlier user message" },
      { type: "function_call", call_id: "call_1", name: "tool", arguments: "{}" },
      { type: "message", role: "developer", content: "Developer instructions" },
      { type: "message", role: "system", content: "System instructions" },
      { type: "message", role: "user", content: "Current user message" },
    ],
  };

  const sanitized = sanitizeResponsesRequestBody(body);
  assert.deepEqual(
    sanitized.body.input.map((item) => item.role || item.type),
    ["developer", "system", "user", "function_call", "user"],
  );
  assert.equal(body.input[0].role, "user");
});

test("chat adapter converts image_generation_call without dumping base64", () => {
  const chat = responsesToChatRequest(
    {
      input: [
        {
          type: "image_generation_call",
          id: "ig_chat",
          status: "completed",
          revised_prompt: "sunset",
          result: LARGE_PNG_B64,
        },
      ],
    },
    "chat-upstream",
  );
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0].role, "assistant");
  assert.match(chat.messages[0].content, /generated image omitted/);
  assert.doesNotMatch(chat.messages[0].content, /iVBORw0KGgo/);
});

test("chat adapter combines developer messages into the leading system message", () => {
  const chat = responsesToChatRequest(
    {
      instructions: "Base instructions.",
      input: [
        { role: "user", content: [{ type: "input_text", text: "First task" }] },
        { role: "developer", content: [{ type: "input_text", text: "Additional rules." }] },
        { role: "user", content: [{ type: "input_text", text: "Second task" }] },
      ],
    },
    "chat-upstream",
  );

  assert.deepEqual(chat.messages, [
    { role: "system", content: "Base instructions.\n\nAdditional rules." },
    { role: "user", content: "First task" },
    { role: "user", content: "Second task" },
  ]);
});

test("chat adapter preserves truncated historical tool arguments as valid JSON", () => {
  const chat = responsesToChatRequest(
    {
      input: [
        {
          type: "function_call",
          call_id: "call_truncated",
          name: "shell_command",
          arguments: '{"command":"Get-Content ',
        },
        {
          type: "function_call_output",
          call_id: "call_truncated",
          output: "failed to parse function arguments",
        },
      ],
    },
    "chat-upstream",
  );

  const toolCall = chat.messages[0].tool_calls[0];
  assert.deepEqual(JSON.parse(toolCall.function.arguments), {
    _rhzy_incomplete_arguments: '{"command":"Get-Content ',
  });
  assert.equal(chat.messages[1].tool_call_id, "call_truncated");
});

test("chat adapter omits tool_choice when no Chat Completions tools are available", () => {
  const chat = responsesToChatRequest(
    { input: "Continue the task.", tool_choice: "auto" },
    "test-model",
  );

  assert.equal(chat.tools, undefined);
  assert.equal(chat.tool_choice, undefined);
});
