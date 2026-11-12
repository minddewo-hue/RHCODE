import type { ModelOption } from "../shared/desktop-api";

type ModelReasoningOptions = Pick<ModelOption, "defaultReasoningEffort" | "supportedReasoningEfforts">;

// Use Codex's bundled reasoning levels with the project's preferred default.
export function modelReasoningFallback(
  upstreamModel: string,
  capabilities: Record<string, boolean>,
): ModelReasoningOptions | undefined {
  if (upstreamModel !== "gpt-6.1-sol" || capabilities.reasoning === false) return undefined;
  return {
    defaultReasoningEffort: "ultra",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
      { reasoningEffort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
      { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" },
      { reasoningEffort: "xhigh", description: "Extra high reasoning depth for complex problems" },
      { reasoningEffort: "max", description: "Maximum reasoning depth for the hardest problems" },
      { reasoningEffort: "ultra", description: "Maximum reasoning with automatic task delegation" },
    ],
  };
}
