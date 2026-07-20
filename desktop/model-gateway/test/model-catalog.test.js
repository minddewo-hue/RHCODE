import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("non-OpenAI catalog entries identify their routed model", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "codex-model-catalog.json"), "utf8"));
  const models = new Map(catalog.models.map((model) => [model.slug, model]));

  for (const slug of [
    "faker/kimi-for-coding",
    "faker/MiniMax-M2.5",
    "vllm/gemma-4-31b-it-uncensored-bf16",
  ]) {
    const instructions = models.get(slug)?.base_instructions || "";
    assert.match(instructions, new RegExp(`active model ID is ${escapeRegExp(slug)}`, "i"));
    assert.doesNotMatch(instructions, /^You are GPT-/);
  }

  const gemma = models.get("vllm/gemma-4-31b-it-uncensored-bf16");
  assert.equal(gemma.context_window, 131072);
  assert.match(gemma.base_instructions, /Get-ChildItem -Filter/);
  assert.match(gemma.base_instructions, /never place `\*\.java` or `\*\*` in a path/);
  assert.match(gemma.base_instructions, /multi_tool_use\.parallel/);
  assert.match(gemma.base_instructions, /Get-Content` has no `-From/);
  assert.match(gemma.base_instructions, /do not join commands with semicolons/i);
  assert.match(gemma.base_instructions, /Do not repeat an unchanged failed command/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
