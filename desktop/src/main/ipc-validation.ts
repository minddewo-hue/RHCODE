import path from "node:path";
import type { UserInputAnswers } from "@rhzycode/protocol";
import type {
  ApprovalPolicy,
  ComposerAttachment,
  LlmProviderConfigurationInput,
  ReasoningEffort,
  SandboxMode,
  SkillImportSource,
  StartThreadParams,
  StartTurnParams,
  TerminalStartParams,
  ThreadListOptions,
} from "../shared/desktop-api";

type ApprovalDecision = "approved" | "declined";

const APPROVAL_POLICIES = new Set<ApprovalPolicy>(["on-request", "untrusted", "never"]);
const SANDBOX_MODES = new Set<SandboxMode>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);
const ATTACHMENT_KINDS = new Set<ComposerAttachment["kind"]>(["file", "image"]);
const RESERVED_ANSWER_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const LLM_PROTOCOLS = new Set<LlmProviderConfigurationInput["protocol"]>([
  "auto", "responses", "chat_completions", "anthropic_messages",
]);

export function validateThreadListOptions(value: unknown): ThreadListOptions {
  if (value === undefined) return {};
  const input = requireObject(value, "thread list options");
  assertOnlyKeys(input, ["cwd", "searchTerm", "archived"], "thread list options");
  return {
    ...(input.cwd === undefined ? {} : { cwd: requireAbsolutePath(input.cwd, "cwd") }),
    ...(input.searchTerm === undefined
      ? {}
      : { searchTerm: requireString(input.searchTerm, "searchTerm", 500, true) }),
    ...(input.archived === undefined
      ? {}
      : { archived: requireBoolean(input.archived, "archived") }),
  };
}

export function validateIdentifier(value: unknown, field = "id"): string {
  const identifier = requireString(value, field, 500).trim();
  if (!identifier) invalid(field, "must not be empty");
  if (identifier.includes("\0")) invalid(field, "contains an invalid character");
  return identifier;
}

export function validateProjectPath(value: unknown): string {
  return requireAbsolutePath(value, "projectPath");
}

export function validateSkillPath(value: unknown): string {
  return requireAbsolutePath(value, "skillPath");
}

export function validateSkillEnabled(value: unknown): boolean {
  return requireBoolean(value, "enabled");
}

export function validateSkillImportSource(value: unknown): SkillImportSource {
  if (value !== "codex" && value !== "claude") {
    invalid("skill import source", "must be codex or claude");
  }
  return value;
}

export function validateStartThread(value: unknown): StartThreadParams {
  const input = requireObject(value, "thread start request");
  assertOnlyKeys(
    input,
    ["cwd", "model", "approvalPolicy", "sandboxMode"],
    "thread start request",
  );
  return {
    cwd: requireAbsolutePath(input.cwd, "cwd"),
    ...(input.model === undefined
      ? {}
      : { model: requireNonEmptyString(input.model, "model", 500) }),
    ...(input.approvalPolicy === undefined
      ? {}
      : { approvalPolicy: requireApprovalPolicy(input.approvalPolicy) }),
    ...(input.sandboxMode === undefined
      ? {}
      : { sandboxMode: requireSandboxMode(input.sandboxMode) }),
  };
}

export function validateThreadRename(threadId: unknown, name: unknown): {
  threadId: string;
  name: string;
} {
  return {
    threadId: validateIdentifier(threadId, "threadId"),
    name: requireNonEmptyString(name, "name", 200),
  };
}

export function validateThreadModel(threadId: unknown, model: unknown): {
  threadId: string;
  model: string;
} {
  return {
    threadId: validateIdentifier(threadId, "threadId"),
    model: requireNonEmptyString(model, "model", 500),
  };
}

export function validateStartTurn(value: unknown): StartTurnParams {
  const input = requireObject(value, "turn start request");
  assertOnlyKeys(
    input,
    ["threadId", "text", "model", "approvalPolicy", "sandboxMode", "reasoningEffort", "attachments"],
    "turn start request",
  );
  const text = requireString(input.text, "text", 1_000_000, true);
  const attachments = input.attachments === undefined
    ? undefined
    : validateAttachments(input.attachments);
  if (!text.trim() && !attachments?.length) {
    invalid("turn start request", "requires text or an attachment");
  }
  return {
    threadId: validateIdentifier(input.threadId, "threadId"),
    text,
    ...(input.model === undefined
      ? {}
      : { model: requireNonEmptyString(input.model, "model", 500) }),
    ...(input.approvalPolicy === undefined
      ? {}
      : { approvalPolicy: requireApprovalPolicy(input.approvalPolicy) }),
    ...(input.sandboxMode === undefined
      ? {}
      : { sandboxMode: requireSandboxMode(input.sandboxMode) }),
    ...(input.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: requireReasoningEffort(input.reasoningEffort) }),
    ...(attachments === undefined ? {} : { attachments }),
  };
}

export function validateCredentialUpdate(providerId: unknown, apiKey: unknown): {
  providerId: string;
  apiKey: string;
} {
  return {
    providerId: validateIdentifier(providerId, "providerId"),
    apiKey: requireString(apiKey, "apiKey", 20_000, true),
  };
}

export function validateLlmProviderConfiguration(value: unknown): LlmProviderConfigurationInput {
  const input = requireObject(value, "provider configuration");
  assertOnlyKeys(
    input,
    ["providerId", "name", "baseUrl", "apiKey", "protocol", "models"],
    "provider configuration",
  );
  const providerId = requireNonEmptyString(input.providerId, "providerId", 80).trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(providerId)) {
    invalid("providerId", "must contain only lowercase letters, numbers, hyphens, or underscores");
  }
  if (typeof input.protocol !== "string" || !LLM_PROTOCOLS.has(input.protocol as LlmProviderConfigurationInput["protocol"])) {
    invalid("protocol", "is unsupported");
  }
  if (!Array.isArray(input.models) || input.models.length > 200) {
    invalid("models", "must be an array with at most 200 entries");
  }
  const models = [...new Set(input.models.map((model, index) =>
    requireNonEmptyString(model, `models[${index}]`, 500).trim()))];
  const baseUrl = requireHttpUrl(input.baseUrl, "baseUrl");
  return {
    providerId,
    name: requireNonEmptyString(input.name, "name", 120).trim(),
    baseUrl,
    apiKey: requireString(input.apiKey, "apiKey", 20_000, true),
    protocol: input.protocol as LlmProviderConfigurationInput["protocol"],
    models,
  };
}

export function validateClipboardText(value: unknown): string {
  return requireString(value, "clipboard text", 4_096, true);
}

export function validateSyncPort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    invalid("sync port", "must be an integer between 1 and 65535");
  }
  return value;
}

export function validateApprovalResolution(id: unknown, decision: unknown): {
  id: string;
  decision: ApprovalDecision;
} {
  if (decision !== "approved" && decision !== "declined") {
    invalid("decision", "must be approved or declined");
  }
  return { id: validateIdentifier(id, "approvalId"), decision };
}

export function validateUserInputResolution(id: unknown, answers: unknown): {
  id: string;
  answers: UserInputAnswers;
} {
  const input = requireObject(answers, "answers");
  const entries = Object.entries(input);
  if (entries.length > 100) invalid("answers", "contains too many questions");

  let totalCharacters = 0;
  const validated: UserInputAnswers = {};
  for (const [questionId, rawValues] of entries) {
    if (RESERVED_ANSWER_KEYS.has(questionId)) invalid("answers", "contains a reserved question id");
    const validatedId = validateIdentifier(questionId, "questionId");
    if (!Array.isArray(rawValues)) invalid("answers", "must contain arrays of strings");
    if (rawValues.length > 100) invalid("answers", "contains too many values for a question");
    const values = rawValues.map((value) => {
      const answer = requireString(value, "answer", 100_000, true);
      totalCharacters += answer.length;
      if (totalCharacters > 1_000_000) invalid("answers", "is too large");
      return answer;
    });
    validated[validatedId] = values;
  }
  return { id: validateIdentifier(id, "requestId"), answers: validated };
}

export function validateTerminalStart(value: unknown): TerminalStartParams {
  const input = requireObject(value, "terminal start request");
  assertOnlyKeys(input, ["cwd", "cols", "rows"], "terminal start request");
  return {
    cwd: requireAbsolutePath(input.cwd, "cwd"),
    ...(input.cols === undefined ? {} : { cols: requireInteger(input.cols, "cols", 1, 500) }),
    ...(input.rows === undefined ? {} : { rows: requireInteger(input.rows, "rows", 1, 300) }),
  };
}

export function validateTerminalWrite(processId: unknown, data: unknown): {
  processId: string;
  data: string;
} {
  return {
    processId: validateIdentifier(processId, "processId"),
    data: requireString(data, "data", 65_536, true),
  };
}

export function validateTerminalResize(
  processId: unknown,
  cols: unknown,
  rows: unknown,
): { processId: string; cols: number; rows: number } {
  return {
    processId: validateIdentifier(processId, "processId"),
    cols: requireInteger(cols, "cols", 1, 500),
    rows: requireInteger(rows, "rows", 1, 300),
  };
}

function validateAttachments(value: unknown): ComposerAttachment[] {
  if (!Array.isArray(value)) invalid("attachments", "must be an array");
  if (value.length > 20) invalid("attachments", "can contain at most 20 items");
  return value.map((rawAttachment, index) => {
    const field = `attachments[${index}]`;
    const attachment = requireObject(rawAttachment, field);
    assertOnlyKeys(attachment, ["path", "name", "kind", "size"], field);
    const kind = attachment.kind;
    if (typeof kind !== "string" || !ATTACHMENT_KINDS.has(kind as ComposerAttachment["kind"])) {
      invalid(`${field}.kind`, "must be file or image");
    }
    return {
      path: requireAbsolutePath(attachment.path, `${field}.path`),
      name: requireNonEmptyString(attachment.name, `${field}.name`, 1_024),
      kind: kind as ComposerAttachment["kind"],
      size: requireInteger(attachment.size, `${field}.size`, 0, Number.MAX_SAFE_INTEGER),
    };
  });
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(field, "must be an object");
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    invalid(field, "contains unsupported fields");
  }
}

function requireString(
  value: unknown,
  field: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") invalid(field, "must be a string");
  if (!allowEmpty && !value) invalid(field, "must not be empty");
  if (value.length > maxLength) invalid(field, `must not exceed ${maxLength} characters`);
  return value;
}

function requireNonEmptyString(value: unknown, field: string, maxLength: number): string {
  const result = requireString(value, field, maxLength);
  if (!result.trim()) invalid(field, "must not be blank");
  return result;
}

function requireAbsolutePath(value: unknown, field: string): string {
  const result = requireNonEmptyString(value, field, 32_768);
  if (result.includes("\0")) invalid(field, "contains an invalid character");
  if (!path.isAbsolute(result)) invalid(field, "must be an absolute path");
  return path.normalize(result);
}

function requireHttpUrl(value: unknown, field: string): string {
  const result = requireNonEmptyString(value, field, 2_000).trim();
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    invalid(field, "must be a valid URL starting with http:// or https://");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    invalid(field, "must start with http:// or https://");
  }
  return result;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field, "must be a boolean");
  return value;
}

function requireInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(field, `must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function requireApprovalPolicy(value: unknown): ApprovalPolicy {
  if (typeof value !== "string" || !APPROVAL_POLICIES.has(value as ApprovalPolicy)) {
    invalid("approvalPolicy", "is unsupported");
  }
  return value as ApprovalPolicy;
}

function requireSandboxMode(value: unknown): SandboxMode {
  if (typeof value !== "string" || !SANDBOX_MODES.has(value as SandboxMode)) {
    invalid("sandboxMode", "is unsupported");
  }
  return value as SandboxMode;
}

function requireReasoningEffort(value: unknown): ReasoningEffort {
  if (typeof value !== "string" || !REASONING_EFFORTS.has(value as ReasoningEffort)) {
    invalid("reasoningEffort", "is unsupported");
  }
  return value as ReasoningEffort;
}

function invalid(field: string, reason: string): never {
  throw new Error(`Invalid IPC input: ${field} ${reason}.`);
}
