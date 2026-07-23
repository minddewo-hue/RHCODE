import {
  compareBuildNumbers,
  compareVersions,
  parseUpdateForPlatform,
  type AndroidUpdate,
  type IosUpdate,
  type MobileUpdate,
  type MobileUpdatePlatform,
} from "@rhzycode/update-contract";

export { compareVersions } from "@rhzycode/update-contract";
export type { AndroidUpdate, IosUpdate, MobileUpdate, MobileUpdatePlatform } from "@rhzycode/update-contract";

export const defaultUpdateManifestUrl = "https://minio.gshbzw.com/wxfile/rhzycode/version.json";

export type MobileUpdateStatus =
  | { state: "idle"; latest: null; error: null }
  | { state: "checking"; latest: MobileUpdate | null; error: null }
  | { state: "current"; latest: MobileUpdate; error: null }
  | { state: "available"; latest: MobileUpdate; error: null }
  | { state: "downloading"; latest: AndroidUpdate; error: null }
  | { state: "awaiting_permission"; latest: AndroidUpdate; error: null }
  | { state: "installing"; latest: AndroidUpdate; error: null }
  | { state: "error"; latest: MobileUpdate | null; error: string };

export const initialMobileUpdateStatus: MobileUpdateStatus = {
  state: "idle",
  latest: null,
  error: null,
};

type MobileUpdateOptions = {
  manifestUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  currentVersionCode?: number;
  currentBuildNumber?: string;
};

type CheckedMobileUpdateStatus<Update extends MobileUpdate = MobileUpdate> =
  | { state: "current"; latest: Update; error: null }
  | { state: "available"; latest: Update; error: null };

export function fetchMobileUpdate(
  currentVersion: string,
  options: MobileUpdateOptions & { platform: "android" },
): Promise<CheckedMobileUpdateStatus<AndroidUpdate>>;
export function fetchMobileUpdate(
  currentVersion: string,
  options: MobileUpdateOptions & { platform: "ios" },
): Promise<CheckedMobileUpdateStatus<IosUpdate>>;
export function fetchMobileUpdate(
  currentVersion: string,
  options: MobileUpdateOptions & { platform: MobileUpdatePlatform },
): Promise<CheckedMobileUpdateStatus>;
export async function fetchMobileUpdate(
  currentVersion: string,
  options: MobileUpdateOptions & { platform: MobileUpdatePlatform },
): Promise<CheckedMobileUpdateStatus> {
  const manifestUrl = options.manifestUrl || defaultUpdateManifestUrl;
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 8_000);
  try {
    const response = await fetchImpl(manifestUrl, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Update service returned HTTP ${response.status}.`);
    const latest = parseMobileUpdate(await response.json(), options.platform);
    return {
      state: isMobileUpdateAvailable(latest, currentVersion, options) ? "available" : "current",
      latest,
      error: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseMobileUpdate(value: unknown, platform: MobileUpdatePlatform): MobileUpdate {
  return platform === "android"
    ? parseUpdateForPlatform(value, "android")
    : parseUpdateForPlatform(value, "ios");
}

function isMobileUpdateAvailable(
  latest: MobileUpdate,
  currentVersion: string,
  options: { currentVersionCode?: number; currentBuildNumber?: string },
): boolean {
  if (latest.platform === "android") {
    const currentVersionCode = Number(options.currentVersionCode);
    return Number.isInteger(currentVersionCode) && currentVersionCode > 0
      ? latest.versionCode > currentVersionCode
      : compareVersions(latest.version, currentVersion) > 0;
  }

  const versionComparison = compareVersions(latest.version, currentVersion);
  if (versionComparison !== 0) return versionComparison > 0;
  return options.currentBuildNumber
    ? compareBuildNumbers(latest.buildNumber, options.currentBuildNumber) > 0
    : false;
}
