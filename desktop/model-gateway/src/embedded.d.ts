export interface EmbeddedGatewayProvider {
  id: string;
  protocol: "responses" | "chat_completions";
  health: {
    state: "unknown" | "healthy" | "degraded";
    latencyMs: number | null;
    checkedAt: string | null;
    httpStatus: number | null;
    circuitState: "closed" | "open";
    lastError: string | null;
  };
}

export interface EmbeddedGatewayModel {
  id: string;
  ownedBy: string;
  capabilities: Record<string, boolean>;
  providerId: string;
  upstreamModel: string;
  protocol: "responses" | "chat_completions";
  runtimeInstructions: string | null;
}

export interface EmbeddedGatewayHandle {
  host: string;
  port: number;
  baseUrl: string;
  configSource: string;
  providerCount: number;
  modelCount: number;
  providers: EmbeddedGatewayProvider[];
  models: EmbeddedGatewayModel[];
  probeProviders(options?: { timeoutMs?: number }): Promise<EmbeddedGatewayProvider[]>;
  stop(): Promise<void>;
}

export function startEmbeddedGateway(options: {
  rootDir: string;
  host?: string;
  port?: number;
  envPath?: string;
  configPath?: string;
  discoveryTimeoutMs?: number;
}): Promise<EmbeddedGatewayHandle>;
