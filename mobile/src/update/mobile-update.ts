export const defaultUpdateManifestUrl = "http://192.168.11.103:8791/manifest.json";

export interface AndroidUpdate {
  version: string;
  versionCode: number;
  apkUrl: string;
  bytes: number;
  sha256: string;
  releaseNotes: string;
}

export type MobileUpdateStatus =
  | { state: "idle"; latest: null; error: null }
  | { state: "checking"; latest: AndroidUpdate | null; error: null }
  | { state: "current"; latest: AndroidUpdate; error: null }
  | { state: "available"; latest: AndroidUpdate; error: null }
  | { state: "downloading"; latest: AndroidUpdate; error: null }
  | { state: "awaiting_permission"; latest: AndroidUpdate; error: null }
  | { state: "installing"; latest: AndroidUpdate; error: null }
  | { state: "error"; latest: AndroidUpdate | null; error: string };

export const initialMobileUpdateStatus: MobileUpdateStatus = {
  state: "idle",
  latest: null,
  error: null,
};

export async function fetchMobileUpdate(
  currentVersion: string,
  options: {
    manifestUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<Extract<MobileUpdateStatus, { state: "current" | "available" }>> {
  const manifestUrl = options.manifestUrl || defaultUpdateManifestUrl;
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 8_000);
  try {
    const response = await fetchImpl(manifestUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Update service returned HTTP ${response.status}.`);
    const latest = parseAndroidUpdate(await response.json());
    return {
      state: compareVersions(latest.version, currentVersion) > 0 ? "available" : "current",
      latest,
      error: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function parseAndroidUpdate(value: unknown): AndroidUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Update manifest is invalid.");
  }
  const android = (value as { android?: unknown }).android;
  if (!android || typeof android !== "object" || Array.isArray(android)) {
    throw new Error("Android update metadata is unavailable.");
  }
  const candidate = android as Record<string, unknown>;
  const version = requireVersion(candidate.version);
  const versionCode = Number(candidate.versionCode);
  const apkUrl = requireHttpUrl(candidate.apkUrl);
  const bytes = Number(candidate.bytes);
  const sha256 = String(candidate.sha256 || "").toLowerCase();
  if (!Number.isInteger(versionCode) || versionCode < 1) throw new Error("Android versionCode is invalid.");
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("Android APK size is invalid.");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Android APK checksum is invalid.");
  return {
    version,
    versionCode,
    apkUrl,
    bytes,
    sha256,
    releaseNotes: typeof candidate.releaseNotes === "string" ? candidate.releaseNotes.slice(0, 2_000) : "",
  };
}

function parseVersion(value: string): number[] {
  const normalized = requireVersion(value).split("-", 1)[0]!;
  return normalized.split(".").map(Number);
}

function requireVersion(value: unknown): string {
  const version = String(value || "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Update version is invalid.");
  }
  return version;
}

function requireHttpUrl(value: unknown): string {
  const url = new URL(String(value || ""));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Android APK URL is invalid.");
  }
  return url.toString();
}
