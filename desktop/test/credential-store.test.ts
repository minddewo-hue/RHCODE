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
      faker: { api_key_env: "TEST_FAKER_KEY" },
      local: { protocol: "responses" },
    },
  }));
  context.after(() => {
    delete process.env.TEST_FAKER_KEY;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const encryption = {
    isAvailable: () => true,
    encrypt: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
    decrypt: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, ""),
  };
  const store = new ProviderCredentialStore(root, storagePath, encryption);
  store.set("faker", "provider-secret-value");

  assert.deepEqual(store.status(), {
    encryptionAvailable: true,
    providers: [{ providerId: "faker", configured: true, source: "secure_store" }],
  });
  assert.doesNotMatch(fs.readFileSync(storagePath, "utf8"), /provider-secret-value/);
  delete process.env.TEST_FAKER_KEY;
  store.applyToEnvironment();
  assert.equal(process.env.TEST_FAKER_KEY, "provider-secret-value");

  store.set("faker", "");
  assert.equal(process.env.TEST_FAKER_KEY, undefined);
  assert.equal(store.status().providers[0]?.configured, false);
});
