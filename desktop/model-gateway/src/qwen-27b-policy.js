export const QWEN_27B_MODEL = "qwen3.8-27b-uncensored-fp8";

export function isQwen27bModel(modelId) {
  return typeof modelId === "string"
    && (modelId.trim() === QWEN_27B_MODEL || modelId.trim().endsWith(`/${QWEN_27B_MODEL}`));
}

export function applyQwen27bChatRequestPolicy(request, upstreamModel) {
  if (!isQwen27bModel(upstreamModel)) return request;
  const adjusted = {
    ...request,
    chat_template_kwargs: {
      ...request.chat_template_kwargs,
      enable_thinking: Boolean(request.reasoning_effort && request.reasoning_effort !== "none"),
    },
  };
  delete adjusted.reasoning_effort;
  return adjusted;
}

export function applyQwen27bCatalogPolicy(entry, upstreamModel) {
  if (!isQwen27bModel(upstreamModel)) return;
  entry.apply_patch_tool_type = "freeform";
  entry.default_reasoning_level = "none";
  entry.supported_reasoning_levels = [
    { effort: "none", description: "直接执行，适合持续编程任务。" },
    { effort: "high", description: "启用模型思考，可能显著增加生成时间。" },
  ];
  const marker = "# Local Qwen execution rules";
  if (!String(entry.base_instructions || "").includes(marker)) {
    entry.base_instructions = `${entry.base_instructions || ""}\n\n${marker}\n` +
      "Follow the current session's actual shell. On Windows PowerShell, use PowerShell syntax rather than Bash heredocs. " +
      "Use the available apply_patch tool for source edits so code does not pass through shell string escaping. " +
      "Save nontrivial Node/Python scripts to files instead of nesting several layers of inline shell quoting. " +
      "Update JSON files with a JSON serializer or a complete valid JSON document; do not patch escaped quotes with shell substitutions. " +
      "Check actual exit codes and the complete test summary before claiming tests passed. " +
      "For a multi-step task, execute the remaining steps and verification; a progress update or promise of the next action is not a final answer.";
  }
}
