export const GEMMA_31B_BF16_MODEL: "gemma-4-31b-it-uncensored-bf16";
export const GEMMA_31B_CONTEXT_WINDOW: 131072;

export function isGemma31bBf16Model(modelId: unknown): boolean;
export function applyGemma31bModelPolicy<T>(model: T): T;
export function applyGemma31bChatRequestPolicy<T>(request: T, upstreamModel: unknown): T;
