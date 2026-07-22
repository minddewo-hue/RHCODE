export interface ModelContextEntry {
  contextWindow: number;
  maxContextWindow: number;
  effectiveContextWindowPercent: number;
  verification: string;
}

export interface ModelContextConfig {
  source: string;
  default: ModelContextEntry;
  models: Map<string, ModelContextEntry>;
}

export const MODEL_CONTEXT_CONFIG_NAME: "model-context-windows.json";
export function loadModelContextConfig(rootDir: string, configPath?: string): ModelContextConfig | null;
export function applyModelContextConfig<T>(model: T, config: ModelContextConfig | null): T;
