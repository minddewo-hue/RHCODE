export const GEMMA_31B_BF16_MODEL = "gemma-4-31b-it-uncensored-bf16";
export const GEMMA_31B_CONTEXT_WINDOW = 131_072;

export function isGemma31bBf16Model(modelId) {
  const normalized = typeof modelId === "string" ? modelId.trim() : "";
  return normalized === GEMMA_31B_BF16_MODEL
    || normalized.endsWith(`/${GEMMA_31B_BF16_MODEL}`);
}

export function applyGemma31bModelPolicy(model) {
  const isTargetModel = model?.routes?.some((route) =>
    isGemma31bBf16Model(route.upstreamModel));
  if (!isTargetModel) return model;

  model.contextWindow = GEMMA_31B_CONTEXT_WINDOW;
  return model;
}

export function applyGemma31bChatRequestPolicy(request, upstreamModel) {
  if (!isGemma31bBf16Model(upstreamModel)) return request;
  if (Array.isArray(request?.tools) && request.tools.length > 0) return request;

  const adjusted = { ...request };
  delete adjusted.tool_choice;
  delete adjusted.parallel_tool_calls;
  return adjusted;
}
