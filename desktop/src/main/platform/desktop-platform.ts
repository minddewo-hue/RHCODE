import type { HostSummary } from "@rhzycode/protocol";
import type { DesktopUpdatePlatform } from "@rhzycode/update-contract";

export type DesktopHostPlatform = Exclude<HostSummary["platform"], "cloud">;

export function desktopHostPlatform(platform: NodeJS.Platform = process.platform): DesktopHostPlatform {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
}

export function desktopUpdatePlatform(
  platform: NodeJS.Platform = process.platform,
): DesktopUpdatePlatform | null {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return null;
}

export function bundledCodexExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "codex.exe" : "codex";
}

export function shouldQuitWhenAllWindowsClose(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "darwin";
}
