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
  assert.equal(imageItem.type, "image_generation_call");
  assert.equal(imageItem.result, undefined);
  assert.match(imageItem.output, /generated image omitted from history/);
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