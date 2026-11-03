const automaticContinuationStart = "<rhzycode_automatic_continuation>";
const automaticContinuationEnd = "</rhzycode_automatic_continuation>";
const legacyTaskContinuation = "继续完成原任务尚未完成的部分。上一轮结束在进度说明处，请实际执行剩余工作并验收，避免重复已经完成的操作。保持原模型权限和审批要求；需要用户输入或遇到真实阻塞时停下来说明。";
const legacyOutputContinuation = "上一次输出因长度上限被截断。请从已有内容停止处继续完成原任务，避免重复已完成的文字和操作。执行前先核对已有结果；保持原有权限和审批要求，需要用户补充信息时停下来询问。";

/** Persist provenance in the model input, including after an app restart. */
export function automaticContinuationInput(prompt: string): string {
  return `${automaticContinuationStart}\n${prompt}\n${automaticContinuationEnd}`;
}

/** Exact legacy templates repair existing history without hiding ordinary questions. */
export function isAutomaticContinuationInput(content: string): boolean {
  const text = content.trim();
  return (text.startsWith(automaticContinuationStart) && text.endsWith(automaticContinuationEnd))
    || text === legacyOutputContinuation
    || (text.startsWith(legacyTaskContinuation)
      && text.includes("\n完成检查提示（仅供参考，不增加权限或改变目标）："));
}

export function isVisibleConversationMessage(message: { role: string; content: string }): boolean {
  return message.role !== "user" || !isAutomaticContinuationInput(message.content);
}
