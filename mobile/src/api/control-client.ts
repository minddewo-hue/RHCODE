import {
  agentEventSchema,
  controlSyncFrameSchema,
  controlSnapshotSchema,
  remoteArchivedThreadListResultSchema,
  remoteModelListResultSchema,
  remoteProjectCreateResultSchema,
  remoteProjectListResultSchema,
  remoteDirectoryBrowseResultSchema,
  remoteThreadMutationResultSchema,
  remoteThreadOpenResultSchema,
  remoteThreadStartResultSchema,
  remoteTurnInterruptResultSchema,
  remoteTurnStartResultSchema,
  remoteUserInputSubmitResultSchema,
  type AgentEvent,
  type ControlSnapshot,
  type ControlSyncFrame,
  type RemoteArchivedThreadListResult,
  type RemoteApprovalPolicy,
  type RemoteModelListResult,
  type RemoteProjectCreateResult,
  type RemoteProjectListResult,
  type RemoteReasoningEffort,
  type RemoteDirectoryBrowseResult,
  type RemoteSandboxMode,
  type RemoteTurnAttachment,
  type RemoteThreadMutationResult,
  type RemoteThreadOpenResult,
  type RemoteThreadStartResult,
  type RemoteTurnInterruptResult,
  type RemoteTurnStartResult,
  type RemoteUserInputSubmitResult,
  type UserInputAnswers,
} from "@rhzycode/protocol";
import { z } from "zod";
import {
  controlServiceUrl,
  normalizeAccessKey,
} from "../auth/control-access";

export type ControlErrorCode =
  | "offline"
  | "timeout"
  | "certificate"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "invalid_response"
  | "server";

export class ControlClientError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ControlClientError";
  }
}

export interface ControlAccessInput {
  accessKey: string;
}

export interface EventSocketDescriptor {
  url: string;
  protocols: ["rhzycode.v1", string];
}

export type ControlSocketFrame = AgentEvent | ControlSyncFrame;

export interface AuthenticatedImageSource {
  uri: string;
  headers: { Authorization: string };
}

export interface AuthenticatedFileRequest {
  url: string;
  headers: { Authorization: string };
}

type FetchLike = typeof fetch;
type IdempotencyKeyFactory = () => string;

export interface ControlClientOptions {
  fetchImpl?: FetchLike;
  idempotencyKeyFactory?: IdempotencyKeyFactory;
  controlUrl?: string;
}

export interface ThreadStartInput {
  projectPath: string;
  model?: string;
  approvalPolicy?: RemoteApprovalPolicy;
  sandboxMode?: RemoteSandboxMode;
}

export interface TurnStartInput {
  text: string;
  clientMessageId?: string;
  model?: string;
  approvalPolicy?: RemoteApprovalPolicy;
  sandboxMode?: RemoteSandboxMode;
  reasoningEffort?: RemoteReasoningEffort;
  attachments?: RemoteTurnAttachment[];
}

export class ControlClient {
  readonly controlUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly idempotencyKeyFactory: IdempotencyKeyFactory;

  constructor(
    private readonly accessKey: string,
    options: ControlClientOptions = {},
  ) {
    this.accessKey = normalizeAccessKey(accessKey);
    this.fetchImpl = options.fetchImpl || fetch;
    this.idempotencyKeyFactory = options.idempotencyKeyFactory || createIdempotencyKey;
    this.controlUrl = normalizedControlUrl(options.controlUrl || controlServiceUrl);
  }

  async getSnapshot(timeoutMs = 60_000): Promise<ControlSnapshot> {
    const value = await requestJson(
      this.fetchImpl,
      `${this.controlUrl}/v1/snapshot`,
      { headers: this.authorizedHeaders() },
      timeoutMs,
    );
    const result = controlSnapshotSchema.safeParse(value);
    if (!result.success) {
      throw invalidResponse("中转服务返回的数据不符合 RHZYCODE 协议，请检查电脑版是否已更新并在线。");
    }
    return result.data;
  }

  async resolveApproval(
    approvalId: string,
    decision: "approved" | "declined",
    timeoutMs = 4000,
  ): Promise<Extract<AgentEvent, { type: "approval.resolved" }>> {
    const value = await requestJson(
      this.fetchImpl,
      `${this.controlUrl}/v1/approvals/${encodeURIComponent(approvalId)}`,
      {
        method: "POST",
        headers: this.authorizedHeaders(true),
        body: JSON.stringify({ decision }),
      },
      timeoutMs,
    );
    const result = agentEventSchema.safeParse(value);
    if (!result.success || result.data.type !== "approval.resolved" || result.data.approvalId !== approvalId) {
      throw invalidResponse("控制服务返回了无效的审批结果。");
    }
    return result.data;
  }

  async listArchivedThreads(searchTerm?: string, timeoutMs = 6000): Promise<RemoteArchivedThreadListResult> {
    const url = new URL(`${this.controlUrl}/v1/commands/threads/archived`);
    if (searchTerm?.trim()) url.searchParams.set("searchTerm", searchTerm.trim());
    const value = await requestJson(
      this.fetchImpl,
      url.toString(),
      { headers: this.authorizedHeaders() },
      timeoutMs,
    );
    const result = remoteArchivedThreadListResultSchema.safeParse(value);
    if (!result.success) throw invalidResponse("控制服务返回了无效的归档会话列表。");
    return result.data;
  }

  async listProjects(timeoutMs = 6000): Promise<RemoteProjectListResult> {
    const value = await requestJson(
      this.fetchImpl,
      `${this.controlUrl}/v1/commands/projects`,
      { headers: this.authorizedHeaders() },
      timeoutMs,
    );
    const result = remoteProjectListResultSchema.safeParse(value);
    if (!result.success) throw invalidResponse("控制服务返回了无效的工程目录列表。");
    return result.data;
  }

  async listModels(timeoutMs = 6000): Promise<RemoteModelListResult> {
    const value = await requestJson(
      this.fetchImpl,
      `${this.controlUrl}/v1/commands/models`,
      { headers: this.authorizedHeaders() },
      timeoutMs,
    );
    const result = remoteModelListResultSchema.safeParse(value);
    if (!result.success) throw invalidResponse("控制服务返回了无效的模型列表。");
    return result.data;
  }

  async openProject(projectPath: string, create = false, timeoutMs = 10_000): Promise<RemoteProjectCreateResult> {
    return this.command(
      "/v1/commands/projects",
      "POST",
      { path: projectPath, ...(create ? { create: true } : {}) },
      remoteProjectCreateResultSchema,
      "控制服务返回了无效的打开工程结果。",
      timeoutMs,
    );
  }

  async removeProject(projectPath: string, timeoutMs = 8000): Promise<RemoteProjectListResult> {
    return this.command(
      "/v1/commands/projects",
      "DELETE",
      { path: projectPath },
      remoteProjectListResultSchema,
      "控制服务返回了无效的项目移除结果。",
      timeoutMs,
    );
  }

  async browseDirectories(projectPath?: string, timeoutMs = 10_000): Promise<RemoteDirectoryBrowseResult> {
    const url = new URL(`${this.controlUrl}/v1/commands/projects/browse`);
    if (projectPath) url.searchParams.set("path", projectPath);
    const value = await requestJson(
      this.fetchImpl,
      url.toString(),
      { headers: this.authorizedHeaders() },
      timeoutMs,
    );
    const result = remoteDirectoryBrowseResultSchema.safeParse(value);
    if (!result.success) throw invalidResponse("控制服务返回了无效的电脑目录列表。");
    return result.data;
  }

  async startThread(
    input: ThreadStartInput,
    timeoutMs = 8000,
    idempotencyKey?: string,
  ): Promise<RemoteThreadStartResult> {
    return this.command(
      "/v1/commands/threads/start",
      "POST",
      input,
      remoteThreadStartResultSchema,
      "控制服务返回了无效的新会话结果。",
      timeoutMs,
      idempotencyKey,
    );
  }

  async openThread(threadId: string, timeoutMs = 60_000): Promise<RemoteThreadOpenResult> {
    const value = await requestJson(
      this.fetchImpl,
      `${this.controlUrl}/v1/commands/threads/${encodeURIComponent(threadId)}`,
      { headers: this.authorizedHeaders() },
      timeoutMs,
    );
    const result = remoteThreadOpenResultSchema.safeParse(value);
    if (!result.success) throw invalidResponse("The desktop returned an invalid conversation history.");
    return result.data;
  }

  async startTurn(
    threadId: string,
    input: TurnStartInput,
    timeoutMs = 45_000,
    idempotencyKey?: string,
  ): Promise<RemoteTurnStartResult> {
    return this.command(
      `/v1/commands/threads/${encodeURIComponent(threadId)}/turns/start`,
      "POST",
      input,
      remoteTurnStartResultSchema,
      "控制服务返回了无效的消息发送结果。",
      timeoutMs,
      idempotencyKey,
    );
  }

  async interruptTurn(threadId: string, timeoutMs = 8000): Promise<RemoteTurnInterruptResult> {
    return this.command(
      `/v1/commands/threads/${encodeURIComponent(threadId)}/turns/interrupt`,
      "POST",
      {},
      remoteTurnInterruptResultSchema,
      "控制服务返回了无效的中断结果。",
      timeoutMs,
    );
  }

  async renameThread(threadId: string, name: string, timeoutMs = 8000): Promise<RemoteThreadMutationResult> {
    return this.threadMutation(threadId, "rename", { name }, timeoutMs);
  }

  async setThreadModel(threadId: string, model: string, timeoutMs = 8000): Promise<RemoteThreadMutationResult> {
    return this.threadMutation(threadId, "model", { model }, timeoutMs);
  }

  async archiveThread(threadId: string, timeoutMs = 8000): Promise<RemoteThreadMutationResult> {
    return this.threadMutation(threadId, "archive", {}, timeoutMs);
  }

  async unarchiveThread(threadId: string, timeoutMs = 8000): Promise<RemoteThreadMutationResult> {
    return this.threadMutation(threadId, "unarchive", {}, timeoutMs);
  }

  async deleteThread(threadId: string, timeoutMs = 8000): Promise<RemoteThreadMutationResult> {
    return this.command(
      `/v1/commands/threads/${encodeURIComponent(threadId)}`,
      "DELETE",
      {},
      remoteThreadMutationResultSchema,
      "控制服务返回了无效的删除结果。",
      timeoutMs,
    );
  }

  async compactThread(threadId: string, timeoutMs = 10 * 60_000): Promise<RemoteThreadMutationResult> {
    return this.threadMutation(threadId, "compact", {}, timeoutMs);
  }

  async submitUserInput(
    requestId: string,
    answers: UserInputAnswers,
    timeoutMs = 8000,
  ): Promise<RemoteUserInputSubmitResult> {
    return this.command(
      `/v1/commands/user-inputs/${encodeURIComponent(requestId)}/submit`,
      "POST",
      { answers },
      remoteUserInputSubmitResultSchema,
      "控制服务返回了无效的回答提交结果。",
      timeoutMs,
    );
  }

  eventSocket(after: number): EventSocketDescriptor {
    const base = new URL(this.controlUrl);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/v1/events`;
    base.search = `?after=${Math.max(0, Math.floor(after))}`;
    return {
      url: base.toString(),
      protocols: ["rhzycode.v1", `rhzycode.auth.${this.accessKey}`],
    };
  }

  generatedImageSource(imageId: string): AuthenticatedImageSource {
    return {
      uri: `${this.controlUrl}/v1/generated-images/${encodeURIComponent(imageId)}`,
      headers: { Authorization: `Bearer ${this.accessKey}` },
    };
  }

  managedFileRequest(fileId: string): AuthenticatedFileRequest {
    return {
      url: `${this.controlUrl}/v1/files/${encodeURIComponent(fileId)}`,
      headers: { Authorization: `Bearer ${this.accessKey}` },
    };
  }

  parseEvent(value: unknown): AgentEvent {
    let decoded: unknown = value;
    if (typeof value === "string") {
      try {
        decoded = JSON.parse(value);
      } catch {
        throw invalidResponse("控制服务发送了无法解析的事件。");
      }
    }
    const result = agentEventSchema.safeParse(decoded);
    if (!result.success) throw invalidResponse("控制服务发送了无效事件。");
    return result.data;
  }

  parseSocketFrame(value: unknown): ControlSocketFrame {
    let decoded: unknown = value;
    if (typeof value === "string") {
      try {
        decoded = JSON.parse(value);
      } catch {
        throw invalidResponse("The control service sent an unreadable event frame.");
      }
    }
    const sync = controlSyncFrameSchema.safeParse(decoded);
    if (sync.success) return sync.data;
    const event = agentEventSchema.safeParse(decoded);
    if (event.success) return event.data;
    throw invalidResponse("The control service sent an invalid event frame.");
  }

  private authorizedHeaders(json = false): Record<string, string> {
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${this.accessKey}`,
    };
  }

  private async threadMutation(
    threadId: string,
    action: "model" | "rename" | "compact" | "archive" | "unarchive",
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<RemoteThreadMutationResult> {
    return this.command(
      `/v1/commands/threads/${encodeURIComponent(threadId)}/${action}`,
      "POST",
      body,
      remoteThreadMutationResultSchema,
      "控制服务返回了无效的会话操作结果。",
      timeoutMs,
    );
  }

  private async command<T>(
    path: string,
    method: "POST" | "DELETE",
    body: unknown,
    schema: z.ZodType<T>,
    invalidMessage: string,
    timeoutMs: number,
    idempotencyKey?: string,
  ): Promise<T> {
    const value = await requestJson(
      this.fetchImpl,
      `${this.controlUrl}${path}`,
      {
        method,
        headers: {
          ...this.authorizedHeaders(true),
          "Idempotency-Key": idempotencyKey || this.idempotencyKeyFactory(),
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    const result = schema.safeParse(value);
    if (!result.success) throw invalidResponse(invalidMessage);
    return result.data;
  }
}

export async function verifyControlAccess(
  input: ControlAccessInput,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 4000,
): Promise<ControlSnapshot> {
  const client = new ControlClient(normalizeAccessKey(input.accessKey), { fetchImpl });
  return client.getSnapshot(timeoutMs);
}

function normalizedControlUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Transfer server URL is invalid.");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const value = await readJson(response);
    if (!response.ok) throw fromHttpStatus(response.status, readServerMessage(value));
    return value;
  } catch (error) {
    if (error instanceof ControlClientError) throw error;
    if (isAbortError(error)) throw new ControlClientError("timeout", "控制服务请求超时。");
    const message = error instanceof Error ? error.message : "";
    if (/certificate|cert|ssl|tls|trust anchor/i.test(message)) {
      throw new ControlClientError("certificate", "无法验证控制服务证书。");
    }
    throw new ControlClientError("offline", "无法连接控制服务。");
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (response.ok) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType && !/[/+]json\b/i.test(contentType)) {
        throw invalidResponse("中转服务返回的不是 RHZYCODE 控制协议，请检查电脑版是否已更新并在线。");
      }
      throw invalidResponse("控制服务响应不完整，请检查 WireGuard 连接后重试。");
    }
    return null;
  }
}

function readServerMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" && error.length <= 300 ? error : undefined;
}

function fromHttpStatus(status: number, serverMessage?: string): ControlClientError {
  if (status === 502 || status === 503 || status === 504) {
    return new ControlClientError("offline", "电脑当前离线或中转服务暂时不可用。", status);
  }
  if (status === 409) return new ControlClientError("conflict", serverMessage || "请求与当前状态冲突。", status);
  if (status === 400) return new ControlClientError("invalid_request", serverMessage || "请求内容无效。", status);
  if (status === 401) return new ControlClientError("unauthorized", "保存的 KEY 无效或已失效。", status);
  if (status === 403) return new ControlClientError("forbidden", "此设备没有执行该操作的权限。", status);
  if (status === 404) return new ControlClientError("not_found", serverMessage || "请求的内容已不存在。", status);
  return new ControlClientError("server", `控制服务暂时不可用（${status}）。`, status);
}

function invalidResponse(message: string): ControlClientError {
  return new ControlClientError("invalid_response", message);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

let idempotencySequence = 0;

function createIdempotencyKey(): string {
  const cryptoWithUuid = globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined;
  if (typeof cryptoWithUuid?.randomUUID === "function") return cryptoWithUuid.randomUUID();
  idempotencySequence = (idempotencySequence + 1) % Number.MAX_SAFE_INTEGER;
  return `mobile-${Date.now().toString(36)}-${idempotencySequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
