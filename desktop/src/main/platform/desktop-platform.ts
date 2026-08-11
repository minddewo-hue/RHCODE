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

export function preferredCodexPath(
  bundledPath: string,
  bundledExists: boolean,
  configuredPath?: string,
): string | undefined {
  if (bundledExists) return bundledPath;
  return configuredPath?.trim() || undefined;
}

export function shouldQuitWhenAllWindowsClose(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "darwin";
}

/**
 * Electron 43 is not reliable with the VMware Wayland compositor used by the
 * supported Ubuntu workstation. X11 remains available through Xwayland and
 * provides stable pointer input there. Set RHZYCODE_OZONE_PLATFORM=wayland to
 * opt into native Wayland on hosts where it has been validated.
 */
export function linuxOzonePlatform(
  platform: NodeJS.Platform = process.platform,
  configuredPlatform = process.env.RHZYCODE_OZONE_PLATFORM,
): string | undefined {
  if (platform !== "linux") return undefined;
  return configuredPlatform?.trim() || "x11";
}
