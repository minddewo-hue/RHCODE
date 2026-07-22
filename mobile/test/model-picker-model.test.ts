import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteModelOption } from "@rhzycode/protocol";
import { groupRemoteModels, remoteModelReasoningEfforts } from "../src/components/model-picker-model";

function model(modelId: string, displayName: string, extra: Partial<RemoteModelOption> = {}): RemoteModelOption {
  return {
    id: modelId,
    model: modelId,
    displayName,
    description: "Test model",
    defaultReasoningEffort: "medium",
    ...extra,
  };
}

test("groups remote models using desktop supplied source metadata", () => {
  const groups = groupRemoteModels([
    model("domestic/minimax-m2.7", "Legacy - MiniMax-M2.7", { source: "Domestic", sourceModelName: "minimax-m2.7" }),
    model("sub2api/gpt-5.4-mini", "Codex - gpt-5.4-mini", { source: "Sub2API", sourceModelName: "gpt-5.4-mini" }),
    model("domestic/minimax-m2.1", "Legacy - MiniMax-M2.1", { source: "Domestic", sourceModelName: "minimax-m2.1" }),
    model("sub2api/gpt-5.4", "Codex - gpt-5.4", { source: "Sub2API", sourceModelName: "gpt-5.4" }),
  ]);

  assert.deepEqual(groups.map((group) => ({
    source: group.source,
    models: group.models.map((entry) => entry.sourceModelName),
  })), [
    { source: "Domestic", models: ["minimax-m2.1", "minimax-m2.7"] },
    { source: "Sub2API", models: ["gpt-5.4", "gpt-5.4-mini"] },
  ]);
});

test("groups models from older desktops by display and model prefixes", () => {
  const groups = groupRemoteModels([
    model("provider-b/model-10", "Provider B - model-10"),
    model("provider-b/model-2", "Provider B - model-2"),
    model("provider-a/model-1", "Model One"),
  ]);

  assert.deepEqual(groups.map((group) => ({
    source: group.source,
    models: group.models.map((entry) => entry.sourceModelName),
  })), [
    { source: "Provider B", models: ["model-2", "model-10"] },
    { source: "provider-a", models: ["Model One"] },
  ]);
});

test("preserves an explicitly empty remote reasoning effort list", () => {
  assert.deepEqual(remoteModelReasoningEfforts(model(
    "provider/gemma-model",
    "Gemma model",
    { reasoningEfforts: [] },
  )), []);
});

test("uses declared reasoning efforts and supports older desktop metadata", () => {
  assert.deepEqual(remoteModelReasoningEfforts(model(
    "provider/gpt-model",
    "GPT model",
    { reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  )), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(remoteModelReasoningEfforts(model(
    "provider/legacy-model",
    "Legacy model",
  )), ["medium"]);
});
