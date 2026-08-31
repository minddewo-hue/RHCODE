import type { HostSummary } from "@rhzycode/protocol";
import type { DesktopUpdatePlatform } from "@rhzycode/update-contract";

export type DesktopHostPlatform = Exclude<HostSummary["platform"], "cloud">;

export interface HardwareAccelerationPolicy {
  disabled: boolean;
  source: "default" | "environment" | "vmware";
}

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

export function shouldUseElectronNetFetch(
  platform: NodeJS.Platform = process.platform,
): boolean {
  // Electron 43's Linux network service retains deleted 2 MiB Chromium shared-
  // memory files after net.fetch requests. Node fetch avoids that browser-process leak.
  return platform !== "linux";
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

export function hardwareAccelerationPolicy(
  platform: NodeJS.Platform = process.platform,
  configuredValue = process.env.RHZYCODE_DISABLE_HARDWARE_ACCELERATION,
  hostIdentity = "",
): HardwareAccelerationPolicy {
  const configured = configuredValue?.trim();
  if (configured === "1" || configured === "0") {
    return { disabled: configured === "1", source: "environment" };
  }
  if (platform === "linux" && /\bvmware\b/i.test(hostIdentity)) {
    return { disabled: true, source: "vmware" };
  }
  return { disabled: false, source: "default" };
}
