import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CREDENTIAL_VERSION = 1;
const WINDOWS_PROVIDER = "windows-dpapi";

export function loadMinioCredentials(options) {
  const config = options.config;
  const env = options.env || process.env;
  const accessKey = String(env[config.accessKeyEnv] || "").trim();
  const secretKey = String(env[config.secretKeyEnv] || "").trim();

  if (accessKey || secretKey) {
    if (!accessKey || !secretKey) {
      throw new Error(`Both ${config.accessKeyEnv} and ${config.secretKeyEnv} must be set together.`);
    }
    return { accessKey, secretKey, source: "environment variables" };
  }

  const credentialFile = options.credentialFile || path.resolve(
    options.updateRoot,
    config.credentialsFile || ".minio-credentials.json",
  );
  if (!fs.existsSync(credentialFile)) {
    throw new Error(
      `MinIO credentials are not configured. Run "npm run update:credentials" or set ${config.accessKeyEnv} and ${config.secretKeyEnv}.`,
    );
  }

  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(credentialFile, "utf8"));
  } catch {
    throw new Error(`The saved MinIO credential file is invalid: ${credentialFile}`);
  }
  if (stored.version !== CREDENTIAL_VERSION || stored.provider !== WINDOWS_PROVIDER) {
    throw new Error(`The saved MinIO credential format is not supported: ${credentialFile}`);
  }

  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    throw new Error("The saved MinIO credentials are protected by Windows DPAPI and can only be used by the same Windows user.");
  }
  const decrypt = options.decrypt || decryptWindowsDpapi;
  const decryptedAccessKey = decrypt(stored.accessKeyProtected).trim();
  const decryptedSecretKey = decrypt(stored.secretKeyProtected).trim();
  if (!decryptedAccessKey || !decryptedSecretKey) {
    throw new Error(`The saved MinIO credential file is incomplete: ${credentialFile}`);
  }
  return {
    accessKey: decryptedAccessKey,
    secretKey: decryptedSecretKey,
    source: "the encrypted local credential store",
  };
}

function decryptWindowsDpapi(protectedValue) {
  if (!String(protectedValue || "").trim()) return "";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$protectedValue = [Console]::In.ReadToEnd().Trim()",
    "$secure = ConvertTo-SecureString -String $protectedValue",
    "$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }",
    "finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: protectedValue,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Windows could not decrypt the saved MinIO credentials for the current user.");
  }
  return result.stdout;
}
