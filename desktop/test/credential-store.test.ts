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
    providers: [{ providerId: "sub2api", configured: true, source: "secure_store" }],
  });
  assert.doesNotMatch(fs.readFileSync(storagePath, "utf8"), /provider-secret-value/);
  delete process.env.TEST_SUB2API_KEY;
  store.applyToEnvironment();
  assert.equal(process.env.TEST_SUB2API_KEY, "provider-secret-value");

  store.set("sub2api", "");
  assert.equal(process.env.TEST_SUB2API_KEY, undefined);
  assert.equal(store.status().providers[0]?.configured, false);
});
