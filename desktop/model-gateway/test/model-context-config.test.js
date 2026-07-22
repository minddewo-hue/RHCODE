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
  assert.equal(config.models.size, 55);
  assert.deepEqual(contextPair(config, "gemma-4-31b-it-uncensored-bf16"), [131_072, 131_072]);
  assert.deepEqual(contextPair(config, "gemma4-31b-uncensored-bf16-256k"), [262_144, 262_144]);
  assert.deepEqual(contextPair(config, "MiniMax-M2.7"), [204_800, 204_800]);
  assert.deepEqual(contextPair(config, "MiniMax-M3"), [524_288, 1_048_576]);
  assert.deepEqual(contextPair(config, "k3"), [262_144, 1_048_576]);
  assert.deepEqual(contextPair(config, "kimi-for-coding"), [262_144, 262_144]);
  assert.deepEqual(contextPair(config, "grok-latest"), [131_072, 1_000_000]);
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

function contextPair(config, id) {
  const entry = config.models.get(id);
  assert.ok(entry, `missing model context entry for ${id}`);
  return [entry.contextWindow, entry.maxContextWindow];
}
