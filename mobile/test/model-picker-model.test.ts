import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteModelOption } from "@rhzycode/protocol";
import {
  groupRemoteModels,
  preferredRemoteModel,
  remoteModelReasoningEfforts,
} from "../src/components/model-picker-model";

function model(modelId: string, displayName: string, extra: Partial<RemoteModelOption> = {}): RemoteModelOption {
  return {
    id: modelId,
    model: modelId,
    displayName,
    description: "Test model",
    defaultReasoningEffort: "medium",
    source: "Test provider",
    sourceModelName: modelId,
    reasoningEfforts: ["medium"],
    isDefault: false,
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

test("preserves an explicitly empty remote reasoning effort list", () => {
  assert.deepEqual(remoteModelReasoningEfforts(model(
    "provider/gemma-model",
    "Gemma model",
    { reasoningEfforts: [] },
  )), []);
});

test("uses only reasoning efforts declared by the desktop", () => {
  assert.deepEqual(remoteModelReasoningEfforts(model(
    "provider/gpt-model",
    "GPT model",
    { reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  )), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(remoteModelReasoningEfforts(model(
    "provider/plain-model",
    "Plain model",
    { reasoningEfforts: [] },
  )), []);
});

test("uses the last available manual model as the next conversation default", () => {
  const models = [
    model("provider/default", "Default", { isDefault: true }),
    model("provider/manual", "Manual"),
  ];

  assert.equal(preferredRemoteModel(models, "provider/manual"), "provider/manual");
  assert.equal(preferredRemoteModel(models, "provider/removed"), "provider/default");
  assert.equal(preferredRemoteModel([], "provider/manual"), "");
});
