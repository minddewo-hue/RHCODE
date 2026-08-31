import assert from "node:assert/strict";
import test from "node:test";
import {
  bundledCodexExecutable,
  desktopHostPlatform,
  desktopUpdatePlatform,
  hardwareAccelerationPolicy,
  linuxOzonePlatform,
  preferredCodexPath,
  shouldQuitWhenAllWindowsClose,
  shouldUseElectronNetFetch,
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

test("uses Node fetch on Linux to avoid Chromium shared-memory retention", () => {
  assert.equal(shouldUseElectronNetFetch("linux"), false);
  assert.equal(shouldUseElectronNetFetch("win32"), true);
  assert.equal(shouldUseElectronNetFetch("darwin"), true);
});

test("uses the stable X11 backend for Linux unless the operator overrides it", () => {
  assert.equal(linuxOzonePlatform("linux"), "x11");
  assert.equal(linuxOzonePlatform("linux", " wayland "), "wayland");
  assert.equal(linuxOzonePlatform("win32"), undefined);
});

test("disables hardware acceleration by default on Linux VMware hosts", () => {
  assert.deepEqual(
    hardwareAccelerationPolicy("linux", undefined, "VMware, Inc. VMware Virtual Platform"),
    { disabled: true, source: "vmware" },
  );
  assert.deepEqual(hardwareAccelerationPolicy("linux", undefined, "Dell Inc."), {
    disabled: false,
    source: "default",
  });
  assert.deepEqual(hardwareAccelerationPolicy("win32", undefined, "VMware, Inc."), {
    disabled: false,
    source: "default",
  });
});

test("allows the hardware acceleration environment setting to override VMware detection", () => {
  assert.deepEqual(hardwareAccelerationPolicy("linux", "1", "Dell Inc."), {
    disabled: true,
    source: "environment",
  });
  assert.deepEqual(hardwareAccelerationPolicy("linux", "0", "VMware, Inc."), {
    disabled: false,
    source: "environment",
  });
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
