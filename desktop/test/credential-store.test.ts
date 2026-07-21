import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderCredentialStore } from "../src/main/credential-store.js";

test("stores encrypted provider credentials without exposing plaintext status", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-credentials-"));
  const storagePath = path.join(root, "state", "credentials.json");
  fs.writeFileSync(path.join(root, "gateway.config.json"), JSON.stringify({
    providers: {
      sub2api: { api_key_env: "TEST_SUB2API_KEY" },
      local: { protocol: "responses" },
    },
  }));
  context.after(() => {
    delete process.env.TEST_SUB2API_KEY;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const encryption = {
    isAvailable: () => true,
    encrypt: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
    decrypt: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, ""),
  };
  const store = new ProviderCredentialStore(root, storagePath, encryption);
  store.set("sub2api", "provider-secret-value");

  assert.deepEqual(store.status(), {
    encryptionAvailable: true,
    providers: [{
      providerId: "sub2api",
      name: "sub2api",
      baseUrl: "",
      protocol: "responses",
      detectedProtocol: "responses",
      models: [],
      custom: false,
      configured: true,
      source: "secure_store",
    }],
  });
  assert.doesNotMatch(fs.readFileSync(storagePath, "utf8"), /provider-secret-value/);
  delete process.env.TEST_SUB2API_KEY;
  store.applyToEnvironment();
  assert.equal(process.env.TEST_SUB2API_KEY, "provider-secret-value");

  store.set("sub2api", "");
  assert.equal(process.env.TEST_SUB2API_KEY, undefined);
  assert.equal(store.status().providers[0]?.configured, false);
});

test("deletes a built-in provider configuration and keeps it removed after restart", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-provider-delete-"));
  const storagePath = path.join(root, "state", "credentials.json");
  fs.writeFileSync(path.join(root, "gateway.config.json"), JSON.stringify({
    providers: {
      sub2api: {
        base_url: "https://model.example/v1",
        protocol: "responses",
        api_key_env: "TEST_DELETED_PROVIDER_KEY",
      },
    },
    models: {
      "sub2api/model": { provider: "sub2api", upstream_model: "model" },
    },
  }));
  context.after(() => {
    delete process.env.TEST_DELETED_PROVIDER_KEY;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const encryption = {
    isAvailable: () => true,
    encrypt: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
    decrypt: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, ""),
  };
  const store = new ProviderCredentialStore(root, storagePath, encryption);
  store.set("sub2api", "provider-secret");
  store.remove("sub2api");

  assert.equal(store.status().providers.some((provider) => provider.providerId === "sub2api"), false);
  assert.equal(store.getApiKey("sub2api"), "");
  const runtime = JSON.parse(fs.readFileSync(store.getRuntimeConfigPath(), "utf8"));
  assert.equal(runtime.providers.sub2api, undefined);
  assert.equal(runtime.models["sub2api/model"], undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(storagePath, "utf8")).removedProviders, ["sub2api"]);

  const restored = new ProviderCredentialStore(root, storagePath, encryption);
  assert.equal(restored.status().providers.some((provider) => provider.providerId === "sub2api"), false);
});

test("merges custom providers into a runtime config and preserves encrypted keys", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-provider-config-"));
  const storagePath = path.join(root, "state", "credentials.json");
  fs.writeFileSync(path.join(root, "gateway.config.json"), JSON.stringify({
    providers: {
      built_in: {
        base_url: "https://built-in.example/v1",
        protocol: "responses",
        api_key_env: "TEST_BUILT_IN_KEY",
      },
    },
    models: {
      "built_in/model": { provider: "built_in", upstream_model: "model" },
    },
  }));
  context.after(() => {
    delete process.env.RHZYCODE_LLM_CLAUDE_API_KEY;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const encryption = {
    isAvailable: () => true,
    encrypt: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
    decrypt: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, ""),
  };
  const store = new ProviderCredentialStore(root, storagePath, encryption);
  store.upsert({
    providerId: "claude",
    name: "Claude relay",
    baseUrl: "https://claude.example/v1",
    protocol: "auto",
    detectedProtocol: "anthropic_messages",
    models: ["claude-sonnet-test"],
  }, "claude-secret");

  const runtime = JSON.parse(fs.readFileSync(store.getRuntimeConfigPath(), "utf8"));
  assert.equal(runtime.providers.claude.protocol, "anthropic_messages");
  assert.equal(runtime.providers.claude.base_url, "https://claude.example/v1");
  assert.equal(runtime.models["claude/claude-sonnet-test"].upstream_model, "claude-sonnet-test");
  assert.doesNotMatch(fs.readFileSync(storagePath, "utf8"), /claude-secret/);
  assert.equal(store.status().providers.find((provider) => provider.providerId === "claude")?.custom, true);

  delete process.env.RHZYCODE_LLM_CLAUDE_API_KEY;
  store.applyToEnvironment();
  assert.equal(process.env.RHZYCODE_LLM_CLAUDE_API_KEY, "claude-secret");
  store.remove("claude");
  assert.equal(store.status().providers.some((provider) => provider.providerId === "claude"), false);
});

test("migrates an auto-configured Faker gateway from Responses to Chat Completions", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-faker-protocol-"));
  const storagePath = path.join(root, "state", "credentials.json");
  fs.writeFileSync(path.join(root, "gateway.config.json"), JSON.stringify({
    providers: {},
    models: {},
  }));
  context.after(() => {
    delete process.env.RHZYCODE_LLM_FAKER_API_KEY;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const encryption = {
    isAvailable: () => true,
    encrypt: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
    decrypt: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, ""),
  };
  const store = new ProviderCredentialStore(root, storagePath, encryption);
  store.upsert({
    providerId: "faker",
    name: "Faker Model",
    baseUrl: "https://faker-model.rhzy.ai/v1",
    protocol: "auto",
    detectedProtocol: "responses",
    models: [],
  }, "fm-test-key");

  assert.equal(
    store.status().providers.find((provider) => provider.providerId === "faker")?.detectedProtocol,
    "chat_completions",
  );
  const runtime = JSON.parse(fs.readFileSync(store.getRuntimeConfigPath(), "utf8"));
  assert.equal(runtime.providers.faker.protocol, "chat_completions");
});
