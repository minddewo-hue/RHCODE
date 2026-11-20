import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startEmbeddedGateway } from "../src/embedded.js";
import {
  applyModelContextConfig,
  loadModelContextConfig,
} from "../src/model-context-config.js";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("bundles a validated context entry for every current upstream model", () => {
  const config = loadModelContextConfig(desktopRoot);
  assert.ok(config);
  assert.deepEqual(contextPair(config, "gemma-4-31b-it-uncensored-bf16"), [131_072, 131_072]);
  assert.deepEqual(contextPair(config, "gemma4-31b-uncensored-bf16-256k"), [262_144, 262_144]);
  assert.deepEqual(contextPair(config, "gemma4-31b-uncensored-bf16-256k-seq4"), [262_144, 262_144]);
  assert.deepEqual(contextPair(config, "MiniMax-M2.7"), [204_800, 204_800]);
  assert.deepEqual(contextPair(config, "MiniMax-M3"), [524_288, 1_048_576]);
  assert.deepEqual(contextPair(config, "k3"), [262_144, 1_048_576]);
  assert.deepEqual(contextPair(config, "kimi-for-coding"), [262_144, 262_144]);
  assert.deepEqual(contextPair(config, "grok-latest"), [131_072, 1_000_000]);
  assert.deepEqual(contextPair(config, "gpt-5.4"), [1_000_000, 1_050_000]);
  assert.deepEqual(contextPair(config, "gpt-5.4-mini"), [272_000, 400_000]);
  assert.deepEqual(contextPair(config, "gpt-5.6"), [1_000_000, 1_050_000]);
  assert.deepEqual(contextPair(config, "gpt-6-astra"), [1_000_000, 1_050_000]);
  assert.deepEqual(contextPair(config, "gpt-6-luna"), [1_000_000, 1_050_000]);
  assert.deepEqual(contextPair(config, "gpt-6-sol"), [1_000_000, 1_050_000]);
  assert.deepEqual(contextPair(config, "gpt-6.1-sol"), [1_000_000, 1_050_000]);
  assert.deepEqual(contextPair(config, "gpt-6.2"), [1_000_000, 1_000_000]);
  assert.deepEqual(contextPair(config, "gpt-6.2-sol"), [1_000_000, 1_050_000]);
  assert.deepEqual(contextPair(config, "gpt-6.2-astra"), [1_000_000, 1_050_000]);
});

test("uses verified maximums without raising plan or intermediary limits", () => {
  const config = loadModelContextConfig(desktopRoot);
  config.models.set("verified", {
    contextWindow: 500_000,
    maxContextWindow: 2_000_000,
    effectiveContextWindowPercent: 90,
    verification: "official",
  });
  const verified = applyModelContextConfig({ id: "verified" }, config);
  const planLimited = applyModelContextConfig({ id: "k3" }, config);
  const intermediary = applyModelContextConfig({ id: "grok-latest" }, config);
  assert.equal(verified.contextWindow, 1_000_000);
  assert.equal(verified.maxContextWindow, 2_000_000);
  assert.equal(planLimited.contextWindow, 262_144);
  assert.equal(intermediary.contextWindow, 131_072);
});

test("matches the upstream id before using provider discovery metadata", () => {
  const config = loadModelContextConfig(desktopRoot);
  const model = {
    id: "provider-4/gemma4-31b-uncensored-bf16-256k",
    contextWindow: 16_384,
    maxContextWindow: 16_384,
    routes: [{ upstreamModel: "gemma4-31b-uncensored-bf16-256k" }],
  };

  applyModelContextConfig(model, config);

  assert.equal(model.contextWindow, 262_144);
  assert.equal(model.maxContextWindow, 262_144);
  assert.equal(model.effectiveContextWindowPercent, 90);
  assert.equal(model.contextWindowSource, "deployment_owner");
});

test("uses the conservative default only when an unknown model has no explicit window", () => {
  const config = loadModelContextConfig(desktopRoot);
  const unknown = { id: "provider/new-model", routes: [{ upstreamModel: "new-model" }] };
  const explicit = {
    id: "provider/custom-model",
    contextWindow: 65_536,
    maxContextWindow: 65_536,
    routes: [{ upstreamModel: "custom-model" }],
  };

  applyModelContextConfig(unknown, config);
  applyModelContextConfig(explicit, config);

  assert.equal(unknown.contextWindow, 131_072);
  assert.equal(unknown.contextWindowSource, "conservative_fallback");
  assert.equal(explicit.contextWindow, 65_536);
  assert.equal(explicit.maxContextWindow, 65_536);
});

test("preserves an explicit deployment context over the bundled upstream default", () => {
  const config = loadModelContextConfig(desktopRoot);
  for (const upstreamModel of ["grok-latest", "gpt-5.4"]) {
    const model = {
      id: `private/${upstreamModel}`,
      contextWindow: 64_000,
      maxContextWindow: 96_000,
      contextWindowSource: "gateway_config",
      routes: [{ upstreamModel }],
    };

    applyModelContextConfig(model, config);

    assert.equal(model.contextWindow, 64_000);
    assert.equal(model.maxContextWindow, 96_000);
    assert.equal(model.contextWindowSource, "gateway_config");
  }
});

test("supports a provider-specific entry before the shared upstream entry", () => {
  const config = loadModelContextConfig(desktopRoot);
  config.models.set("private/grok-latest", {
    contextWindow: 80_000,
    maxContextWindow: 80_000,
    effectiveContextWindowPercent: 85,
    verification: "provider_override",
  });
  const model = {
    id: "private/grok-latest",
    routes: [{ upstreamModel: "grok-latest" }],
  };

  applyModelContextConfig(model, config);

  assert.equal(model.contextWindow, 80_000);
  assert.equal(model.effectiveContextWindowPercent, 85);
  assert.equal(model.contextWindowSource, "provider_override");
});

test("applies configured values to the embedded gateway catalog", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-model-context-"));
  fs.copyFileSync(
    path.join(desktopRoot, "model-context-windows.json"),
    path.join(root, "model-context-windows.json"),
  );
  fs.writeFileSync(path.join(root, "gateway.config.json"), JSON.stringify({
    providers: {
      provider: {
        base_url: "http://127.0.0.1:9/v1",
        protocol: "responses",
      },
    },
    models: {
      "provider/grok-latest": {
        provider: "provider",
        upstream_model: "grok-latest",
      },
      "provider/grok-4.3": {
        provider: "provider",
        upstream_model: "grok-4.3",
      },
    },
  }));

  const gateway = await startEmbeddedGateway({ rootDir: root, port: 0 });
  context.after(async () => {
    await gateway.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const latest = gateway.models.find((model) => model.upstreamModel === "grok-latest");
  const named = gateway.models.find((model) => model.upstreamModel === "grok-4.3");
  assert.equal(latest?.contextWindow, 131_072);
  assert.equal(latest?.maxContextWindow, 1_000_000);
  assert.equal(named?.contextWindow, 1_000_000);
  assert.equal(named?.maxContextWindow, 1_000_000);
});

test("applies 1M to future models discovered when refreshing the gateway", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-model-discovery-"));
  fs.copyFileSync(
    path.join(desktopRoot, "model-context-windows.json"),
    path.join(root, "model-context-windows.json"),
  );
  fs.writeFileSync(path.join(root, "gateway.config.json"), JSON.stringify({
    providers: {
      provider: {
        base_url: "http://127.0.0.1:9/v1",
        protocol: "responses",
        model_discovery: { prefix: "provider/" },
      },
    },
  }));

  let upstreamModels = [{ id: "existing" }];
  const gateway = await startEmbeddedGateway({
    rootDir: root,
    port: 0,
    fetchImpl: async () => Response.json({ data: upstreamModels }),
  });
  context.after(async () => {
    await gateway.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  upstreamModels = [
    ...upstreamModels,
    { id: "new-long-context", context_window: 500_000, max_context_window: 2_000_000 },
    { id: "new-exact-context", context_length: 1_000_000 },
    { id: "new-small-context", max_context_window: 64_000 },
    { id: "new-unknown-context" },
  ];
  const refreshed = await gateway.refreshModels();
  assert.equal(refreshed.changed, true);
  const windows = new Map(refreshed.models.map((model) => [
    model.upstreamModel, [model.contextWindow, model.maxContextWindow],
  ]));
  assert.deepEqual(windows.get("new-long-context"), [1_000_000, 2_000_000]);
  assert.deepEqual(windows.get("new-exact-context"), [1_000_000, 1_000_000]);
  assert.deepEqual(windows.get("new-small-context"), [64_000, 64_000]);
  assert.deepEqual(windows.get("new-unknown-context"), [131_072, 131_072]);

  upstreamModels[0] = { id: "existing", max_context_window: 1_050_000 };
  const updated = await gateway.refreshModels();
  assert.equal(updated.changed, true);
  assert.equal(updated.models.find((model) => model.upstreamModel === "existing")?.contextWindow, 1_000_000);
  assert.equal((await gateway.refreshModels()).changed, false);
});

function contextPair(config, id) {
  const entry = config.models.get(id);
  assert.ok(entry, `missing model context entry for ${id}`);
  return [entry.contextWindow, entry.maxContextWindow];
}
