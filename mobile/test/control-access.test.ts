import assert from "node:assert/strict";
import test from "node:test";
import {
  controlServiceUrl,
  defaultTransferServerUrl,
  normalizeAccessKey,
} from "../src/auth/control-access";

test("uses only the public transfer service for KEY-only access", () => {
  assert.equal(defaultTransferServerUrl, "http://218.201.210.211:8000");
  assert.equal(controlServiceUrl, "http://218.201.210.211:8000/control");
});

test("accepts only the desktop-generated access KEY format", () => {
  const key = `rhzy_${"A".repeat(43)}`;
  assert.equal(normalizeAccessKey(`  ${key}  `), key);
  assert.throws(() => normalizeAccessKey("  "), /桌面端生成的 KEY/);
  assert.throws(() => normalizeAccessKey("invalid-legacy-credential"), /重新复制/);
});
