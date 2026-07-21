import fs from "node:fs";
import path from "node:path";
import type { LlmProtocol, LlmProtocolMode } from "./llm-protocol";

export interface CredentialEncryption {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export interface ProviderCredentialStatus {
  providerId: string;
  name: string;
  baseUrl: string;
  protocol: LlmProtocolMode;
  detectedProtocol: LlmProtocol;
  models: string[];
  custom: boolean;
  configured: boolean;
  source: "secure_store" | "environment" | "missing";
}

export interface StoredProviderConfiguration {
  providerId: string;
  name: string;
  baseUrl: string;
  protocol: LlmProtocolMode;
  detectedProtocol: LlmProtocol;
  models: string[];
}

interface ProviderRecord extends Omit<StoredProviderConfiguration, "providerId"> {
  apiKeyEnv: string;
}

interface CredentialFile {
  version: 3;
  credentials: Record<string, string>;
  providers: Record<string, ProviderRecord>;
  removedProviders: string[];
}

interface StaticProvider {
  providerId: string;
  name: string;
  baseUrl: string;
  protocol: LlmProtocol;
  apiKeyEnv: string;
  models: string[];
}

interface GatewayConfigFile {
  providers?: Record<string, Record<string, unknown>>;
  models?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export class ProviderCredentialStore {
  private readonly configPath: string;
  private readonly staticConfig: GatewayConfigFile;
  private readonly staticProviders: StaticProvider[];
  private readonly runtimeConfigPath: string;

  constructor(
    gatewayRoot: string,
    private readonly storagePath: string,
    private readonly encryption: CredentialEncryption,
  ) {
    this.configPath = path.join(gatewayRoot, "gateway.config.json");
    this.staticConfig = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as GatewayConfigFile;
    this.staticProviders = readStaticProviders(this.staticConfig);
    this.runtimeConfigPath = path.join(path.dirname(storagePath), "gateway-runtime-config.json");
  }

  status(): { encryptionAvailable: boolean; providers: ProviderCredentialStatus[] } {
    const file = this.readFile();
    const removedProviders = new Set(file.removedProviders);
    const providerIds = new Set([
      ...this.staticProviders.map((provider) => provider.providerId),
      ...Object.keys(file.providers),
    ].filter((providerId) => !removedProviders.has(providerId)));
    return {
      encryptionAvailable: this.encryption.isAvailable(),
      providers: [...providerIds].map((providerId) => {
        const stored = file.providers[providerId];
        const builtIn = this.staticProviders.find((provider) => provider.providerId === providerId);
        const environmentName = stored?.apiKeyEnv || builtIn?.apiKeyEnv || environmentNameFor(providerId);
        const inSecureStore = Boolean(file.credentials[environmentName]);
        const inEnvironment = Boolean(process.env[environmentName]);
        const protocol = stored?.protocol || builtIn?.protocol || "auto";
        const detectedProtocol = stored?.detectedProtocol || builtIn?.protocol || "responses";
        return {
          providerId,
          name: stored?.name || builtIn?.name || providerId,
          baseUrl: stored?.baseUrl || builtIn?.baseUrl || "",
          protocol,
          detectedProtocol,
          models: [...(stored?.models || builtIn?.models || [])],
          custom: !builtIn,
          configured: inSecureStore || inEnvironment,
          source: inSecureStore ? "secure_store" : inEnvironment ? "environment" : "missing",
        };
      }),
    };
  }

  getRuntimeConfigPath(): string {
    return this.runtimeConfigPath;
  }

  getApiKey(providerId: string): string {
    const file = this.readFile();
    if (file.removedProviders.includes(providerId)) return "";
    const stored = file.providers[providerId];
    const builtIn = this.staticProviders.find((provider) => provider.providerId === providerId);
    const environmentName = stored?.apiKeyEnv || builtIn?.apiKeyEnv || environmentNameFor(providerId);
    const encrypted = file.credentials[environmentName];
    if (encrypted) {
      try {
        return this.encryption.decrypt(Buffer.from(encrypted, "base64"));
      } catch {
        return "";
      }
    }
    return process.env[environmentName]?.trim() || "";
  }

  applyToEnvironment(): void {
    const file = this.readFile();
    for (const providerId of file.removedProviders) {
      const environmentName = this.staticProviders.find(
        (provider) => provider.providerId === providerId,
      )?.apiKeyEnv || environmentNameFor(providerId);
      delete process.env[environmentName];
    }
    const environmentNames = new Set([
      ...this.staticProviders.map((provider) => provider.apiKeyEnv).filter(Boolean),
      ...Object.values(file.providers).map((provider) => provider.apiKeyEnv),
    ]);
    for (const environmentName of environmentNames) {
      const encrypted = file.credentials[environmentName];
      if (!encrypted) continue;
      try {
        process.env[environmentName] = this.encryption.decrypt(Buffer.from(encrypted, "base64"));
      } catch {
        delete process.env[environmentName];
      }
    }
  }

  set(providerId: string, apiKey: string): void {
    const status = this.status().providers.find((provider) => provider.providerId === providerId);
    if (!status) throw new Error("Unknown gateway provider.");
    const file = this.readFile();
    const environmentName = file.providers[providerId]?.apiKeyEnv
      || this.staticProviders.find((provider) => provider.providerId === providerId)?.apiKeyEnv
      || environmentNameFor(providerId);
    this.updateEncryptedKey(file, environmentName, apiKey);
    this.writeFile(file);
  }

  upsert(configuration: StoredProviderConfiguration, apiKey: string): void {
    const file = this.readFile();
    file.removedProviders = file.removedProviders.filter(
      (providerId) => providerId !== configuration.providerId,
    );
    const existing = file.providers[configuration.providerId];
    const builtIn = this.staticProviders.find(
      (provider) => provider.providerId === configuration.providerId,
    );
    const environmentName = existing?.apiKeyEnv || builtIn?.apiKeyEnv
      || environmentNameFor(configuration.providerId);
    file.providers[configuration.providerId] = {
      name: configuration.name,
      baseUrl: configuration.baseUrl,
      protocol: configuration.protocol,
      detectedProtocol: effectiveDetectedProtocol(configuration),
      models: [...configuration.models],
      apiKeyEnv: environmentName,
    };
    if (apiKey.trim()) this.updateEncryptedKey(file, environmentName, apiKey);
    this.writeFile(file);
  }

  remove(providerId: string): void {
    const file = this.readFile();
    const provider = file.providers[providerId];
    const builtIn = this.staticProviders.find((entry) => entry.providerId === providerId);
    if (!provider && !builtIn) throw new Error("Unknown gateway provider.");
    const environmentName = provider?.apiKeyEnv || builtIn?.apiKeyEnv || environmentNameFor(providerId);
    delete file.providers[providerId];
    delete file.credentials[environmentName];
    delete process.env[environmentName];
    if (!file.removedProviders.includes(providerId)) file.removedProviders.push(providerId);
    this.writeFile(file);
  }

  writeRuntimeConfig(): string {
    const file = this.readFile();
    const runtime = structuredClone(this.staticConfig);
    runtime.providers ||= {};
    runtime.models ||= {};

    for (const providerId of file.removedProviders) {
      delete runtime.providers[providerId];
      for (const [modelId, model] of Object.entries(runtime.models)) {
        if (model.provider === providerId) delete runtime.models[modelId];
      }
    }

    for (const [providerId, provider] of Object.entries(file.providers)) {
      const previous = runtime.providers[providerId] || {};
      runtime.providers[providerId] = {
        ...previous,
        base_url: provider.baseUrl,
        protocol: effectiveDetectedProtocol(provider),
        api_key_env: provider.apiKeyEnv,
        model_discovery: {
          prefix: `${providerId}/`,
          owned_by: provider.name,
          detect_protocol: provider.protocol === "auto",
        },
      };
      delete runtime.providers[providerId].path;

      for (const [modelId, model] of Object.entries(runtime.models)) {
        if (model.provider === providerId) delete runtime.models[modelId];
      }
      for (const upstreamModel of provider.models) {
        runtime.models[`${providerId}/${upstreamModel}`] = {
          provider: providerId,
          upstream_model: upstreamModel,
          owned_by: provider.name,
          capabilities: {
            function_tools: true,
            parallel_tool_calls: true,
            image_input: true,
            streaming: true,
          },
        };
      }
    }

    fs.mkdirSync(path.dirname(this.runtimeConfigPath), { recursive: true });
    writeJsonAtomically(this.runtimeConfigPath, runtime);
    return this.runtimeConfigPath;
  }

  private updateEncryptedKey(file: CredentialFile, environmentName: string, apiKey: string): void {
    const normalized = apiKey.trim();
    if (!normalized) {
      delete file.credentials[environmentName];
      delete process.env[environmentName];
      return;
    }
    if (!this.encryption.isAvailable()) {
      throw new Error("Secure credential storage is unavailable on this system.");
    }
    file.credentials[environmentName] = this.encryption.encrypt(normalized).toString("base64");
    process.env[environmentName] = normalized;
  }

  private readFile(): CredentialFile {
    if (!fs.existsSync(this.storagePath)) return emptyCredentialFile();
    try {
      const value = JSON.parse(fs.readFileSync(this.storagePath, "utf8")) as {
        version?: unknown;
        credentials?: unknown;
        providers?: unknown;
        removedProviders?: unknown;
      };
      const credentials = isRecord(value.credentials)
        ? Object.fromEntries(Object.entries(value.credentials).filter((entry): entry is [string, string] =>
            typeof entry[1] === "string"))
        : {};
      return {
        version: 3,
        credentials,
        providers: (value.version === 2 || value.version === 3) && isRecord(value.providers)
          ? normalizeProviderRecords(value.providers)
          : {},
        removedProviders: value.version === 3 && Array.isArray(value.removedProviders)
          ? [...new Set(value.removedProviders.filter((providerId): providerId is string =>
            typeof providerId === "string" && providerId.length > 0))]
          : [],
      };
    } catch {
      return emptyCredentialFile();
    }
  }

  private writeFile(file: CredentialFile): void {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    writeJsonAtomically(this.storagePath, file, 0o600);
    this.writeRuntimeConfig();
  }
}

function readStaticProviders(config: GatewayConfigFile): StaticProvider[] {
  const models = config.models || {};
  return Object.entries(config.providers || {}).flatMap(([providerId, provider]) => {
    const protocol = provider.protocol;
    const baseUrl = provider.base_url;
    const apiKeyEnv = typeof provider.api_key_env === "string" ? provider.api_key_env.trim() : "";
    if (!apiKeyEnv) return [];
    return [{
      providerId,
      name: providerId,
      baseUrl: typeof baseUrl === "string" ? baseUrl : "",
      protocol: isLlmProtocol(protocol) ? protocol : "responses",
      apiKeyEnv,
      models: Object.values(models)
        .filter((model) => model.provider === providerId && typeof model.upstream_model === "string")
        .map((model) => String(model.upstream_model)),
    }];
  });
}

function normalizeProviderRecords(value: Record<string, unknown>): Record<string, ProviderRecord> {
  const result: Record<string, ProviderRecord> = {};
  for (const [providerId, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    if (typeof raw.name !== "string" || typeof raw.baseUrl !== "string") continue;
    if (!isProtocolMode(raw.protocol) || !isLlmProtocol(raw.detectedProtocol)) continue;
    if (typeof raw.apiKeyEnv !== "string" || !Array.isArray(raw.models)) continue;
    result[providerId] = {
      name: raw.name,
      baseUrl: raw.baseUrl,
      protocol: raw.protocol,
      detectedProtocol: effectiveDetectedProtocol({
        baseUrl: raw.baseUrl,
        protocol: raw.protocol,
        detectedProtocol: raw.detectedProtocol,
      }),
      apiKeyEnv: raw.apiKeyEnv,
      models: raw.models.filter((model): model is string => typeof model === "string"),
    };
  }
  return result;
}

function environmentNameFor(providerId: string): string {
  return `RHZYCODE_LLM_${providerId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_API_KEY`;
}

function effectiveDetectedProtocol(provider: {
  baseUrl: string;
  protocol: LlmProtocolMode;
  detectedProtocol: LlmProtocol;
}): LlmProtocol {
  if (provider.protocol !== "auto") return provider.detectedProtocol;
  try {
    if (new URL(provider.baseUrl).hostname.toLowerCase() === "faker-model.rhzy.ai") {
      return "chat_completions";
    }
  } catch {
    // Provider URL validation happens before storage; retain the detected protocol for legacy data.
  }
  return provider.detectedProtocol;
}

function emptyCredentialFile(): CredentialFile {
  return { version: 3, credentials: {}, providers: {}, removedProviders: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLlmProtocol(value: unknown): value is LlmProtocol {
  return ["responses", "chat_completions", "anthropic_messages"].includes(String(value));
}

function isProtocolMode(value: unknown): value is LlmProtocolMode {
  return value === "auto" || isLlmProtocol(value);
}

function writeJsonAtomically(filePath: string, value: unknown, mode?: number): void {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    ...(mode == null ? {} : { mode }),
  });
  fs.renameSync(temporaryPath, filePath);
}
