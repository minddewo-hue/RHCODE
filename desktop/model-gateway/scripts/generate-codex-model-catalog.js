#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv, loadGatewayConfig } from "../src/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
loadDotEnv(path.join(root, "..", ".env"));

const outputPath = path.resolve(process.argv[2] || "codex-model-catalog.json");
const bundled = JSON.parse(
  execFileSync("codex", ["debug", "models", "--bundled"], { encoding: "utf8" }),
);
const bundledModels = new Map(bundled.models.map((model) => [model.slug, model]));
const config = loadGatewayConfig();

const fallbackTemplates = [
  [/^gpt-5\.2/, "gpt-5.2"],
  [/^gpt-5\.3/, "gpt-5.4"],
  [/^gpt-5\.4/, "gpt-5.4"],
  [/^gpt-5\.5/, "gpt-5.5"],
  [/^gpt-5\.6-luna/, "gpt-5.6-luna"],
  [/^gpt-5\.6-sol/, "gpt-5.6-sol"],
  [/^gpt-5\.6-terra/, "gpt-5.6-terra"],
];

const displayNames = {
  "faker/kimi-for-coding": "Faker - Kimi for Coding",
  "vllm/gemma-4-31b-it-uncensored": "vLLM - Gemma 4 31B",
  "vllm/gemma-4-31b-it-uncensored-bf16": "vLLM - Gemma 4 31B BF16",
};

const models = [...config.models.values()].map((model, index) => {
  const route = model.routes[0];
  const template = selectTemplate(route.upstreamModel, route.provider.id);
  const entry = structuredClone(template);

  entry.slug = model.id;
  entry.display_name =
    displayNames[model.id] ||
    `${providerLabel(route.provider.id)} - ${route.upstreamModel}`;
  entry.description = `${route.upstreamModel} through the local RHZY gateway.`;
  entry.visibility = "list";
  entry.supported_in_api = true;
  entry.priority = index + 1;
  entry.additional_speed_tiers = [];
  entry.service_tiers = [];
  entry.availability_nux = null;
  entry.upgrade = null;

  if (route.provider.id !== "sub2api") {
    entry.base_instructions = nonOpenAiBaseInstructions(
      entry.base_instructions,
      model.id,
      route.upstreamModel,
    );
  }

  if (route.provider.protocol === "chat_completions") {
    entry.default_reasoning_level = null;
    entry.supported_reasoning_levels = [];
    entry.supports_reasoning_summaries = false;
    entry.default_reasoning_summary = "none";
    entry.support_verbosity = false;
    entry.default_verbosity = null;
    entry.supports_parallel_tool_calls = model.capabilities.parallel_tool_calls !== false;
    entry.supports_image_detail_original = false;
    entry.input_modalities = ["text"];
    entry.supports_search_tool = false;
    entry.use_responses_lite = false;
    entry.shell_type = "default";
    entry.apply_patch_tool_type = null;
    entry.context_window = model.contextWindow || 131072;
    entry.max_context_window = entry.context_window;
    entry.effective_context_window_percent = 90;
  }

  return entry;
});

fs.writeFileSync(outputPath, `${JSON.stringify({ models }, null, 2)}\n`, "utf8");
console.log(`Wrote ${models.length} models to ${outputPath}`);

function selectTemplate(upstreamModel, providerId) {
  if (providerId === "sub2api") {
    const exact = bundledModels.get(upstreamModel);
    if (exact) return exact;
    for (const [pattern, slug] of fallbackTemplates) {
      if (pattern.test(upstreamModel)) return requireTemplate(slug);
    }
  }
  return requireTemplate("gpt-5.2");
}

function requireTemplate(slug) {
  const template = bundledModels.get(slug);
  if (!template) throw new Error(`Codex bundled catalog is missing template ${slug}.`);
  return template;
}

function providerLabel(providerId) {
  if (providerId === "sub2api") return "Sub2API";
  if (providerId === "faker") return "Faker";
  return providerId;
}

function nonOpenAiBaseInstructions(template, publicModel, upstreamModel) {
  const sections = String(template || "").split(/\r?\n\r?\n/);
  sections[0] = [
    `You are Codex, a coding agent powered by ${upstreamModel} through the Codex CLI.`,
    `The active model ID is ${publicModel}.`,
    "If asked which model is active, answer with this model ID and do not claim to be an OpenAI GPT model.",
  ].join(" ");
  if (publicModel.startsWith("vllm/")) {
    sections.splice(1, 0, [
      "## Windows tool rules",
      "The host shell is Windows PowerShell. Use `rg` and `rg --files` for recursive search instead of broad `Get-ChildItem | Select-String` scans.",
      "`Get-ChildItem -Filter` accepts exactly one pattern; for multiple extensions use `rg` with repeated `-g` globs.",
      "For recursive ripgrep on Windows, use `rg -n -g '*.java' 'pattern' <directory>`. Put globs only in `-g`; never place `*.java` or `**` in a path and never use `rg -r`.",
      "Tool wrappers are not shell syntax. Never type `multi_tool_use.parallel(...)`, `cat(...)`, or similar orchestration pseudocode into PowerShell; send only a valid command to the shell tool.",
      "`Get-Content` has no `-From` parameter; use `Get-Content <path> | Select-Object -Skip <n> -First <n>` for a bounded range.",
      "Set the tool working directory instead of running `cd`. Run independent checks as separate tool calls; do not join commands with semicolons. Run Python tests from the directory containing their importable modules.",
      "Constrain searches to the narrowest relevant directory, cap displayed output, and do not scan an entire decompiled application tree when a package subtree is known.",
      "When a tool is needed, call it in the current response without narrating a future call. Never output phrases such as 'Casting the command now' instead of a tool call.",
      "After a nonzero exit, inspect the error and change the command. Do not repeat an unchanged failed command.",
    ].join("\n"));
  }
  return sections.join("\n\n");
}
