import assert from "node:assert/strict";
import test from "node:test";
import {
  bundledCodexExecutable,
  desktopHostPlatform,
  desktopUpdatePlatform,
  linuxOzonePlatform,
  preferredCodexPath,
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

test("uses the stable X11 backend for Linux unless the operator overrides it", () => {
  assert.equal(linuxOzonePlatform("linux"), "x11");
  assert.equal(linuxOzonePlatform("linux", " wayland "), "wayland");
  assert.equal(linuxOzonePlatform("win32"), undefined);
});

test("prefers the bundled Codex binary and only falls back when it is absent", () => {
  assert.equal(
    preferredCodexPath("C:\\app\\resources\\codex\\codex.exe", true, "C:\\system\\codex.exe"),
    "C:\\app\\resources\\codex\\codex.exe",
  );
  assert.equal(
    preferredCodexPath("C:\\app\\resources\\codex\\codex.exe", false, " C:\\system\\codex.exe "),
    "C:\\system\\codex.exe",
  );
  assert.equal(preferredCodexPath("/app/codex", false), undefined);
});
