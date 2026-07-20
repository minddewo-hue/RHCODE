import assert from "node:assert/strict";
import test from "node:test";
import {
  buildControlUrl,
  normalizeAccessKey,
  normalizeControlHost,
  normalizeControlPort,
} from "../src/auth/control-access";

test("normalizes private desktop IP and port fields", () => {
  assert.equal(normalizeControlHost(" 192.168.11.103 "), "192.168.11.103");
  assert.equal(normalizeControlHost("desktop.local"), "desktop.local");
  assert.equal(normalizeControlHost("[::1]"), "::1");
  assert.equal(normalizeControlPort("8790"), 8790);
  assert.equal(buildControlUrl("192.168.11.103", "8790"), "http://192.168.11.103:8790");
  assert.equal(buildControlUrl("::1", 8790), "http://[::1]:8790");
});

test("rejects combined URLs, public addresses, and invalid ports", () => {
  assert.throws(() => normalizeControlHost("http://192.168.1.20:8790"), /不要包含协议/);
  assert.throws(() => normalizeControlHost("control.example.test"), /同一局域网/);
  assert.throws(() => normalizeControlHost("192.168.1.999"), /同一局域网/);
  assert.throws(() => normalizeControlPort("0"), /1 到 65535/);
  assert.throws(() => normalizeControlPort("8790.5"), /1 到 65535/);
});

test("accepts only the desktop-generated access KEY format", () => {
  const key = `rhzy_${"A".repeat(43)}`;
  assert.equal(normalizeAccessKey(`  ${key}  `), key);
  assert.throws(() => normalizeAccessKey("  "), /桌面端生成的 KEY/);
  assert.throws(() => normalizeAccessKey("invalid-legacy-credential"), /重新复制/);
});
