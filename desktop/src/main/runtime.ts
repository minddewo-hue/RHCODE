import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import os from "node:os";
import path from "node:path";
import type {
  AgentEvent,
  ApprovalRequest,
  ConversationMessage,
  ThreadDetail,
  ThreadStatus,
  ThreadSummary,
  TimelineItem,
  UserInputAnswers,
  UserInputQuestion,
  UserInputRequest,
  RemoteArchivedThreadListRequest,
  RemoteArchivedThreadListResult,
  RemoteModelListResult,
  ProjectDirectory,
  RemoteProjectCreateRequest,
  RemoteProjectCreateResult,
  RemoteProjectListResult,
  RemoteDirectoryBrowseRequest,
  RemoteDirectoryBrowseResult,
  RemoteThreadMutationResult,
  RemoteThreadRenameRequest,
  RemoteThreadStartRequest,
  RemoteThreadStartResult,
  RemoteTurnInterruptResult,
  RemoteTurnStartRequest,
  RemoteTurnStartResult,
  RemoteUserInputSubmitRequest,
  RemoteUserInputSubmitResult,
} from "@rhzycode/protocol";
import {
  ControlCommandError,
  createControlPlane,
  type ControlCommandHandlers,
  type ControlPlaneHandle,
  type ControlStore,
  type MobileAccessManager,
} from "./control-plane/app";
import { AppServerClient } from "./app-server";
import { isValidSyncPort } from "./desktop-settings";
import { GatewayModule } from "./gateway-module";
import {
  ProjectDirectoryError,
  ProjectDirectoryRegistry,
} from "./project-directories";
import type { ApprovalPolicy, ComposerAttachment, ReasoningEffort, SandboxMode } from "../shared/desktop-api";
import { saveRemoteAttachments } from "./remote-attachment-store";

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

interface PendingApproval {
  rpcId: number | string;
  method: string;
  threadId: string;
  permissions?: Record<string, unknown>;
}

interface PendingUserInput {
  rpcId: number | string;
  threadId: string;
  questions: UserInputQuestion[];
}

const ROLLOUT_WRITE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;

function isRolloutNotReadyMessage(message: string): boolean {
  return /no rollout found|rollout\b.*\bis empty/i.test(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface ServerThread {
  id?: string;
  preview?: string;
  name?: string | null;
  cwd?: string;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: { type?: string; activeFlags?: string[] };
  turns?: ServerTurn[];
}

interface ServerTurn {
  id?: string;
  status?: string;
  startedAt?: number | null;
  completedAt?: number | null;
  items?: Array<Record<string, unknown>>;
}

export interface SyncModuleStatus {
  state: "stopped" | "running" | "error";
  host: string;
  port: number;
  url: string | null;
  error: string | null;
}

export interface TerminalSessionStatus {
  processId: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  output: string;
  error: string | null;
}

export class DesktopRuntime extends EventEmitter {
  readonly agent = new AppServerClient();
  readonly gateway: GatewayModule;

  private controlPlane: ControlPlaneHandle | null = null;
  private controlStoreUnsubscribe: (() => void) | null = null;
  private syncStatus: SyncModuleStatus;
  private threads = new Map<string, ThreadSummary>();
  private timelineText = new Map<string, string>();
  private itemDetails = new Map<string, string>();
  private streamingItems = new Set<string>();
  private activeTurns = new Map<string, string>();
  private pendingTurnStarts = new Set<string>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private pendingUserInputs = new Map<string, PendingUserInput>();
  private activeThreadId: string | null = null;
  private terminalSession: TerminalSessionStatus | null = null;
  private stopping = false;

  constructor(
    private readonly gatewayRoot: string,
    private readonly codexHome: string,
    private readonly syncHost = process.env.RHZYCODE_SYNC_HOST || "0.0.0.0",
    private syncPort = Number(process.env.RHZYCODE_SYNC_PORT || 8790),
    private readonly restoredControlStore?: ControlStore,
    private readonly mobileAccess?: MobileAccessManager,
    private readonly projectDirectories = new ProjectDirectoryRegistry(),
    gatewayConfigPath?: string,
  ) {
    super();
    this.gateway = new GatewayModule(gatewayRoot, undefined, gatewayConfigPath);
    this.syncStatus = {
      state: "stopped",
      host: resolveAdvertisedSyncHost(syncHost),
      port: syncPort,
      url: null,
      error: null,
    };

    const restoredAt = new Date().toISOString();
    for (const restoredThread of restoredControlStore?.snapshot().threads || []) {
      const wasActive = ["running", "waiting_for_approval", "waiting_for_input"]
        .includes(restoredThread.status);
      const thread = wasActive
        ? { ...restoredThread, status: "interrupted" as const, updatedAt: restoredAt }
        : restoredThread;
      this.threads.set(thread.id, thread);
      try {
        this.projectDirectories.remember(thread.projectPath);
      } catch {
        // Stale conversation paths remain visible but are not offered as available projects.
      }
      if (wasActive) restoredControlStore?.upsertThread(thread);
    }

    this.gateway.on("status", (status) => this.emit("gateway:status", status));
    this.agent.on("status", (status) => this.emit("agent:status", status));
    this.agent.on("diagnostic", (message) => this.emit("agent:diagnostic", message));
    this.agent.on("message", (message) => this.handleAgentMessage(message as RpcMessage));
    this.projectDirectories.on("changed", (projects) => this.emit("projects:changed", projects));
  }

  async start(): Promise<void> {
    await this.startSync();
    await this.startGatewayAndAgent();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.activeTurns.clear();
    this.pendingTurnStarts.clear();
    this.cancelPendingRequests();
    this.agent.stop();
    this.terminalSession = null;
    await this.gateway.stop().catch(() => undefined);
    await this.stopSyncServer();
    this.syncStatus = { ...this.syncStatus, state: "stopped", url: null, error: null };
    this.emit("sync:status", this.getSyncStatus());
    this.stopping = false;
  }

  async restartGateway(): Promise<void> {
    this.activeTurns.clear();
    this.pendingTurnStarts.clear();
    this.cancelPendingRequests();
    this.agent.stop();
    this.terminalSession = null;
    this.emit("terminal:status", null);
    await this.gateway.restart();
    await this.startAgent();
  }

  async stopGateway(): Promise<void> {
    this.activeTurns.clear();
    this.pendingTurnStarts.clear();
    this.cancelPendingRequests();
    this.agent.stop();
    this.terminalSession = null;
    this.emit("terminal:status", null);
    await this.gateway.stop();
  }

  async startGatewayAndAgent(): Promise<void> {
    await this.gateway.start();
    await this.startAgent();
  }

  getSyncStatus(): SyncModuleStatus {
    return { ...this.syncStatus };
  }

  async setSyncPort(port: number): Promise<SyncModuleStatus> {
    if (!isValidSyncPort(port)) throw new Error("Sync port must be between 1 and 65535.");
    if (port === this.syncPort && this.syncStatus.state === "running") return this.getSyncStatus();

    const previousPort = this.syncPort;
    const store = this.controlPlane?.store || this.restoredControlStore;
    await this.stopSyncServer();
    this.syncPort = port;
    await this.startSync(store);
    if (this.syncStatus.state === "running") return this.getSyncStatus();

    const requestedError = this.syncStatus.error || `Port ${port} is unavailable.`;
    this.syncPort = previousPort;
    await this.startSync(store);
    const restoredStatus = this.getSyncStatus();
    if (restoredStatus.state !== "running") {
      throw new Error(`${requestedError} The previous port could not be restored: ${restoredStatus.error || "unknown error"}`);
    }
    throw new Error(requestedError);
  }

  getTerminalStatus(): TerminalSessionStatus | null {
    return this.terminalSession ? { ...this.terminalSession } : null;
  }

  listProjectDirectories(): ProjectDirectory[] {
    return this.projectDirectories.list();
  }

  rememberProjectDirectory(projectPath: string): ProjectDirectory {
    return this.projectDirectories.remember(projectPath);
  }

  forgetProjectDirectory(projectPath: string): void {
    this.projectDirectories.forget(projectPath);
  }

  startTerminal(params: { cwd: string; cols?: number; rows?: number }): TerminalSessionStatus {
    if (this.terminalSession?.running) return this.getTerminalStatus()!;
    const processId = randomUUID();
    const command = terminalCommand();
    this.terminalSession = {
      processId,
      cwd: params.cwd,
      running: true,
      exitCode: null,
      output: "",
      error: null,
    };
    this.emit("terminal:status", this.getTerminalStatus());
    void this.agent.request<{ exitCode?: number; stdout?: string; stderr?: string }>(
      "command/exec",
      {
        command,
        processId,
        tty: true,
        streamStdin: true,
        streamStdoutStderr: true,
        disableTimeout: true,
        cwd: params.cwd,
        size: { cols: params.cols || 100, rows: params.rows || 30 },
      },
      null,
    ).then((result) => {
      if (this.terminalSession?.processId !== processId) return;
      const buffered = `${result.stdout || ""}${result.stderr || ""}`;
      if (buffered) this.appendTerminalOutput(processId, buffered, "stdout", false);
      this.terminalSession = {
        ...this.terminalSession,
        running: false,
        exitCode: Number(result.exitCode ?? 0),
      };
      this.emit("terminal:status", this.getTerminalStatus());
    }).catch((error) => {
      if (this.terminalSession?.processId !== processId) return;
      this.terminalSession = {
        ...this.terminalSession,
        running: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.emit("terminal:status", this.getTerminalStatus());
    });
    return this.getTerminalStatus()!;
  }

  async writeTerminal(processId: string, data: string): Promise<unknown> {
    this.requireTerminal(processId);
    return this.agent.request("command/exec/write", {
      processId,
      deltaBase64: Buffer.from(data, "utf8").toString("base64"),
      closeStdin: false,
    });
  }

  async resizeTerminal(processId: string, cols: number, rows: number): Promise<unknown> {
    this.requireTerminal(processId);
    return this.agent.request("command/exec/resize", { processId, size: { cols, rows } });
  }

  async stopTerminal(processId: string): Promise<unknown> {
    this.requireTerminal(processId);
    return this.agent.request("command/exec/terminate", { processId });
  }

  getSnapshot() {
    return this.controlPlane?.store.snapshot() || this.restoredControlStore?.snapshot() || {
      hosts: [],
      threads: [],
      timeline: [],
      approvals: [],
      userInputs: [],
      lastSequence: 0,
    };
  }

  async listModels<T>(): Promise<T> {
    return this.agent.request<T>("model/list", { cursor: null, includeHidden: false, limit: 100 });
  }

  async listThreads(options: {
    cwd?: string;
    searchTerm?: string;
    archived?: boolean;
  } = {}): Promise<ThreadSummary[]> {
    const response = await this.agent.request<{ data?: ServerThread[] }>("thread/list", {
      cursor: null,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.searchTerm?.trim() ? { searchTerm: options.searchTerm.trim() } : {}),
      archived: Boolean(options.archived),
    });
    const serverThreads = (response.data || []).flatMap((serverThread) => {
      const threadId = serverThread.id;
      if (!threadId) return [];
      const summary = toThreadSummary(
        serverThread,
        this.threads.get(threadId)?.model || "previous",
      );
      if (!options.archived) {
        this.threads.set(threadId, summary);
        this.controlPlane?.store.upsertThread(summary);
        try {
          this.projectDirectories.remember(summary.projectPath);
        } catch {
          // Threads can outlive directories that were moved or removed outside RHZYCODE.
        }
      }
      return [summary];
    });
    if (options.archived) return serverThreads;

    const serverThreadIds = new Set(serverThreads.map((thread) => thread.id));
    const timelineThreadIds = new Set(
      (this.controlPlane?.store.snapshot().timeline || []).map((item) => item.threadId),
    );
    const searchTerm = options.searchTerm?.trim().toLowerCase();
    const emptyLocalThreads = [...this.threads.values()].filter((thread) =>
      !serverThreadIds.has(thread.id)
      && thread.status === "idle"
      && !timelineThreadIds.has(thread.id)
      && (!options.cwd || comparablePath(thread.projectPath) === comparablePath(options.cwd))
      && (!searchTerm || thread.title.toLowerCase().includes(searchTerm)),
    );
    return [...serverThreads, ...emptyLocalThreads]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 100);
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.agent.request("thread/archive", { threadId });
    this.removeRuntimeThread(threadId);
  }

  async unarchiveThread(threadId: string): Promise<unknown> {
    return this.agent.request("thread/unarchive", { threadId });
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    const normalized = name.replace(/\s+/g, " ").trim();
    if (!normalized) throw new Error("Thread name cannot be empty.");
    if (normalized.length > 200) throw new Error("Thread name cannot exceed 200 characters.");
    await this.agent.request("thread/name/set", { threadId, name: normalized });
    if (this.threads.has(threadId)) this.updateThread(threadId, { title: normalized });
  }

  async deleteThread(threadId: string): Promise<void> {
    try {
      await this.agent.request("thread/delete", { threadId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.isEmptyLocalThread(threadId) || !isRolloutNotReadyMessage(message)) throw error;
    }
    this.removeRuntimeThread(threadId);
  }

  async openThread(threadId: string): Promise<ThreadDetail> {
    let response: {
      thread?: ServerThread;
      model?: string;
      cwd?: string;
    };
    let rolloutRetry = 0;
    while (true) {
      try {
        response = await this.agent.request("thread/resume", { threadId });
        break;
      } catch (error) {
        const localThread = this.threads.get(threadId);
        const message = error instanceof Error ? error.message : String(error);
        if (!localThread || !isRolloutNotReadyMessage(message)) throw error;
        if (this.isEmptyLocalThread(threadId)) {
          this.activeThreadId = threadId;
          return { thread: localThread, messages: [], timeline: [] };
        }
        if (!/rollout\b.*\bis empty/i.test(message) || rolloutRetry >= ROLLOUT_WRITE_RETRY_DELAYS_MS.length) {
          throw error;
        }
        await delay(ROLLOUT_WRITE_RETRY_DELAYS_MS[rolloutRetry]!);
        rolloutRetry += 1;
      }
    }
    if (!response.thread?.id) throw new Error("Agent Host did not return the resumed thread.");

    this.activeThreadId = response.thread.id;
    const summary = toThreadSummary(
      { ...response.thread, cwd: response.cwd || response.thread.cwd },
      response.model || this.threads.get(response.thread.id)?.model || "previous",
    );
    this.threads.set(summary.id, summary);
    this.controlPlane?.store.upsertThread(summary);

    const detail = toThreadDetail(response.thread, summary);
    for (const item of detail.timeline) this.controlPlane?.store.publish({ type: "timeline.upserted", item });
    return detail;
  }

  async startThread(params: {
    cwd: string;
    model?: string;
    approvalPolicy?: ApprovalPolicy;
    sandboxMode?: SandboxMode;
  }): Promise<{ thread?: { id?: string } }> {
    this.projectDirectories.remember(params.cwd);
    const response = await this.agent.request<{ thread?: { id?: string } }>("thread/start", {
      cwd: params.cwd,
      ...(params.model ? { model: params.model } : {}),
      ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
      sandbox: params.sandboxMode || "workspace-write",
    });
    const threadId = response.thread?.id;
    if (threadId) {
      this.activeThreadId = threadId;
      const thread: ThreadSummary = {
        id: threadId,
        hostId: "local-desktop",
        title: "新任务",
        projectPath: params.cwd,
        model: params.model || "default",
        status: "idle",
        updatedAt: new Date().toISOString(),
      };
      this.threads.set(threadId, thread);
      this.controlPlane?.store.upsertThread(thread);
    }
    return response;
  }

  async startTurn(params: {
    threadId: string;
    text: string;
    model?: string;
    approvalPolicy?: ApprovalPolicy;
    sandboxMode?: SandboxMode;
    reasoningEffort?: ReasoningEffort;
    attachments?: ComposerAttachment[];
  }): Promise<{ turn?: { id?: string } }> {
    const current = this.threads.get(params.threadId);
    this.activeThreadId = params.threadId;
    if (current) {
      this.updateThread(params.threadId, {
        title: current.title === "新任务" ? summarizeTitle(params.text) : current.title,
        status: "running",
      });
    }
    this.publishTimeline({
      id: `user-${Date.now()}`,
      threadId: params.threadId,
      kind: "user",
      status: "completed",
      title: "你",
      content: params.text,
      createdAt: new Date().toISOString(),
    });
    const attachments = validateAttachments(params.attachments || []);
    const filePaths = attachments
      .filter((attachment) => attachment.kind === "file")
      .map((attachment) => attachment.path);
    const prompt = filePaths.length > 0
      ? `${params.text}\n\nAttached files (use these absolute paths):\n${filePaths.map((filePath) => `- ${filePath}`).join("\n")}`
      : params.text;
    const input: Array<Record<string, unknown>> = [
      { type: "text", text: prompt, text_elements: [] },
      ...attachments
        .filter((attachment) => attachment.kind === "image")
        .map((attachment) => ({ type: "localImage", path: attachment.path })),
    ];
    const projectPath = current?.projectPath;
    if (!projectPath) throw new Error("Cannot apply a sandbox policy without a project directory.");
    this.pendingTurnStarts.add(params.threadId);
    try {
      const response = await this.agent.request<{ turn?: { id?: string } }>("turn/start", {
        threadId: params.threadId,
        input,
        ...(params.model ? { model: params.model } : {}),
        ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
        ...(params.reasoningEffort ? { effort: params.reasoningEffort } : {}),
        sandboxPolicy: sandboxPolicyFor(params.sandboxMode || "workspace-write", projectPath),
      });
      if (params.model && current?.model !== params.model) {
        this.updateThread(params.threadId, { model: params.model });
      }
      const turnId = response.turn?.id;
      if (turnId) this.activeTurns.set(params.threadId, turnId);
      return response;
    } catch (error) {
      this.updateThread(params.threadId, { status: "failed" });
      throw error;
    } finally {
      this.pendingTurnStarts.delete(params.threadId);
    }
  }

  async interruptTurn(threadId: string): Promise<unknown> {
    const turnId = this.activeTurns.get(threadId);
    if (!turnId) throw new Error("No active turn is available to interrupt.");
    const response = await this.agent.request("turn/interrupt", { threadId, turnId });
    this.activeTurns.delete(threadId);
    this.updateThread(threadId, { status: "interrupted" });
    this.finalizeThreadTimeline(threadId, false);
    return response;
  }

  remoteCommandHandlers(): ControlCommandHandlers {
    return {
      listModels: () => this.listRemoteModels(),
      listProjects: () => this.listRemoteProjects(),
      browseProjects: (request) => this.browseRemoteDirectories(request),
      createProject: (request) => this.createRemoteProject(request),
      listArchivedThreads: (request) => this.listRemoteArchivedThreads(request),
      startThread: (request) => this.startRemoteThread(request),
      startTurn: (threadId, request) => this.startRemoteTurn(threadId, request),
      interruptTurn: (threadId) => this.interruptRemoteTurn(threadId),
      submitUserInput: (requestId, request) => this.submitRemoteUserInput(requestId, request),
      renameThread: (threadId, request) => this.renameRemoteThread(threadId, request),
      archiveThread: (threadId) => this.archiveRemoteThread(threadId),
      unarchiveThread: (threadId) => this.unarchiveRemoteThread(threadId),
      deleteThread: (threadId) => this.deleteRemoteThread(threadId),
    };
  }

  resolveApproval(id: string, decision: "approved" | "declined"): AgentEvent {
    const event = this.controlPlane?.store.resolveApproval(id, decision);
    if (!event) throw new Error("Approval request is no longer pending.");
    return event;
  }

  resolveUserInput(id: string, answers: UserInputAnswers): AgentEvent {
    const pending = this.pendingUserInputs.get(id);
    if (!pending) throw new Error("User input request is no longer pending.");
    const responseAnswers = Object.fromEntries(
      Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
    );
    this.agent.respond(pending.rpcId, { answers: responseAnswers });
    this.pendingUserInputs.delete(id);
    const event = this.controlPlane?.store.resolveUserInput(id);
    if (!event) throw new Error("User input request is no longer pending.");
    this.updateThread(pending.threadId, { status: "running" });
    return event;
  }

  private async startSync(store: ControlStore | undefined = this.restoredControlStore): Promise<void> {
    if (this.controlPlane) return;
    let controlPlane: ControlPlaneHandle | null = null;
    try {
      const tls = resolveSyncTlsConfiguration(this.syncHost, process.env, undefined, true);
      controlPlane = await createControlPlane({
        logLevel: "warn",
        ...(store ? { store } : {}),
        ...(this.mobileAccess ? { mobileAccess: this.mobileAccess } : {}),
        ...(this.mobileAccess ? { commands: this.remoteCommandHandlers() } : {}),
        ...(tls ? { tls } : {}),
      });
      const address = await controlPlane.start({ host: this.syncHost, port: this.syncPort });
      this.controlPlane = controlPlane;
      this.controlStoreUnsubscribe = controlPlane.store.onEvent((event) => this.handleSyncEvent(event));
      const advertisedHost = resolveAdvertisedSyncHost(this.syncHost);
      this.syncStatus = {
        state: "running",
        host: advertisedHost,
        port: address.port,
        url: `${tls ? "https" : "http"}://${formatNetworkHost(advertisedHost)}:${address.port}`,
        error: null,
      };
      controlPlane.store.upsertHost({
        id: "local-desktop",
        name: os.hostname(),
        platform: platformName(),
        status: "online",
        lastSeenAt: new Date().toISOString(),
        activeTaskCount: 0,
      });
    } catch (error) {
      await controlPlane?.stop().catch(() => undefined);
      this.controlPlane = null;
      this.controlStoreUnsubscribe?.();
      this.controlStoreUnsubscribe = null;
      this.syncStatus = {
        ...this.syncStatus,
        state: "error",
        port: this.syncPort,
        url: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.emit("sync:status", this.getSyncStatus());
  }

  private async stopSyncServer(): Promise<void> {
    const controlPlane = this.controlPlane;
    this.controlPlane = null;
    this.controlStoreUnsubscribe?.();
    this.controlStoreUnsubscribe = null;
    await controlPlane?.stop().catch(() => undefined);
  }

  private async startAgent(): Promise<void> {
    const catalogPath = this.gateway.getCatalogPath();
    await this.agent.start({
      codexHome: this.codexHome,
      configOverrides: {
        model_provider: "rhzy_gateway",
        "model_providers.rhzy_gateway.name": "RHZYCODE Internal Gateway",
        "model_providers.rhzy_gateway.base_url": this.gateway.getBaseUrl(),
        "model_providers.rhzy_gateway.wire_api": "responses",
        model_catalog_json: catalogPath,
      },
    });
  }

  private handleAgentMessage(message: RpcMessage): void {
    const method = message.method || "";
    const params = message.params || {};
    if (method === "command/exec/outputDelta") {
      this.emit("agent:message", message);
      const processId = String(params.processId || "");
      const delta = decodeBase64(String(params.deltaBase64 || ""));
      this.appendTerminalOutput(
        processId,
        delta,
        String(params.stream || "stdout"),
        Boolean(params.capReached),
      );
      return;
    }
    const turnId = extractTurnId(params);
    const threadForTurn = turnId
      ? [...this.activeTurns].find((entry) => entry[1] === turnId)?.[0] || null
      : null;
    const unresolvedCandidates = new Set([...this.activeTurns.keys(), ...this.pendingTurnStarts]);
    const soleCandidate = unresolvedCandidates.size === 1 ? [...unresolvedCandidates][0] : null;
    const threadId = extractThreadId(params)
      || threadForTurn
      || soleCandidate
      || (unresolvedCandidates.size === 0 ? this.activeThreadId : null);
    this.emit("agent:message", threadId && !extractThreadId(params)
      ? { ...message, params: { ...params, threadId } }
      : message);

    if ((method === "thread/archived" || method === "thread/deleted") && threadId) {
      this.removeRuntimeThread(threadId);
      return;
    }
    if (method === "thread/name/updated" && threadId && typeof params.threadName === "string") {
      if (this.threads.has(threadId)) this.updateThread(threadId, { title: params.threadName });
      return;
    }

    if (message.id != null && method === "item/tool/requestUserInput" && threadId) {
      this.publishUserInput(message.id, params, threadId);
      return;
    }

    if (message.id != null && isApprovalRequest(method) && threadId) {
      this.publishApproval(message.id, method, params, threadId);
      return;
    }

    if (!threadId) return;
    if (method === "turn/started") {
      const turn = (params.turn || {}) as Record<string, unknown>;
      if (typeof turn.id === "string") this.activeTurns.set(threadId, turn.id);
      this.updateThread(threadId, { status: "running" });
    }
    if (method === "turn/completed") {
      const turn = (params.turn || {}) as Record<string, unknown>;
      const status = mapTurnStatus(String(turn.status || "completed"));
      this.activeTurns.delete(threadId);
      this.updateThread(threadId, { status });
      this.finalizeThreadTimeline(threadId, status === "failed");
    }
    if (method === "item/agentMessage/delta") {
      const itemId = String(params.itemId || `assistant-${threadId}`);
      const content = (this.timelineText.get(itemId) || "") + String(params.delta || "");
      this.timelineText.set(itemId, content);
      this.publishTimeline({
        id: itemId,
        threadId,
        kind: "assistant",
        status: "running",
        title: "RHZYCODE",
        content,
        createdAt: new Date().toISOString(),
      });
    }
    if (method === "item/commandExecution/outputDelta") {
      const itemId = String(params.itemId || `command-${threadId}`);
      const content = this.appendItemDetail(itemId, String(params.delta || ""), "commandExecution");
      this.publishTimeline({
        id: itemId,
        threadId,
        kind: "command",
        status: "running",
        title: "执行命令",
        content,
        createdAt: new Date().toISOString(),
      });
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const itemId = String(params.itemId || `reasoning-${threadId}`);
      const content = this.appendItemDetail(itemId, String(params.delta || ""), "reasoning");
      this.publishTimeline({
        id: itemId,
        threadId,
        kind: "notice",
        status: "running",
        title: "分析",
        content,
        createdAt: new Date().toISOString(),
      });
    }
    if (method === "turn/diff/updated") {
      const turnId = String(params.turnId || threadId);
      this.publishTimeline({
        id: `diff-${turnId}`,
        threadId,
        kind: "file_change",
        status: "running",
        title: "工作区差异",
        content: limitDetail(String(params.diff || "")),
        createdAt: new Date().toISOString(),
      });
    }
    if (method === "error") {
      const error = (params.error || {}) as Record<string, unknown>;
      const willRetry = Boolean(params.willRetry);
      this.publishTimeline({
        id: `error-${params.turnId || Date.now()}`,
        threadId,
        kind: "notice",
        status: willRetry ? "running" : "failed",
        title: willRetry ? "正在重试" : "任务失败",
        content: String(error.message || error.additionalDetails || "Agent error"),
        createdAt: new Date().toISOString(),
      });
      if (!willRetry) {
        this.activeTurns.delete(threadId);
        this.updateThread(threadId, { status: "failed" });
        this.finalizeThreadTimeline(threadId, true);
      }
    }
    if (method === "serverRequest/resolved") {
      this.resolveServerRequest(params.requestId);
    }
    if (method === "item/fileChange/patchUpdated") {
      const itemId = String(params.itemId || `file-change-${Date.now()}`);
      const content = describeFileChanges(params.changes);
      this.itemDetails.set(itemId, content);
      this.publishTimeline({
        id: itemId,
        threadId,
        kind: "file_change",
        status: "running",
        title: "修改文件",
        content,
        createdAt: new Date().toISOString(),
      });
    }
    if (method === "item/started" || method === "item/completed") {
      const item = (params.item || {}) as Record<string, unknown>;
      const itemId = String(item.id || `${method}-${Date.now()}`);
      const itemType = String(item.type || "notice");
      if (itemType === "userMessage") return;
      if (itemType === "agentMessage") {
        const content = String(item.text || this.timelineText.get(itemId) || "");
        if (!content && method === "item/started") return;
        if (method === "item/completed") this.timelineText.delete(itemId);
        this.publishTimeline({
          id: itemId,
          threadId,
          kind: "assistant",
          status: method === "item/completed" ? "completed" : "running",
          title: "",
          content,
          createdAt: new Date().toISOString(),
        });
        return;
      }
      const content = describeItem(item);
      this.itemDetails.set(itemId, content);
      if (method === "item/completed") this.streamingItems.delete(itemId);
      this.publishTimeline({
        id: itemId,
        threadId,
        kind: timelineKind(itemType),
        status: method === "item/completed" ? "completed" : "running",
        title: timelineTitle(itemType),
        content,
        createdAt: new Date().toISOString(),
      });
    }
  }

  private publishApproval(
    rpcId: number | string,
    method: string,
    params: Record<string, unknown>,
    threadId: string,
  ): void {
    if (!/commandExecution|fileChange|permissions|execCommandApproval|applyPatchApproval/.test(method)) return;
    const id = `approval-${String(rpcId)}`;
    const permissions = method === "item/permissions/requestApproval"
      ? ((params.permissions || {}) as Record<string, unknown>)
      : undefined;
    this.pendingApprovals.set(id, { rpcId, method, threadId, permissions });
    const isFileChange = /fileChange|applyPatch/.test(method);
    const isPermission = method === "item/permissions/requestApproval";
    const approval: ApprovalRequest = {
      id,
      threadId,
      kind: isPermission ? "permission" : isFileChange ? "file_change" : "command",
      title: isPermission ? "批准额外权限" : isFileChange ? "批准文件修改" : "批准命令执行",
      detail: isPermission
        ? describePermissions(params)
        : describeApproval(params, isFileChange, this.itemDetails),
      createdAt: new Date().toISOString(),
    };
    this.controlPlane?.store.publish({ type: "approval.requested", approval });
    this.updateThread(threadId, { status: "waiting_for_approval" });
  }

  private publishUserInput(
    rpcId: number | string,
    params: Record<string, unknown>,
    threadId: string,
  ): void {
    const questions = Array.isArray(params.questions)
      ? params.questions.map(normalizeUserInputQuestion).filter((value): value is UserInputQuestion => Boolean(value))
      : [];
    if (questions.length === 0) {
      this.agent.respond(rpcId, { answers: {} });
      return;
    }
    const id = `user-input-${String(rpcId)}`;
    this.pendingUserInputs.set(id, { rpcId, threadId, questions });
    const request: UserInputRequest = {
      id,
      threadId,
      questions,
      autoResolutionMs: typeof params.autoResolutionMs === "number" ? params.autoResolutionMs : null,
      createdAt: new Date().toISOString(),
    };
    this.controlPlane?.store.publish({ type: "user_input.requested", request });
    this.updateThread(threadId, { status: "waiting_for_input" });
  }

  private appendItemDetail(itemId: string, delta: string, placeholder: string): string {
    const previous = this.itemDetails.get(itemId);
    const prefix = previous && previous !== placeholder ? previous : "";
    const separator = prefix && !this.streamingItems.has(itemId) ? "\n" : "";
    const content = `${prefix}${separator}${delta}`;
    this.streamingItems.add(itemId);
    const limited = limitDetail(content);
    this.itemDetails.set(itemId, limited);
    return limited;
  }

  private resolveServerRequest(requestId: unknown): void {
    const pendingEntry = [...this.pendingUserInputs.entries()].find(
      ([, pending]) => String(pending.rpcId) === String(requestId),
    );
    if (!pendingEntry) return;
    const [id, pending] = pendingEntry;
    this.pendingUserInputs.delete(id);
    this.controlPlane?.store.resolveUserInput(id);
    this.updateThread(pending.threadId, { status: "running" });
  }

  private cancelPendingRequests(): void {
    for (const id of [...this.pendingApprovals.keys()]) {
      try {
        this.resolveApproval(id, "declined");
      } catch {
        this.pendingApprovals.delete(id);
      }
    }
    for (const id of [...this.pendingUserInputs.keys()]) {
      try {
        this.resolveUserInput(id, {});
      } catch {
        this.pendingUserInputs.delete(id);
      }
    }
  }

  private requireTerminal(processId: string): TerminalSessionStatus {
    const session = this.terminalSession;
    if (!session || session.processId !== processId || !session.running) {
      throw new Error("Terminal session is not running.");
    }
    return session;
  }

  private async startRemoteThread(
    request: RemoteThreadStartRequest,
  ): Promise<RemoteThreadStartResult> {
    const projectPath = this.findKnownProjectPath(request.projectPath);
    if (!projectPath) throw new ControlCommandError("not_found");
    try {
      const response = await this.startThread({
        cwd: projectPath,
        ...(request.model ? { model: request.model } : {}),
        approvalPolicy: request.approvalPolicy || "on-request",
        sandboxMode: request.sandboxMode || "read-only",
      });
      const threadId = response.thread?.id;
      if (!threadId) throw new ControlCommandError("unavailable");
      return { threadId, acceptedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ControlCommandError) throw error;
      throw new ControlCommandError("unavailable");
    }
  }

  private async listRemoteProjects(): Promise<RemoteProjectListResult> {
    return { projects: this.projectDirectories.list() };
  }

  private async browseRemoteDirectories(
    request: RemoteDirectoryBrowseRequest,
  ): Promise<RemoteDirectoryBrowseResult> {
    if (!request.path) {
      const roots = process.platform === "win32"
        ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`).filter((root) => fs.existsSync(root))
        : [path.parse(process.cwd()).root];
      return {
        path: null,
        parentPath: null,
        directories: roots.map((root) => ({ path: root, name: root })),
      };
    }
    const currentPath = path.resolve(request.path);
    try {
      if (!fs.statSync(currentPath).isDirectory()) throw new Error("not-directory");
      const directories = fs.readdirSync(currentPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .slice(0, 500)
        .map((entry) => ({ path: path.join(currentPath, entry.name), name: entry.name }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const root = path.parse(currentPath).root;
      return {
        path: currentPath,
        parentPath: currentPath === root ? null : path.dirname(currentPath),
        directories,
      };
    } catch {
      throw new ControlCommandError("not_found");
    }
  }

  private async listRemoteModels(): Promise<RemoteModelListResult> {
    try {
      const response = await this.listModels<{ data?: Array<RemoteModelListResult["models"][number] & {
        supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
      }> }>();
      const gatewayModels = new Map(this.gateway.getStatus().models.flatMap((model) => [
        [model.id, model] as const,
        [model.upstreamModel, model] as const,
      ]));
      return {
        models: (response.data || []).map((model) => {
          const gatewayModel = gatewayModels.get(model.model) || gatewayModels.get(model.id);
          return {
            ...model,
            ...(gatewayModel ? {
              source: gatewayModelSourceName(gatewayModel),
              sourceModelName: gatewayModel.upstreamModel,
            } : {}),
            reasoningEfforts: supportedReasoningEfforts(model),
          };
        }),
      };
    } catch {
      throw new ControlCommandError("unavailable");
    }
  }

  private async createRemoteProject(
    request: RemoteProjectCreateRequest,
  ): Promise<RemoteProjectCreateResult> {
    try {
      if (request.create) return this.projectDirectories.create(request.path);
      return { project: this.projectDirectories.remember(request.path), created: false };
    } catch (error) {
      throw mapProjectDirectoryError(error);
    }
  }

  private async listRemoteArchivedThreads(
    request: RemoteArchivedThreadListRequest,
  ): Promise<RemoteArchivedThreadListResult> {
    try {
      const threads = await this.listThreads({
        archived: true,
        ...(request.searchTerm ? { searchTerm: request.searchTerm } : {}),
      });
      return { threads };
    } catch {
      throw new ControlCommandError("unavailable");
    }
  }

  private async startRemoteTurn(
    threadId: string,
    request: RemoteTurnStartRequest,
  ): Promise<RemoteTurnStartResult> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new ControlCommandError("not_found");
    if (["running", "waiting_for_approval", "waiting_for_input"].includes(thread.status)) {
      throw new ControlCommandError("conflict");
    }
    try {
      const response = await this.startTurn({
        threadId,
        text: request.text,
        ...(request.model ? { model: request.model } : {}),
        approvalPolicy: request.approvalPolicy || "on-request",
        sandboxMode: request.sandboxMode || "read-only",
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        attachments: saveRemoteAttachments(
          path.join(this.codexHome, "temp", "mobile-attachments"),
          request.attachments || [],
        ),
      });
      return {
        threadId,
        turnId: response.turn?.id || null,
        acceptedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof ControlCommandError) throw error;
      throw new ControlCommandError("unavailable");
    }
  }

  private async interruptRemoteTurn(threadId: string): Promise<RemoteTurnInterruptResult> {
    if (!this.threads.has(threadId)) throw new ControlCommandError("not_found");
    if (!this.activeTurns.has(threadId)) throw new ControlCommandError("conflict");
    try {
      await this.interruptTurn(threadId);
      return { threadId, acceptedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ControlCommandError) throw error;
      throw new ControlCommandError("unavailable");
    }
  }

  private async submitRemoteUserInput(
    requestId: string,
    request: RemoteUserInputSubmitRequest,
  ): Promise<RemoteUserInputSubmitResult> {
    const pending = this.pendingUserInputs.get(requestId);
    if (!pending) throw new ControlCommandError("not_found");
    const questionIds = new Set(pending.questions.map((question) => question.id));
    if (Object.keys(request.answers).some((questionId) => !questionIds.has(questionId))) {
      throw new ControlCommandError("invalid");
    }
    try {
      this.resolveUserInput(requestId, request.answers);
      return { requestId, acceptedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ControlCommandError) throw error;
      throw new ControlCommandError("unavailable");
    }
  }

  private async renameRemoteThread(
    threadId: string,
    request: RemoteThreadRenameRequest,
  ): Promise<RemoteThreadMutationResult> {
    if (!this.threads.has(threadId)) throw new ControlCommandError("not_found");
    try {
      await this.renameThread(threadId, request.name);
      return { threadId, acceptedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ControlCommandError) throw error;
      throw new ControlCommandError("unavailable");
    }
  }

  private async archiveRemoteThread(threadId: string): Promise<RemoteThreadMutationResult> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new ControlCommandError("not_found");
    if (isActiveThreadStatus(thread.status)) throw new ControlCommandError("conflict");
    try {
      await this.archiveThread(threadId);
      return { threadId, acceptedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ControlCommandError) throw error;
      throw new ControlCommandError("unavailable");
    }
  }

  private async unarchiveRemoteThread(threadId: string): Promise<RemoteThreadMutationResult> {
    if (this.threads.has(threadId)) throw new ControlCommandError("conflict");
    try {
      const archivedThreads = await this.listThreads({ archived: true });
      if (!archivedThreads.some((thread) => thread.id === threadId)) {
        throw new ControlCommandError("not_found");
      }
      await this.unarchiveThread(threadId);
      const activeThreads = await this.listThreads();
      if (!activeThreads.some((thread) => thread.id === threadId)) {
        throw new ControlCommandError("unavailable");
      }
      return { threadId, acceptedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ControlCommandError) throw error;
      throw new ControlCommandError("unavailable");
    }
  }

  private async deleteRemoteThread(threadId: string): Promise<RemoteThreadMutationResult> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new ControlCommandError("not_found");
    if (isActiveThreadStatus(thread.status)) throw new ControlCommandError("conflict");
    try {
      await this.deleteThread(threadId);
      return { threadId, acceptedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ControlCommandError) throw error;
      throw new ControlCommandError("unavailable");
    }
  }

  private findKnownProjectPath(requestedPath: string): string | null {
    const normalized = comparablePath(requestedPath);
    for (const thread of this.threads.values()) {
      if (thread.projectPath && comparablePath(thread.projectPath) === normalized) {
        return path.resolve(thread.projectPath);
      }
    }
    try {
      return this.projectDirectories.remember(requestedPath).path;
    } catch {
      return null;
    }
  }

  private removeRuntimeThread(threadId: string): void {
    const existed = this.threads.delete(threadId);
    if (existed) this.controlPlane?.store.removeThread(threadId);
    if (this.activeThreadId === threadId) this.activeThreadId = null;
  }

  private isEmptyLocalThread(threadId: string): boolean {
    const thread = this.threads.get(threadId);
    const timeline = this.controlPlane?.store.snapshot().timeline || [];
    return thread?.status === "idle" && !timeline.some((item) => item.threadId === threadId);
  }

  private appendTerminalOutput(
    processId: string,
    delta: string,
    stream: string,
    capReached: boolean,
  ): void {
    if (!delta || this.terminalSession?.processId !== processId) return;
    const output = `${this.terminalSession.output}${delta}`.slice(-200_000);
    this.terminalSession = { ...this.terminalSession, output };
    this.emit("terminal:output", { processId, delta, stream, capReached });
  }

  private handleSyncEvent(event: AgentEvent): void {
    if (event.type === "approval.resolved") {
      const pending = this.pendingApprovals.get(event.approvalId);
      if (pending) {
        this.agent.respond(pending.rpcId, approvalResponse(pending, event.decision));
        this.pendingApprovals.delete(event.approvalId);
        this.updateThread(pending.threadId, { status: "running" });
      }
    }
    if (event.type === "user_input.resolved") {
      const pending = this.pendingUserInputs.get(event.requestId);
      if (pending) {
        this.agent.respond(pending.rpcId, { answers: {} });
        this.pendingUserInputs.delete(event.requestId);
        this.updateThread(pending.threadId, { status: "running" });
      }
    }
    this.emit("sync:event", event);
  }

  private updateThread(threadId: string, patch: Partial<Pick<ThreadSummary, "title" | "model" | "status">>): void {
    const current = this.threads.get(threadId);
    if (!current) return;
    const thread = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.threads.set(threadId, thread);
    this.controlPlane?.store.upsertThread(thread);
    this.updateHostTaskCount();
  }

  private updateHostTaskCount(): void {
    const activeTaskCount = [...this.threads.values()].filter((thread) =>
      ["running", "waiting_for_approval", "waiting_for_input"].includes(thread.status),
    ).length;
    this.controlPlane?.store.upsertHost({
      id: "local-desktop",
      name: os.hostname(),
      platform: platformName(),
      status: activeTaskCount > 0 ? "busy" : "online",
      lastSeenAt: new Date().toISOString(),
      activeTaskCount,
    });
  }

  private publishTimeline(item: TimelineItem): void {
    this.controlPlane?.store.publish({ type: "timeline.upserted", item });
  }

  private finalizeThreadTimeline(threadId: string, failed: boolean): void {
    const items = this.controlPlane?.store.snapshot().timeline || [];
    for (const item of items) {
      if (item.threadId !== threadId || (item.status !== "running" && item.status !== "pending")) continue;
      this.timelineText.delete(item.id);
      this.itemDetails.delete(item.id);
      this.streamingItems.delete(item.id);
      this.publishTimeline({ ...item, status: failed ? "failed" : "completed" });
    }
  }
}

const reasoningEffortValues = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function gatewayModelSourceName(model: { ownedBy: string; providerId: string }): string {
  const ownedBy = model.ownedBy.trim();
  if (ownedBy && ownedBy.toLocaleLowerCase() !== model.providerId.toLocaleLowerCase()) return ownedBy;
  if (model.providerId === "sub2api") return "Sub2API";
  return ownedBy || model.providerId;
}

function supportedReasoningEfforts(model: {
  defaultReasoningEffort: string;
  reasoningEfforts?: string[];
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
}): Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"> {
  const values = model.reasoningEfforts?.length
    ? model.reasoningEfforts
    : model.supportedReasoningEfforts?.map((option) => option.reasoningEffort || "") || [];
  const withDefault = values.length ? values : [model.defaultReasoningEffort];
  return [...new Set(withDefault)].filter((value): value is "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" => reasoningEffortValues.has(value));
}

function extractThreadId(params: Record<string, unknown>): string | null {
  if (typeof params.threadId === "string") return params.threadId;
  if (typeof params.conversationId === "string") return params.conversationId;
  const thread = params.thread as Record<string, unknown> | undefined;
  if (typeof thread?.id === "string") return thread.id;
  const turn = params.turn as Record<string, unknown> | undefined;
  return typeof turn?.threadId === "string" ? turn.threadId : null;
}

function extractTurnId(params: Record<string, unknown>): string | null {
  if (typeof params.turnId === "string") return params.turnId;
  const turn = params.turn as Record<string, unknown> | undefined;
  return typeof turn?.id === "string" ? turn.id : null;
}

function mapTurnStatus(status: string): ThreadStatus {
  if (/fail/i.test(status)) return "failed";
  if (/interrupt|cancel/i.test(status)) return "interrupted";
  return "completed";
}

function toThreadSummary(thread: ServerThread, model: string): ThreadSummary {
  const threadId = String(thread.id || "");
  const title = String(thread.name || thread.preview || "New task").replace(/\s+/g, " ").trim();
  return {
    id: threadId,
    hostId: "local-desktop",
    title: title || "New task",
    projectPath: String(thread.cwd || ""),
    model,
    status: serverThreadStatus(thread),
    updatedAt: timestampToIso(thread.updatedAt || thread.createdAt),
  };
}

function toThreadDetail(thread: ServerThread, summary: ThreadSummary): ThreadDetail {
  const messages: ConversationMessage[] = [];
  const timeline: TimelineItem[] = [];

  for (const turn of thread.turns || []) {
    const createdAt = timestampToIso(turn.startedAt || turn.completedAt || thread.updatedAt);
    for (const item of turn.items || []) {
      const itemId = String(item.id || `${turn.id || "turn"}-${messages.length + timeline.length}`);
      const itemType = String(item.type || "notice");
      if (itemType === "userMessage") {
        const images = describeUserImages(item.content);
        messages.push({
          id: itemId,
          role: "user",
          content: describeUserContent(item.content),
          ...(images.length ? { images } : {}),
        });
        continue;
      }
      if (itemType === "agentMessage") {
        messages.push({ id: itemId, role: "assistant", content: String(item.text || "") });
        continue;
      }
      timeline.push({
        id: itemId,
        threadId: summary.id,
        kind: timelineKind(itemType),
        status: timelineStatus(item, turn.status),
        title: timelineTitle(itemType),
        content: describeHistoricalItem(item),
        createdAt,
      });
    }
  }

  return { thread: summary, messages, timeline };
}

function serverThreadStatus(thread: ServerThread): ThreadStatus {
  const serverStatus = thread.status?.type || "notLoaded";
  if (serverStatus === "systemError") return "failed";
  if (serverStatus === "active") {
    if (thread.status?.activeFlags?.includes("waitingOnApproval")) return "waiting_for_approval";
    if (thread.status?.activeFlags?.includes("waitingOnUserInput")) return "waiting_for_input";
    return "running";
  }
  const lastTurn = thread.turns?.at(-1);
  if (lastTurn?.status) return mapTurnStatus(lastTurn.status);
  return "idle";
}

function describeUserContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((rawItem) => {
      const item = (rawItem || {}) as Record<string, unknown>;
      if (item.type === "text") return String(item.text || "");
      if (item.type === "skill") return `Skill: ${String(item.name || item.path || "")}`;
      if (item.type === "mention") return `Mention: ${String(item.name || item.path || "")}`;
      if (item.type === "image" || item.type === "localImage") return "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function describeUserImages(value: unknown): Array<{ path: string; name: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawItem) => {
    const item = (rawItem || {}) as Record<string, unknown>;
    if (item.type !== "image" && item.type !== "localImage") return [];
    const imagePath = String(item.path || "");
    if (!imagePath) return [];
    return [{ path: imagePath, name: path.basename(imagePath) || "image" }];
  });
}

function describeHistoricalItem(item: Record<string, unknown>): string {
  if (item.type === "reasoning") {
    return [...toStringArray(item.summary), ...toStringArray(item.content)].join("\n");
  }
  if (item.type === "plan") return String(item.text || "Plan updated");
  if (item.type === "commandExecution") {
    return [item.command, item.aggregatedOutput].filter(Boolean).join("\n");
  }
  return describeItem(item);
}

function timelineStatus(
  item: Record<string, unknown>,
  turnStatus: string | undefined,
): TimelineItem["status"] {
  const status = String(item.status || turnStatus || "completed");
  if (/fail|decline/i.test(status)) return "failed";
  if (/progress|running/i.test(status)) return "running";
  return "completed";
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function timestampToIso(timestamp?: number | null): string {
  const milliseconds = timestamp && timestamp > 10_000_000_000 ? timestamp : (timestamp || Date.now() / 1000) * 1000;
  return new Date(milliseconds).toISOString();
}

function timelineKind(type: string): TimelineItem["kind"] {
  if (/agentMessage/i.test(type)) return "assistant";
  if (/userMessage/i.test(type)) return "user";
  if (/command|exec/i.test(type)) return "command";
  if (/file|patch/i.test(type)) return "file_change";
  return "notice";
}

function timelineTitle(type: string): string {
  if (/command|exec/i.test(type)) return "执行命令";
  if (/file|patch/i.test(type)) return "修改文件";
  return "Agent 活动";
}

function describeItem(item: Record<string, unknown>): string {
  if (Array.isArray(item.changes)) return describeFileChanges(item.changes);
  if (item.type === "commandExecution") {
    return [item.command, item.aggregatedOutput].filter(Boolean).join("\n");
  }
  if (item.type === "reasoning") {
    return [...toStringArray(item.summary), ...toStringArray(item.content)].join("\n") || "reasoning";
  }
  return String(item.command || item.path || item.text || item.type || "处理中");
}

function describeFileChanges(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "等待文件差异";
  const detail = value
    .map((entry) => {
      const change = (entry || {}) as Record<string, unknown>;
      const heading = [change.kind, change.path].filter(Boolean).join(" ");
      return [heading, change.diff].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
  return limitDetail(detail || "等待文件差异");
}

function describeLegacyFileChanges(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const detail = Object.entries(value as Record<string, unknown>)
    .map(([filePath, rawChange]) => {
      const change = (rawChange || {}) as Record<string, unknown>;
      const content = change.unified_diff || change.content || change.type;
      return [filePath, content].filter(Boolean).join("\n");
    })
    .join("\n\n");
  return detail ? limitDetail(detail) : null;
}

function describeApproval(
  params: Record<string, unknown>,
  isFileChange: boolean,
  itemDetails: Map<string, string>,
): string {
  const itemId = String(params.itemId || params.callId || "");
  const itemDetail = itemId ? itemDetails.get(itemId) : null;
  const legacyChanges = isFileChange ? describeLegacyFileChanges(params.fileChanges) : null;
  const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
  return limitDetail(
    String(
      command ||
        itemDetail ||
        legacyChanges ||
        params.reason ||
        params.cwd ||
        "Agent 请求继续执行",
    ),
  );
}

function limitDetail(detail: string): string {
  const maxLength = 12_000;
  return detail.length > maxLength ? `${detail.slice(0, maxLength)}\n...` : detail;
}

function isApprovalRequest(method: string): boolean {
  return method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval" ||
    method === "execCommandApproval" ||
    method === "applyPatchApproval";
}

function approvalDecision(
  method: string,
  decision: "approved" | "declined",
): "accept" | "decline" | "approved" | "denied" {
  const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
  if (legacy) return decision === "approved" ? "approved" : "denied";
  return decision === "approved" ? "accept" : "decline";
}

function approvalResponse(
  pending: PendingApproval,
  decision: "approved" | "declined",
): Record<string, unknown> {
  if (pending.method === "item/permissions/requestApproval") {
    return {
      permissions: decision === "approved" ? grantedPermissions(pending.permissions) : {},
      scope: "turn",
    };
  }
  return { decision: approvalDecision(pending.method, decision) };
}

function grantedPermissions(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  const granted: Record<string, unknown> = {};
  if (value.network && typeof value.network === "object") granted.network = value.network;
  if (value.fileSystem && typeof value.fileSystem === "object") granted.fileSystem = value.fileSystem;
  return granted;
}

function describePermissions(params: Record<string, unknown>): string {
  const permissions = (params.permissions || {}) as Record<string, unknown>;
  const network = permissions.network as Record<string, unknown> | null | undefined;
  const fileSystem = permissions.fileSystem as Record<string, unknown> | null | undefined;
  const details = [params.reason, params.cwd];
  if (network?.enabled) details.push("Network access");
  if (fileSystem) {
    const read = Array.isArray(fileSystem.read) ? fileSystem.read : [];
    const write = Array.isArray(fileSystem.write) ? fileSystem.write : [];
    if (read.length) details.push(`Read: ${read.join(", ")}`);
    if (write.length) details.push(`Write: ${write.join(", ")}`);
    if (Array.isArray(fileSystem.entries) && fileSystem.entries.length) {
      details.push(`Additional filesystem entries: ${fileSystem.entries.length}`);
    }
  }
  return limitDetail(details.filter(Boolean).map(String).join("\n") || "Agent requested additional permissions");
}

function normalizeUserInputQuestion(value: unknown): UserInputQuestion | null {
  if (!value || typeof value !== "object") return null;
  const question = value as Record<string, unknown>;
  if (typeof question.id !== "string" || typeof question.question !== "string") return null;
  const options = Array.isArray(question.options)
    ? question.options.flatMap((rawOption) => {
      if (!rawOption || typeof rawOption !== "object") return [];
      const option = rawOption as Record<string, unknown>;
      if (typeof option.label !== "string") return [];
      return [{ label: option.label, description: String(option.description || "") }];
    })
    : null;
  return {
    id: question.id,
    header: String(question.header || ""),
    question: question.question,
    isOther: Boolean(question.isOther),
    isSecret: Boolean(question.isSecret),
    options,
  };
}

function summarizeTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 42 ? `${normalized.slice(0, 42)}...` : normalized;
}

function sandboxPolicyFor(mode: SandboxMode, projectPath: string): Record<string, unknown> {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [path.resolve(projectPath)],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function validateAttachments(attachments: ComposerAttachment[]): ComposerAttachment[] {
  if (attachments.length > 20) throw new Error("A turn can include at most 20 attachments.");
  return attachments.map((attachment) => {
    if (!path.isAbsolute(attachment.path)) throw new Error("Attachment paths must be absolute.");
    if (attachment.kind !== "file" && attachment.kind !== "image") {
      throw new Error("Unsupported attachment kind.");
    }
    return attachment;
  });
}

function platformName(): "windows" | "macos" | "linux" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function resolveAdvertisedSyncHost(
  bindHost: string,
  networkInterfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
): string {
  const normalized = bindHost.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized !== "0.0.0.0" && normalized !== "::") return bindHost;
  const candidates = Object.entries(networkInterfaces).flatMap(([name, addresses]) =>
    (addresses || []).flatMap((address) =>
      address.family === "IPv4" && !address.internal
        ? [{ name, address: address.address }]
        : []));
  candidates.sort((left, right) => networkAddressScore(left) - networkAddressScore(right));
  return candidates[0]?.address || "127.0.0.1";
}

function networkAddressScore(candidate: { name: string; address: string }): number {
  const name = candidate.name.toLowerCase();
  const virtualPenalty = /virtual|vmware|vethernet|wsl|docker|hyper-v|loopback/.test(name) ? 20 : 0;
  const address = candidate.address;
  if (address.startsWith("192.168.")) return virtualPenalty;
  if (address.startsWith("10.")) return 2 + virtualPenalty;
  const secondOctet = Number(address.split(".")[1]);
  if (address.startsWith("172.") && secondOctet >= 16 && secondOctet <= 31) {
    return 4 + virtualPenalty;
  }
  if (address.startsWith("169.254.")) return 40 + virtualPenalty;
  return 10 + virtualPenalty;
}

function formatNetworkHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function mapProjectDirectoryError(error: unknown): ControlCommandError {
  return error instanceof ProjectDirectoryError
    ? new ControlCommandError(error.code)
    : new ControlCommandError("unavailable");
}

function isActiveThreadStatus(status: ThreadStatus): boolean {
  return status === "running" || status === "waiting_for_approval" || status === "waiting_for_input";
}

export function resolveSyncTlsConfiguration(
  host: string,
  environment: NodeJS.ProcessEnv = process.env,
  readFile: (filePath: string) => Buffer = (filePath) => fs.readFileSync(filePath),
  allowInsecureLan = false,
): HttpsServerOptions | undefined {
  const certificatePath = environment.RHZYCODE_SYNC_TLS_CERT?.trim();
  const keyPath = environment.RHZYCODE_SYNC_TLS_KEY?.trim();
  const caPath = environment.RHZYCODE_SYNC_TLS_CA?.trim();
  if (Boolean(certificatePath) !== Boolean(keyPath)) {
    throw new Error("RHZYCODE_SYNC_TLS_CERT and RHZYCODE_SYNC_TLS_KEY must be configured together.");
  }
  if (!certificatePath || !keyPath) {
    if (!isLoopbackHost(host) && !allowInsecureLan) {
      throw new Error("Non-loopback control requires HTTPS/WSS certificate and key files.");
    }
    return undefined;
  }
  return {
    cert: readFile(path.resolve(certificatePath)),
    key: readFile(path.resolve(keyPath)),
    ...(caPath ? { ca: readFile(path.resolve(caPath)) } : {}),
  };
}

function terminalCommand(): string[] {
  if (process.platform === "win32") return ["powershell.exe", "-NoLogo", "-NoProfile"];
  return [process.env.SHELL || "/bin/bash", "-l"];
}

function decodeBase64(value: string): string {
  if (!value) return "";
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}
