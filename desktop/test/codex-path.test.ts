import assert from "node:assert/strict";
import test from "node:test";
import { selectCodexExecutable } from "../src/main/platform/codex-path.js";

test("Windows uses the upgraded npm core even when an older standalone install appears first", () => {
  const standalone = "C:\\Standalone\\codex.exe";
  const npmBinary = "C:\\Program Files\\node\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
  const versions = new Map([[standalone, "0.159.2"], [npmBinary, "0.166.0"]]);
  const probed: string[] = [];
  const selected = selectCodexExecutable([
    standalone, "C:\\Program Files\\node\\codex", "C:\\Program Files\\node\\codex.cmd", "",
  ], (executable) => {
    probed.push(executable);
    return versions.get(executable);
  }, "win32", "x64");
  assert.equal(selected, npmBinary);
  assert.ok(probed.every((executable) => executable.endsWith(".exe")));
});

test("supports hoisted npm platform packages on Windows ARM64", () => {
  const npmBinary = "C:\\npm\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe";
  assert.equal(selectCodexExecutable([" C:\\npm\\codex.cmd "], (executable) =>
    executable === npmBinary ? "0.166.0" : undefined, "win32", "arm64"), npmBinary);
});

test("ignores broken installations and keeps PATH order for equal versions", () => {
  const paths = ["C:\\broken\\codex.exe", "C:\\first\\codex.exe", "C:\\second\\codex.exe"];
  assert.equal(selectCodexExecutable(paths, (executable) =>
    executable === paths[0] ? undefined : "0.166.0", "win32", "x64"), paths[1]);
  assert.equal(selectCodexExecutable(paths, () => undefined, "win32", "x64"), undefined);
});

test("selects the newest executable across Unix PATH entries", () => {
  const versions = new Map([["/usr/bin/codex", "0.163.0"], ["/opt/bin/codex", "0.166.0"]]);
  for (const platform of ["linux", "darwin"] as const) {
    assert.equal(selectCodexExecutable([...versions.keys()], (executable) => versions.get(executable), platform), "/opt/bin/codex");
  }
});
