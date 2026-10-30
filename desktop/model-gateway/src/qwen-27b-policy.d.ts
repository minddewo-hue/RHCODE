export const QWEN_27B_MODEL: "qwen3.8-27b-uncensored-fp8";
export function isQwen27bModel(modelId: unknown): boolean;
export function applyQwen27bChatRequestPolicy<T>(request: T, upstreamModel: unknown): T;
export function applyQwen27bCatalogPolicy(entry: Record<string, unknown>, upstreamModel: unknown): void;
