import assert from "node:assert/strict";
import test from "node:test";
import { applyQwen27bChatRequestPolicy, applyQwen27bCatalogPolicy, isQwen27bModel } from "../src/qwen-27b-policy.js";
import { taskCompletionContext, taskCompletionCheckRequest, parseTaskCompletionCheck } from "../src/task-completion-check.js";

const model = "qwen3.8-27b-uncensored-fp8";
test("targets the exact local Qwen deployment and preserves other models", () => {
  assert.equal(isQwen27bModel(model), true);
  assert.equal(isQwen27bModel(`provider-6/${model}`), true);
  assert.equal(isQwen27bModel(`${model}-other`), false);
  const request = { messages: [], reasoning_effort: "high" };
  assert.equal(applyQwen27bChatRequestPolicy(request, "other-model"), request);
});
test("defaults Qwen to direct execution and translates an explicit thinking choice", () => {
  for (const effort of [undefined, "none", "high", "medium"]) {
    const request = { messages: [], reasoning_effort: effort, chat_template_kwargs: { custom: true } };
    const adjusted = applyQwen27bChatRequestPolicy(request, model);
    assert.equal(adjusted.chat_template_kwargs.enable_thinking, Boolean(effort && effort !== "none"));
    assert.equal(adjusted.chat_template_kwargs.custom, true);
    assert.ok(!("reasoning_effort" in adjusted));
    assert.equal(request.reasoning_effort, effort);
  }
  const entry = {};
  applyQwen27bCatalogPolicy(entry, model);
  assert.equal(entry.default_reasoning_level, "none");
  assert.equal(entry.apply_patch_tool_type, "freeform");
  assert.deepEqual(entry.supported_reasoning_levels.map((option) => option.effort), ["none", "high"]);
  const instructions = entry.base_instructions;
  applyQwen27bCatalogPolicy(entry, model);
  assert.equal(entry.base_instructions, instructions);
});
test("completion checks retain the original goal, bound history and never offer execution tools", () => {
  const context = taskCompletionContext({ input: [
    { role: "user", content: "Implement modules and tests." },
    { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "x".repeat(4000) }) },
    { type: "function_call_output", output: "y".repeat(8000) },
    { role: "user", content: "继续完成原任务尚未完成的部分。" },
  ] }, { output: [{ type: "message", content: [{ text: "Now I will write tests." }] }] }, { upstreamModel: model });
  assert.equal(context.goal, "Implement modules and tests.");
  assert.equal(context.lastReply, "Now I will write tests.");
  const check = taskCompletionCheckRequest(context);
  assert.ok(!check.tools);
  assert.equal(check.stream, false);
  assert.deepEqual(check.response_format, { type: "json_object" });
  assert.equal(check.chat_template_kwargs.enable_thinking, false);
  assert.ok(check.messages[1].content.length < 5000);
});
test("completion review requires structured verdicts and fails closed on malformed output", () => {
  for (const status of ["complete", "continue", "needs_input", "blocked"]) {
    assert.equal(parseTaskCompletionCheck({ choices: [{ message: { content: JSON.stringify({ status, next_step: "test" }) } }] }).status, status);
  }
  for (const content of ["continue", '{"status":"execute"}', "", null]) {
    assert.equal(parseTaskCompletionCheck({ choices: [{ message: { content } }] }).status, "unknown");
  }
});
