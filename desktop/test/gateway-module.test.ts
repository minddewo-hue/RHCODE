import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GatewayModule, resolveGatewayEnvPath } from "../src/main/gateway-module";

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

test("writes the targeted Gemma model with a 128K runtime context", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-gemma-catalog-"));
  fs.copyFileSync(
    path.resolve("codex-model-catalog.json"),
    path.join(root, "codex-model-catalog.json"),
  );
  fs.writeFileSync(path.join(root, "gateway.config.json"), JSON.stringify({
    providers: {
      "provider-2": {
        base_url: "http://127.0.0.1:9/v1",
        protocol: "chat_completions",
      },
    },
    models: {
      "provider-2/gemma-4-31b-it-uncensored-bf16": {
        provider: "provider-2",
        upstream_model: "gemma-4-31b-it-uncensored-bf16",
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
});
