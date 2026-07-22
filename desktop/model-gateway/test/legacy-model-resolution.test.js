import assert from "node:assert/strict";
import test from "node:test";
import { resolveRequestedModel } from "../src/gateway.js";

function model(id, upstreamModel) {
  return { id, routes: [{ upstreamModel }] };
}

test("resolves unique legacy bare and stale-prefixed model names", () => {
  const current = model("provider-5/gpt-5.6-sol", "gpt-5.6-sol");
  const models = new Map([
    [current.id, current],
    ["provider-4/gemma-4-34b", model("provider-4/gemma-4-34b", "gemma-4-34b")],
  ]);

  assert.equal(resolveRequestedModel(models, current.id), current);
  assert.equal(resolveRequestedModel(models, "gpt-5.6-sol"), current);
  assert.equal(resolveRequestedModel(models, "removed-provider/gpt-5.6-sol"), current);
  assert.equal(resolveRequestedModel(models, "missing-model"), null);
});

test("refuses ambiguous legacy model names", () => {
  const models = new Map([
    ["provider-2/shared-model", model("provider-2/shared-model", "shared-model")],
    ["provider-5/shared-model", model("provider-5/shared-model", "shared-model")],
  ]);

  assert.equal(resolveRequestedModel(models, "shared-model"), null);
  assert.equal(resolveRequestedModel(models, "removed-provider/shared-model"), null);
});
