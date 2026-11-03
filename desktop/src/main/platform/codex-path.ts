import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { compareCodexVersions } from "./desktop-platform";

export function readCodexVersion(executablePath: string): string | undefined {
  if (!existsSync(executablePath)) return undefined;
  try {
    const result = spawnSync(executablePath, ["--version"], {
      encoding: "utf8", windowsHide: true, timeout: 10_000,
    });
    if (result.status !== 0) return undefined;
    return /\bcodex-cli\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?)/.exec(result.stdout)?.[1];
  } catch {
    return undefined;
  }
}

export function resolveSystemCodexPath(): string | undefined {
  try {
    const windows = process.platform === "win32";
    const result = spawnSync(windows ? "where.exe" : "which", windows ? ["codex"] : ["-a", "codex"], {
      encoding: "utf8", windowsHide: true, timeout: 10_000,
    });
    if (result.status !== 0) return undefined;
    return selectCodexExecutable(result.stdout.split(/\r?\n/));
  } catch {
    return undefined;
  }
}

export function selectCodexExecutable(
  commandPaths: string[],
  readVersion: (executable: string) => string | undefined = readCodexVersion,
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): string | undefined {
  const candidates = commandPaths.map((entry) => entry.trim()).filter(Boolean).flatMap((entry) => {
    if (platform !== "win32" || entry.toLowerCase().endsWith(".exe")) return [entry];
    if (path.win32.basename(entry).toLowerCase() !== "codex.cmd") return [];
    const npmModules = path.win32.join(path.win32.dirname(entry), "node_modules", "@openai");
    const platformPackage = arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
    const triple = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    // npm can nest or hoist the platform package. Spawn the native binary,
    // since Windows cannot execute npm's shell wrappers without a shell.
    return [
      path.win32.join(npmModules, "codex", "node_modules", "@openai", platformPackage, "vendor", triple, "bin", "codex.exe"),
      path.win32.join(npmModules, platformPackage, "vendor", triple, "bin", "codex.exe"),
    ];
  });
  let selected: { executable: string; version: string } | undefined;
  for (const executable of new Set(candidates)) {
    const version = readVersion(executable);
    if (version && (!selected || compareCodexVersions(version, selected.version) > 0)) {
      selected = { executable, version };
    }
  }
  return selected?.executable;
}
