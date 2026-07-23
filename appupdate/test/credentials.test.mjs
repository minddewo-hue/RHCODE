import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadMinioCredentials } from "../scripts/credentials.mjs";

const config = {
  accessKeyEnv: "TEST_MINIO_ACCESS_KEY",
  secretKeyEnv: "TEST_MINIO_SECRET_KEY",
  credentialsFile: ".minio-credentials.json",
};

test("prefers complete MinIO environment credentials", () => {
  const credentials = loadMinioCredentials({
    config,
    updateRoot: "unused",
    env: {
      TEST_MINIO_ACCESS_KEY: " access ",
      TEST_MINIO_SECRET_KEY: " secret ",
    },
  });
  assert.deepEqual(credentials, {
    accessKey: "access",
    secretKey: "secret",
    source: "environment variables",
  });
});

test("rejects a partial MinIO environment override", () => {
  assert.throws(() => loadMinioCredentials({
    config,
    updateRoot: "unused",
    env: { TEST_MINIO_ACCESS_KEY: "access" },
  }), /must be set together/);
});

test("loads an encrypted local MinIO credential record", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-minio-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, config.credentialsFile), JSON.stringify({
    version: 1,
    provider: "windows-dpapi",
    accessKeyProtected: "protected-access",
    secretKeyProtected: "protected-secret",
  }));

  const credentials = loadMinioCredentials({
    config,
    updateRoot: root,
    env: {},
    platform: "win32",
    decrypt: (value) => value.replace("protected-", ""),
  });
  assert.deepEqual(credentials, {
    accessKey: "access",
    secretKey: "secret",
    source: "the encrypted local credential store",
  });
});

test("does not use a Windows credential record on another platform", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-minio-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, config.credentialsFile), JSON.stringify({
    version: 1,
    provider: "windows-dpapi",
    accessKeyProtected: "protected-access",
    secretKeyProtected: "protected-secret",
  }));

  assert.throws(() => loadMinioCredentials({
    config,
    updateRoot: root,
    env: {},
    platform: "darwin",
  }), /Windows DPAPI/);
});
