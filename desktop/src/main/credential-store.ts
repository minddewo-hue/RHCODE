import fs from "node:fs";
import path from "node:path";

export interface CredentialEncryption {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export interface ProviderCredentialStatus {
  providerId: string;
  configured: boolean;
  source: "secure_store" | "environment" | "missing";
}

interface CredentialFile {
  version: 1;
  credentials: Record<string, string>;
}

interface ProviderRequirement {
  providerId: string;
  environmentName: string;
}

export class ProviderCredentialStore {
  private readonly requirements: ProviderRequirement[];

  constructor(
    gatewayRoot: string,
    private readonly storagePath: string,
    private readonly encryption: CredentialEncryption,
  ) {
    this.requirements = readProviderRequirements(gatewayRoot);
  }

  status(): { encryptionAvailable: boolean; providers: ProviderCredentialStatus[] } {
    const stored = this.readFile().credentials;
    return {
      encryptionAvailable: this.encryption.isAvailable(),
      providers: this.requirements.map((requirement) => {
        const inSecureStore = Boolean(stored[requirement.environmentName]);
        const inEnvironment = Boolean(process.env[requirement.environmentName]);
        return {
          providerId: requirement.providerId,
          configured: inSecureStore || inEnvironment,
          source: inSecureStore ? "secure_store" : inEnvironment ? "environment" : "missing",
        };
      }),
    };
  }

  applyToEnvironment(): void {
    const stored = this.readFile().credentials;
    for (const requirement of this.requirements) {
      const encrypted = stored[requirement.environmentName];
      if (!encrypted) continue;
      try {
        process.env[requirement.environmentName] = this.encryption.decrypt(
          Buffer.from(encrypted, "base64"),
        );
      } catch {
        delete process.env[requirement.environmentName];
      }
    }
  }

  set(providerId: string, apiKey: string): void {
    const requirement = this.requirements.find((entry) => entry.providerId === providerId);
    if (!requirement) throw new Error("Unknown gateway provider.");
    const normalized = apiKey.trim();
    const file = this.readFile();
    if (!normalized) {
      delete file.credentials[requirement.environmentName];
      delete process.env[requirement.environmentName];
    } else {
      if (!this.encryption.isAvailable()) {
        throw new Error("Secure credential storage is unavailable on this system.");
      }
      file.credentials[requirement.environmentName] = this.encryption.encrypt(normalized).toString("base64");
      process.env[requirement.environmentName] = normalized;
    }
    this.writeFile(file);
  }

  private readFile(): CredentialFile {
    if (!fs.existsSync(this.storagePath)) return { version: 1, credentials: {} };
    try {
      const value = JSON.parse(fs.readFileSync(this.storagePath, "utf8")) as Partial<CredentialFile>;
      return {
        version: 1,
        credentials: value.version === 1 && value.credentials && typeof value.credentials === "object"
          ? value.credentials
          : {},
      };
    } catch {
      return { version: 1, credentials: {} };
    }
  }

  private writeFile(file: CredentialFile): void {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.storagePath);
  }
}

function readProviderRequirements(gatewayRoot: string): ProviderRequirement[] {
  const configPath = path.join(gatewayRoot, "gateway.config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    providers?: Record<string, { api_key_env?: unknown }>;
  };
  return Object.entries(config.providers || {}).flatMap(([providerId, provider]) =>
    typeof provider.api_key_env === "string" && provider.api_key_env.trim()
      ? [{ providerId, environmentName: provider.api_key_env.trim() }]
      : [],
  );
}
