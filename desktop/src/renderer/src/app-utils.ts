import type { ApprovalRequest, ThreadSummary, TimelineItem } from "@rhzycode/protocol";
import type { ApprovalPolicy, CredentialStatus, ModelOption, ReasoningEffort, SandboxMode, UpdateStatus } from "../../shared/desktop-api";

export interface ActivityEntry {
  id: string;
  label: string;
  detail: string;
  state: "running" | "done" | "error";
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export function credentialSourceLabel(source: CredentialStatus["providers"][number]["source"]): string {
  if (source === "secure_store") return "Encrypted on this device";
  if (source === "environment") return "Environment or .env";
  return "Not configured";
}

export function providerCredentialPresentation(providerId: string): { label: string; domain: string; prefix: string } {
  if (providerId === "sub2api") return { label: "model.rhzy.ai API key", domain: "model.rhzy.ai", prefix: "sk-" };
  return { label: `${providerId} API key`, domain: providerId, prefix: "provider" };
}

export function updateStateLabel(status: UpdateStatus): string {
  if (!status.enabled) return "No signed update channel configured";
  if (status.state === "checking") return "Checking";
  if (status.state === "available") return `${status.version || "Update"} available`;
  if (status.state === "not_available") return "Up to date";
  if (status.state === "downloading") return `Downloading ${Math.round(status.percent || 0)}%`;
  if (status.state === "downloaded") return `${status.version || "Update"} ready`;
  if (status.state === "error") return "Update check failed";
  return "Ready";
}

export function activityLabel(type: string): string {
  if (/command|exec/i.test(type)) return "Command";
  if (/file|patch/i.test(type)) return "File change";
  if (/reason/i.test(type)) return "Analysis";
  return "Agent activity";
}

export function describeItem(item: Record<string, unknown>): string {
  if (Array.isArray(item.changes)) return formatFileChanges(item.changes);
  if (item.type === "commandExecution") return [item.command, item.aggregatedOutput].filter(Boolean).join("\n");
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.map(String) : [];
    const content = Array.isArray(item.content) ? item.content.map(String) : [];
    return [...summary, ...content].join("\n") || "Analysis";
  }
  return String(item.command || item.path || item.text || item.type || "Working");
}

export function formatFileChanges(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "Waiting for diff";
  return value
    .map((rawChange) => {
      const change = (rawChange || {}) as Record<string, unknown>;
      return [[change.kind, change.path].filter(Boolean).join(" "), change.diff].flat().filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 12_000);
}

export function activityFromTimeline(item: TimelineItem): ActivityEntry {
  return {
    id: item.id,
    label: item.title,
    detail: item.content,
    state: item.status === "failed" ? "error" : item.status === "completed" ? "done" : "running",
  };
}

export function approvalKindLabel(kind: ApprovalRequest["kind"]): string {
  if (kind === "file_change") return "File change";
  if (kind === "permission") return "Permission";
  if (kind === "external_tool") return "External tool";
  return "Command";
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function storedApprovalPolicy(): ApprovalPolicy {
  const stored = localStorage.getItem("rhzycode.approvalPolicy");
  return stored === "untrusted" || stored === "never" ? stored : "on-request";
}

export function storedSelectedModel(): string {
  return localStorage.getItem("rhzycode.selectedModel") || "";
}

const reasoningEffortValues: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function modelReasoningEfforts(model: ModelOption | undefined): ReasoningEffort[] {
  const declared = model?.supportedReasoningEfforts
    ?.map((option) => option.reasoningEffort)
    .filter((value): value is ReasoningEffort => reasoningEffortValues.includes(value as ReasoningEffort)) || [];
  if (declared.length) return [...new Set(declared)];
  return reasoningEffortValues.includes(model?.defaultReasoningEffort as ReasoningEffort)
    ? [model?.defaultReasoningEffort as ReasoningEffort]
    : ["high"];
}

export function storedReasoningEffort(): ReasoningEffort {
  const stored = localStorage.getItem("rhzycode.reasoningEffort");
  return reasoningEffortValues.includes(stored as ReasoningEffort) ? stored as ReasoningEffort : "high";
}

export function storedLastProject(): string {
  return localStorage.getItem("rhzycode.lastProject") || "";
}

export function storedLastThread(projectPath: string): string | null {
  try {
    const entries = JSON.parse(localStorage.getItem("rhzycode.lastThreads") || "{}") as Record<string, unknown>;
    return typeof entries[projectPath] === "string" ? entries[projectPath] : null;
  } catch {
    return null;
  }
}

export function storeLastThread(projectPath: string, threadId: string): void {
  let entries: Record<string, string> = {};
  try {
    const stored = JSON.parse(localStorage.getItem("rhzycode.lastThreads") || "{}") as Record<string, unknown>;
    entries = Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    entries = {};
  }
  entries[projectPath] = threadId;
  localStorage.setItem("rhzycode.lastThreads", JSON.stringify(entries));
}

export function isActiveThreadStatus(status: ThreadSummary["status"]): boolean {
  return status === "running" || status === "waiting_for_approval" || status === "waiting_for_input";
}

export function isComposerRunning(
  selectedThreadId: string | null,
  activeThreadIds: ReadonlySet<string>,
  submittingTurn: boolean,
): boolean {
  return submittingTurn || (selectedThreadId !== null && activeThreadIds.has(selectedThreadId));
}

export function notificationThreadId(params: Record<string, unknown>): string | null {
  if (typeof params.threadId === "string") return params.threadId;
  if (typeof params.conversationId === "string") return params.conversationId;
  const thread = params.thread as Record<string, unknown> | undefined;
  if (typeof thread?.id === "string") return thread.id;
  const turn = params.turn as Record<string, unknown> | undefined;
  return typeof turn?.threadId === "string" ? turn.threadId : null;
}

export function summarizePrompt(text: string): string {
  const title = text.replace(/\s+/g, " ").trim();
  return title.length > 60 ? `${title.slice(0, 57)}...` : title || "New task";
}

export function storedSandboxMode(): SandboxMode {
  const stored = localStorage.getItem("rhzycode.sandboxMode");
  return stored === "read-only" || stored === "danger-full-access" ? stored : "workspace-write";
}

export function storedRecentProjects(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem("rhzycode.recentProjects") || "[]");
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).slice(0, 50)
      : [];
  } catch {
    return [];
  }
}

export function formatFileSize(size: number): string {
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${Math.round(size / 1_024)} KB`;
  return `${(size / 1_048_576).toFixed(1)} MB`;
}
