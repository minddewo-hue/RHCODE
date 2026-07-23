import assert from "node:assert/strict";
import test from "node:test";
import {
  bundledCodexExecutable,
  desktopHostPlatform,
  desktopUpdatePlatform,
  shouldQuitWhenAllWindowsClose,
} from "../src/main/platform/desktop-platform.js";

test("maps Node desktop platforms to protocol and update platform names", () => {
  assert.equal(desktopHostPlatform("win32"), "windows");
  assert.equal(desktopHostPlatform("darwin"), "macos");
  assert.equal(desktopHostPlatform("linux"), "linux");
  assert.equal(desktopUpdatePlatform("win32"), "windows");
  assert.equal(desktopUpdatePlatform("darwin"), "macos");
  assert.equal(desktopUpdatePlatform("linux"), null);
});

test("uses native executable and application lifecycle conventions", () => {
  assert.equal(bundledCodexExecutable("win32"), "codex.exe");
  assert.equal(bundledCodexExecutable("darwin"), "codex");
  assert.equal(shouldQuitWhenAllWindowsClose("win32"), true);
  assert.equal(shouldQuitWhenAllWindowsClose("darwin"), false);
});
