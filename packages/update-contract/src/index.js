export const updatePlatforms = ["windows", "macos", "android", "ios"];

const desktopPlatforms = new Set(["windows", "macos"]);
const mobilePlatforms = new Set(["android", "ios"]);

export function parseUpdateManifest(value) {
  const manifest = requireManifest(value);
  const platforms = {};
  for (const platform of updatePlatforms) {
    if (manifest.platforms[platform] !== undefined) {
      platforms[platform] = parseUpdateForPlatform(manifest, platform);
    }
  }
  return {
    schemaVersion: 2,
    publishedAt: requireDateTime(manifest.publishedAt),
    platforms,
  };
}

export function parseUpdateForPlatform(value, platform) {
  if (!updatePlatforms.includes(platform)) {
    throw new Error(`Unsupported update platform: ${platform}.`);
  }
  const manifest = requireManifest(value);
  const candidate = manifest.platforms[platform];
  if (!isRecord(candidate)) {
    throw new Error(`${platformLabel(platform)} update metadata is unavailable.`);
  }
  if (desktopPlatforms.has(platform)) return parseDesktopUpdate(candidate, platform);
  if (platform === "android") return parseAndroidUpdate(candidate);
  return parseIosUpdate(candidate);
}

export function compareVersions(left, right) {
  return compareNumericParts(requireVersion(left), requireVersion(right));
}

export function compareBuildNumbers(left, right) {
  return compareNumericParts(requireBuildNumber(left), requireBuildNumber(right));
}

export function isDesktopUpdatePlatform(value) {
  return desktopPlatforms.has(value);
}

export function isMobileUpdatePlatform(value) {
  return mobilePlatforms.has(value);
}

function parseDesktopUpdate(candidate, platform) {
  const label = platformLabel(platform);
  return {
    platform,
    version: requireVersion(candidate.version),
    architecture: requireText(candidate.architecture, `${label} architecture`),
    downloadUrl: requireHttpUrl(candidate.downloadUrl, `${label} download URL`),
    feedUrl: requireHttpUrl(candidate.feedUrl, `${label} update feed URL`).replace(/\/+$/, ""),
    metadataUrl: requireHttpUrl(candidate.metadataUrl, `${label} update metadata URL`),
    bytes: requireBytes(candidate.bytes, `${label} installer size`),
    sha256: requireChecksum(candidate.sha256, `${label} installer checksum`),
    releaseNotes: optionalReleaseNotes(candidate.releaseNotes),
  };
}

function parseAndroidUpdate(candidate) {
  const versionCode = Number(candidate.versionCode);
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    throw new Error("Android versionCode is invalid.");
  }
  return {
    platform: "android",
    version: requireVersion(candidate.version),
    versionCode,
    downloadUrl: requireHttpUrl(candidate.downloadUrl, "Android APK URL"),
    bytes: requireBytes(candidate.bytes, "Android APK size"),
    sha256: requireChecksum(candidate.sha256, "Android APK checksum"),
    releaseNotes: optionalReleaseNotes(candidate.releaseNotes),
  };
}

function parseIosUpdate(candidate) {
  return {
    platform: "ios",
    version: requireVersion(candidate.version),
    buildNumber: requireBuildNumber(candidate.buildNumber),
    storeUrl: requireHttpUrl(candidate.storeUrl, "iOS App Store URL"),
    releaseNotes: optionalReleaseNotes(candidate.releaseNotes),
  };
}

function requireManifest(value) {
  if (!isRecord(value)) throw new Error("Update manifest is invalid.");
  if (value.schemaVersion !== 2) throw new Error("Update manifest schema is unsupported.");
  if (!isRecord(value.platforms)) throw new Error("Update manifest platforms are invalid.");
  return value;
}

function compareNumericParts(left, right) {
  const leftParts = left.split("-", 1)[0].split(".").map(Number);
  const rightParts = right.split("-", 1)[0].split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function requireVersion(value) {
  const version = String(value || "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Update version is invalid.");
  }
  return version;
}

function requireBuildNumber(value) {
  const buildNumber = String(value || "").trim();
  if (!/^\d+(?:\.\d+){0,2}$/.test(buildNumber)) {
    throw new Error("iOS build number is invalid.");
  }
  return buildNumber;
}

function requireDateTime(value) {
  const dateTime = String(value || "").trim();
  if (!dateTime || Number.isNaN(Date.parse(dateTime))) {
    throw new Error("Update publication time is invalid.");
  }
  return dateTime;
}

function requireText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is invalid.`);
  return text;
}

function requireHttpUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} is invalid.`);
  }
  return url.toString();
}

function requireBytes(value, label) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error(`${label} is invalid.`);
  return bytes;
}

function requireChecksum(value, label) {
  const checksum = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`${label} is invalid.`);
  return checksum;
}

function optionalReleaseNotes(value) {
  return typeof value === "string" ? value.slice(0, 2_000) : "";
}

function platformLabel(platform) {
  return ({ windows: "Windows", macos: "macOS", android: "Android", ios: "iOS" })[platform] || platform;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
