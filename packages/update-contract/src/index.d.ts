export type UpdatePlatform = "windows" | "macos" | "android" | "ios";
export type DesktopUpdatePlatform = "windows" | "macos";
export type MobileUpdatePlatform = "android" | "ios";

export interface DesktopUpdate {
  platform: DesktopUpdatePlatform;
  version: string;
  architecture: string;
  downloadUrl: string;
  feedUrl: string;
  metadataUrl: string;
  bytes: number;
  sha256: string;
  releaseNotes: string;
}

export interface AndroidUpdate {
  platform: "android";
  version: string;
  versionCode: number;
  downloadUrl: string;
  bytes: number;
  sha256: string;
  releaseNotes: string;
}

export interface IosUpdate {
  platform: "ios";
  version: string;
  buildNumber: string;
  storeUrl: string;
  releaseNotes: string;
}

export type MobileUpdate = AndroidUpdate | IosUpdate;
export type PlatformUpdate = DesktopUpdate | MobileUpdate;

export interface UpdateManifest {
  schemaVersion: 2;
  publishedAt: string;
  platforms: Partial<Record<UpdatePlatform, PlatformUpdate>>;
}

export const updatePlatforms: readonly UpdatePlatform[];
export function parseUpdateManifest(value: unknown): UpdateManifest;
export function parseUpdateForPlatform(value: unknown, platform: "windows" | "macos"): DesktopUpdate;
export function parseUpdateForPlatform(value: unknown, platform: "android"): AndroidUpdate;
export function parseUpdateForPlatform(value: unknown, platform: "ios"): IosUpdate;
export function parseUpdateForPlatform(value: unknown, platform: UpdatePlatform): PlatformUpdate;
export function compareVersions(left: string, right: string): number;
export function compareBuildNumbers(left: string, right: string): number;
export function isDesktopUpdatePlatform(value: unknown): value is DesktopUpdatePlatform;
export function isMobileUpdatePlatform(value: unknown): value is MobileUpdatePlatform;
