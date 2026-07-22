import type { ApprovalRequest, ThreadSummary, TimelineItem } from "@rhzycode/protocol";
import type { ApprovalPolicy, CredentialStatus, ModelOption, ReasoningEffort, SandboxMode, UpdateStatus } from "../../shared/desktop-api";

export interface ActivityEntry {
  id: string;
  label: string;
  detail: string;
  state: "running" | "done" | "error";
}

export interface ModelGroup {
  key: string;
  source: string;
  models: Array<ModelOption & { sourceModelName: string }>;
}

const modelNameCollator = new Intl.Collator(["zh-CN", "en"], {
  numeric: true,
  sensitivity: "base",
});

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

export function providerDisplayName(provider: CredentialStatus["providers"][number]): string {
  const configuredName = provider.name.trim();
  if (configuredName && configuredName.toLocaleLowerCase() !== provider.providerId.toLocaleLowerCase()) {
    return configuredName;
  }
  if (provider.providerId === "sub2api") return "Sub2API";
  return configuredName || provider.providerId;
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
  if (model?.supportedReasoningEfforts) {
    const declared = model.supportedReasoningEfforts
      .map((option) => option.reasoningEffort)
      .filter((value): value is ReasoningEffort => reasoningEffortValues.includes(value as ReasoningEffort));
    return [...new Set(declared)];
  }
  return reasoningEffortValues.includes(model?.defaultReasoningEffort as ReasoningEffort)
    ? [model?.defaultReasoningEffort as ReasoningEffort]
    : ["high"];
}

export function groupModelsBySource(
  models: ModelOption[],
  providers: CredentialStatus["providers"] = [],
): ModelGroup[] {
  const providersById = new Map(providers.map((provider, index) => [
    provider.providerId,
    { provider, index },
  ]));
  const groups = new Map<string, ModelGroup & { providerOrder: number }>();
  for (const model of models) {
    const presentation = modelSourcePresentation(model, providersById);
    const group = groups.get(presentation.key) || {
      key: presentation.key,
      source: presentation.source,
      models: [],
      providerOrder: presentation.providerOrder,
    };
    group.models.push({ ...model, sourceModelName: presentation.modelName });
    groups.set(presentation.key, group);
  }
  return [...groups.values()]
    .sort((left, right) =>
      left.providerOrder - right.providerOrder
      || modelNameCollator.compare(left.source, right.source))
    .map(({ providerOrder: _providerOrder, ...group }) => ({
      ...group,
      models: group.models.sort((left, right) =>
        modelNameCollator.compare(left.sourceModelName, right.sourceModelName)
        || modelNameCollator.compare(left.model, right.model)),
    }));
}

function modelSourcePresentation(
  model: ModelOption,
  providersById: Map<string, { provider: CredentialStatus["providers"][number]; index: number }>,
): { key: string; source: string; modelName: string; providerOrder: number } {
  const slashIndex = model.model.indexOf("/");
  const providerId = slashIndex > 0 ? model.model.slice(0, slashIndex) : "";
  const configuredProvider = providersById.get(providerId);
  if (configuredProvider) {
    return {
      key: `provider:${providerId}`,
      source: providerDisplayName(configuredProvider.provider),
      modelName: model.model.slice(slashIndex + 1),
      providerOrder: configuredProvider.index,
    };
  }
  const separatorIndex = model.displayName.indexOf(" - ");
  if (separatorIndex > 0) {
    const source = model.displayName.slice(0, separatorIndex).trim();
    return {
      key: `display:${source}`,
      source,
      modelName: model.displayName.slice(separatorIndex + 3).trim() || model.model,
      providerOrder: Number.MAX_SAFE_INTEGER,
    };
  }
  if (slashIndex > 0) {
    const source = model.model.slice(0, slashIndex);
    return {
      key: `model:${source}`,
      source,
      modelName: model.displayName || model.model.slice(slashIndex + 1),
      providerOrder: Number.MAX_SAFE_INTEGER,
    };
  }
  return {
    key: "other",
    source: "Other",
    modelName: model.displayName || model.model,
    providerOrder: Number.MAX_SAFE_INTEGER,
  };
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
