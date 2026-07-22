import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GatewayModule, resolveGatewayEnvPath, selectGatewayRoot } from "../src/main/gateway-module";

test("resolves the source desktop environment outside model-gateway", () => {
  const desktopRoot = path.join(os.tmpdir(), "rhzycode-desktop");
  assert.equal(
    resolveGatewayEnvPath(path.join(desktopRoot, "model-gateway")),
    path.join(desktopRoot, ".env"),
  );
});

test("keeps packaged or external gateway environments inside their root", () => {
  const gatewayRoot = path.join(os.tmpdir(), "rhzycode-resources", "gateway");
  assert.equal(resolveGatewayEnvPath(gatewayRoot), path.join(gatewayRoot, ".env"));
});

test("prefers the desktop config and falls back to the legacy gateway layout", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-gateway-layout-"));
  const desktopRoot = path.join(root, "desktop");
  const legacyRoot = path.join(desktopRoot, "model-gateway");
  const packagedRoot = path.join(root, "resources", "gateway");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.mkdirSync(packagedRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, "gateway.config.json"), "{}", "utf8");
  fs.writeFileSync(path.join(packagedRoot, "gateway.config.json"), "{}", "utf8");

  assert.equal(selectGatewayRoot([desktopRoot, legacyRoot, packagedRoot]), legacyRoot);
  fs.writeFileSync(path.join(desktopRoot, "gateway.config.json"), "{}", "utf8");
  assert.equal(selectGatewayRoot([desktopRoot, legacyRoot, packagedRoot]), desktopRoot);
});

test("writes configured runtime and maximum contexts to the Codex catalog", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-gemma-catalog-"));
  fs.copyFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "codex-model-catalog.json"),
    path.join(root, "codex-model-catalog.json"),
  );
  fs.copyFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "model-context-windows.json"),
    path.join(root, "model-context-windows.json"),
  );
  fs.writeFileSync(path.join(root, "gateway.config.json"), JSON.stringify({
    providers: {
      "provider-2": {
        base_url: "http://127.0.0.1:9/v1",
        protocol: "responses",
      },
    },
    models: {
      "provider-2/gemma-4-31b-it-uncensored-bf16": {
        provider: "provider-2",
        upstream_model: "gemma-4-31b-it-uncensored-bf16",
      },
      "provider-2/MiniMax-M3": {
        provider: "provider-2",
        upstream_model: "MiniMax-M3",
      },
      "provider-2/gpt-5.4": {
        provider: "provider-2",
        upstream_model: "gpt-5.4",
      },
    },
  }));

  const gateway = new GatewayModule(root);
  context.after(async () => {
    await gateway.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await gateway.start();

  const catalog = JSON.parse(fs.readFileSync(gateway.getCatalogPath(), "utf8")) as {
    models: Array<Record<string, unknown>>;
  };
  const gemma = catalog.models.find((model) =>
    model.slug === "provider-2/gemma-4-31b-it-uncensored-bf16");
  assert.equal(gemma?.context_window, 131_072);
  assert.equal(gemma?.max_context_window, 131_072);
  assert.equal(gemma?.default_reasoning_level, null);
  assert.deepEqual(gemma?.supported_reasoning_levels, []);
  const minimax = catalog.models.find((model) => model.slug === "provider-2/MiniMax-M3");
  assert.equal(minimax?.context_window, 524_288);
  assert.equal(minimax?.max_context_window, 1_048_576);
  assert.equal(minimax?.default_reasoning_level, null);
  assert.deepEqual(minimax?.supported_reasoning_levels, []);
  const gpt = catalog.models.find((model) => model.slug === "provider-2/gpt-5.4");
  assert.equal(gpt?.default_reasoning_level, "medium");
  assert.deepEqual(
    (gpt?.supported_reasoning_levels as Array<{ effort: string }>).map((option) => option.effort),
    ["low", "medium", "high", "xhigh"],
  );
});
