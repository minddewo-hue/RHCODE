import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentEvent,
  ConversationFile,
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
  RemoteProjectForgetRequest,
  RemoteProjectListResult,
  RemoteDirectoryBrowseRequest,
  RemoteDirectoryBrowseResult,
  RemoteThreadMutationResult,
  RemoteThreadOpenResult,
  RemoteThreadModelRequest,
  RemoteThreadRenameRequest,
  RemoteThreadStartRequest,
  RemoteThreadStartResult,
  RemoteTurnInterruptResult,
  RemoteTurnStartRequest,
  RemoteTurnStartResult,
  RemoteUserInputSubmitRequest,
  RemoteUserInputSubmitResult,
} from "@rhzycode/protocol";
import { dedupeTimelineItems, preferTimelineItem } from "@rhzycode/protocol";
import { TimelinePublishCoalescer } from "./timeline-publish-coalesce";
import {
  summarizeTaskActivity,
  taskActivityEventFromTransition,
  type TaskActivityEvent,
  type TaskActivityStatus,
} from "./task-activity";
import {
  ControlCommandError,
  createControlPlane,
  type ControlCommandHandlers,
  type ControlPlaneHandle,
  type ControlStore,
  type MobileAccessManager,
} from "./control-plane/app";
import { AppServerClient } from "./app-server";
import { GatewayModule, type GatewayRequestEvent } from "./gateway-module";
import {
  ProjectDirectoryError,
  ProjectDirectoryRegistry,
} from "./project-directories";
import type {
  ApprovalPolicy,
  ComposerAttachment,
  ConversationExportItem,
  ModelListResponse,
  ReasoningEffort,
  RendererBootstrapState,
  ModelOption,
  SandboxMode,
  SkillInfo,
  SkillLoadError,
  SkillScope,
} from "../shared/desktop-api";
import { turnScopedItemId } from "../shared/item-identity";
import { removeRemoteAttachments, saveRemoteAttachments } from "./remote-attachment-store";
import {
  materializeGeneratedImage,
  type StoredGeneratedImage,
} from "./generated-image-store";
import {
  loadRolloutGeneratedImages,
  type RolloutGeneratedImage,
} from "./generated-image-rollout";
import { loadRolloutThreadState } from "./rollout-thread-state";
import {
  loadLocalRolloutThread,
  loadRolloutUploadedImages,
  reconcileRolloutUploadedImages,
} from "./local-rollout-thread";
import {
  backupProjectConversations as createConversationBackup,
  backupSelectedConversations as createSelectedConversationBackup,
  deleteConversationSessionFiles,
  listConversationSessions,
  listConversationSessionsWithDuplicates,
  listProjectConversationThreadIds,
  restoreProjectConversations as restoreConversationBackup,
  type ConversationBackupResult,
  type ConversationRestoreResult,
} from "./conversation-backup";
import { desktopHostPlatform } from "./platform/desktop-platform";
import {
  ManagedFileStore,
  resolveArtifactPaths,
  type ManagedFileRecord,
} from "./managed-file-store";
import { DesktopRelayClient } from "./desktop-relay-client";
import {
  approvalResponse,
  createApprovalRequest,
  isApprovalRequest,
  type ApprovalMethod,
  type PendingApproval,
} from "./approval-protocol";

const DEFAULT_TRANSFER_SERVER_URL = "http://218.201.210.211:8000";

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

interface PendingUserInput {
  rpcId: number | string;
  threadId: string;
  questions: UserInputQuestion[];
}

interface PendingCompaction {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingGatewayFailure {
  threadId: string;
  timer: NodeJS.Timeout;
}

const ROLLOUT_WRITE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const INTERNAL_MODEL_PROVIDER_ID = "rhzy_gateway";
const MAX_CACHED_THREAD_DETAILS = 10;
const GATEWAY_FAILURE_GRACE_MS = 15_000;
/** Bound App Server resume during mobile openThread so flaky links still get a local payload. */
function mobileOpenResumeBudgetMs(): number {
  const parsed = Number(process.env.RHZYCODE_MOBILE_OPEN_RESUME_MS || 12_000);
  return Math.max(250, Number.isFinite(parsed) ? parsed : 12_000);
}

function isRolloutNotReadyMessage(message: string): boolean {
  return /no rollout found|rollout\b.*\bis empty/i.test(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isAgentUnavailableBeforeRequest(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Agent Host is not running|Agent Host input is unavailable/i.test(message);
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      },
    );
  });
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

interface ServerSkill {
  name: string;
  description: string;
  enabled: boolean;
  path: string;
  scope: SkillScope;
  shortDescription?: string | null;
  interface?: {
    displayName?: string | null;
    shortDescription?: string | null;
  } | null;
}

interface ServerSkillsListResponse {
  data: Array<{
    cwd: string;
    skills: ServerSkill[];
    errors: SkillLoadError[];
  }>;
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
  private readonly timelinePublishCoalescer = new TimelinePublishCoalescer((item) => {
    this.controlPlane?.store.publish({ type: "timeline.upserted", item });
  });
  private activeTurns = new Map<string, string>();
  private turnClientMessageIds = new Map<string, string>();
  private pendingTurnStarts = new Set<string>();
  private remoteAttachments = new Map<string, string[]>();
  private loadedThreadIds = new Set<string>();
  private threadLoadPromises = new Map<string, Promise<ThreadDetail>>();
  private threadDetailCache = new Map<string, ThreadDetail>();
  private publishedGeneratedImageIds = new Set<string>();
  private publishedManagedFileIds = new Set<string>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private pendingUserInputs = new Map<string, PendingUserInput>();
  private pendingCompactions = new Map<string, PendingCompaction>();
  private pendingGatewayFailures = new Map<string, PendingGatewayFailure>();
  private gatewayFailureGraceMs = GATEWAY_FAILURE_GRACE_MS;
  private activeThreadId: string | null = null;
  private terminalSession: TerminalSessionStatus | null = null;
  private stopping = false;
  private readonly managedFiles: ManagedFileStore;
  private readonly desktopRelay: DesktopRelayClient | null;
  private readonly syncHost = "127.0.0.1";
  private readonly syncPort = 0;

  constructor(
    private readonly gatewayRoot: string,
    private readonly codexHome: string,
    private readonly restoredControlStore?: ControlStore,
    private readonly mobileAccess?: MobileAccessManager,
    private readonly projectDirectories = new ProjectDirectoryRegistry(),
    gatewayConfigPath?: string,
    fetchImpl?: typeof fetch,
  ) {
    super();
    this.gateway = new GatewayModule(gatewayRoot, undefined, gatewayConfigPath, fetchImpl);
    const transferServerUrl = process.env.RHZYCODE_TRANSFER_SERVER_URL?.trim() || DEFAULT_TRANSFER_SERVER_URL;
    this.desktopRelay = mobileAccess && transferServerUrl
      ? new DesktopRelayClient({ serverUrl: transferServerUrl, fetchImpl })
      : null;
    this.desktopRelay?.on("error", (error) => this.emit(
      "agent:diagnostic",
      `Public relay connection failed: ${error instanceof Error ? error.message : String(error)}`,
    ));
    this.managedFiles = new ManagedFileStore(path.join(codexHome, "attachments"));
    removeRemoteAttachments(path.join(codexHome, "temp", "mobile-attachments"));
    this.syncStatus = {
      state: "stopped",
      host: this.syncHost,
      port: this.syncPort,
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
      if (wasActive) restoredControlStore?.upsertThread(thread);
    }

    this.gateway.on("status", (status) => this.emit("gateway:status", status));
    this.gateway.on("request", (event: GatewayRequestEvent) => this.handleGatewayRequest(event));
    this.agent.on("status", (status) => this.emit("agent:status", status));
    this.agent.on("diagnostic", (message) => this.emit("agent:diagnostic", message));
    this.agent.on("message", (message) => this.handleAgentMessage(message as RpcMessage));
    this.projectDirectories.on("changed", (projects) => {
      this.emit("projects:changed", projects);
      this.controlPlane?.store.setProjects(projects);
    });
    mobileAccess?.on("status", (status) => {
      const accessKey = status.accessKey?.key;
      if (accessKey && this.syncStatus.url) this.desktopRelay?.updateAccess(this.syncStatus.url, accessKey);
    });
  }

  async start(): Promise<void> {
    const agentStartup = this.startGatewayAndAgent();
    void this.startSync().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("agent:diagnostic", `Mobile sync failed to start: ${message}`);
    });
    await agentStartup;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.activeTurns.clear();
    this.pendingTurnStarts.clear();
    this.clearAllGatewayFailures();
    for (const pending of this.pendingCompactions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Agent Host stopped during conversation compaction."));
    }
    this.pendingCompactions.clear();
    this.timelinePublishCoalescer.dispose();
    this.loadedThreadIds.clear();
    this.threadLoadPromises.clear();
    this.threadDetailCache.clear();
    this.publishedGeneratedImageIds.clear();
    this.clearAllRemoteAttachments();
    this.cancelPendingRequests();
    this.agent.stop();
    this.desktopRelay?.stop();
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
    this.clearAllGatewayFailures();
    this.clearAllRemoteAttachments();
    this.cancelPendingRequests();
    this.agent.stop();
    this.terminalSession = null;
    this.emit("terminal:status", null);
    const gatewayStatus = await this.gateway.restart();
    if (gatewayStatus.state === "running") await this.startAgent();
  }

  async stopGateway(): Promise<void> {
    this.activeTurns.clear();
    this.pendingTurnStarts.clear();
    this.clearAllGatewayFailures();
    this.clearAllRemoteAttachments();
    this.cancelPendingRequests();
    this.agent.stop();
    this.terminalSession = null;
    this.emit("terminal:status", null);
    await this.gateway.stop();
  }

  async startGatewayAndAgent(): Promise<void> {
    const gatewayStatus = await this.gateway.start();
    if (gatewayStatus.state === "running") await this.startAgent();
  }

  getSyncStatus(): SyncModuleStatus {
    return { ...this.syncStatus };
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

  async deleteProjectDirectory(projectPath: string): Promise<{ deletedConversationCount: number }> {
    const removalSequence = this.controlPlane?.store.snapshot().lastSequence;
    const diskThreadIds = await listProjectConversationThreadIds(this.codexHome, projectPath);
    const runtimeThreads = [...this.threads.values()].filter((thread) =>
      thread.projectPath && comparablePath(thread.projectPath) === comparablePath(projectPath));
    const threadIds = [...new Set([
      ...diskThreadIds,
      ...runtimeThreads.map((thread) => thread.id),
    ])];
    for (const thread of runtimeThreads) {
      if (this.activeTurns.has(thread.id)) await this.interruptTurn(thread.id);
      else if (this.pendingTurnStarts.has(thread.id)) {
        throw new Error(`Wait for the task "${thread.title}" to finish starting, then delete the project again.`);
      }
    }
    await Promise.all(threadIds.map((threadId) => this.requestPermanentThreadDeletion(threadId, true)));
    await deleteConversationSessionFiles(this.codexHome, threadIds);
    for (const threadId of threadIds) {
      this.managedFiles.removeThread(threadId);
      this.removeRuntimeThread(threadId, removalSequence);
    }

    this.projectDirectories.forget(projectPath);
    return { deletedConversationCount: threadIds.length };
  }

  backupProjectConversations(
    projectPath: string,
    destinationPath: string,
  ): Promise<ConversationBackupResult> {
    return createConversationBackup(this.codexHome, projectPath, destinationPath);
  }

  exportConversations(
    threadIds: string[],
    destinationPath: string,
  ): Promise<ConversationBackupResult> {
    return createSelectedConversationBackup(this.codexHome, threadIds, destinationPath);
  }

  async listExportConversations(): Promise<ConversationExportItem[]> {
    return (await listConversationSessions(this.codexHome)).map((session) => ({
      threadId: session.threadId,
      projectPath: session.projectPath,
      title: session.title,
      archived: session.archived,
      modifiedAt: session.modifiedAt,
    }));
  }

  async restoreProjectConversations(backupPath: string): Promise<ConversationRestoreResult> {
    const result = await restoreConversationBackup(this.codexHome, backupPath);
    for (const projectPath of result.projectPaths) {
      try {
        this.projectDirectories.remember(projectPath);
      } catch {
        // Restored conversations remain usable even when their original directory was moved.
      }
    }
    return result;
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
      projects: this.projectDirectories.list(),
      threads: [],
      timeline: [],
      approvals: [],
      userInputs: [],
      lastSequence: 0,
    };
  }

  getRendererBootstrapState(): RendererBootstrapState {
    const { threads, approvals, userInputs } = this.getSnapshot();
    return { threads, approvals, userInputs };
  }

  async listModels(): Promise<ModelListResponse> {
    const response = await this.agent.request<{
      data?: Array<Omit<ModelOption, "supportedReasoningEfforts" | "isDefault"> & {
        supportedReasoningEfforts?: ModelOption["supportedReasoningEfforts"];
        isDefault?: boolean;
      }>;
    }>("model/list", { cursor: null, includeHidden: false, limit: 100 });
    return {
      ...response,
      data: response.data?.map((model) => ({
        ...model,
        supportedReasoningEfforts: model.supportedReasoningEfforts || [],
        isDefault: model.isDefault === true,
      })),
    };
  }

  async listSkills(forceReload = false): Promise<{
    skills: Array<Omit<SkillInfo, "canRemove">>;
    errors: SkillLoadError[];
  }> {
    const projectPaths = this.projectDirectories.list().map((project) => project.path);
    const response = await this.agent.request<ServerSkillsListResponse>("skills/list", {
      cwds: projectPaths.length > 0 ? projectPaths : [path.resolve(process.cwd())],
      forceReload,
    });
    const skills = new Map<string, Omit<SkillInfo, "canRemove">>();
    const errors = new Map<string, SkillLoadError>();
    for (const entry of response.data || []) {
      for (const skill of entry.skills || []) {
        const key = comparablePath(skill.path);
        if (skills.has(key)) continue;
        const shortDescription = skill.interface?.shortDescription
          || skill.shortDescription
          || null;
        skills.set(key, {
          name: skill.name,
          displayName: skill.interface?.displayName || skill.name,
          description: skill.description,
          shortDescription,
          enabled: skill.enabled,
          path: skill.path,
          scope: skill.scope,
        });
      }
      for (const error of entry.errors || []) {
        errors.set(`${comparablePath(error.path)}\0${error.message}`, error);
      }
    }
    const scopeOrder: Record<SkillScope, number> = { user: 0, repo: 1, system: 2, admin: 3 };
    return {
      skills: [...skills.values()].sort((left, right) =>
        scopeOrder[left.scope] - scopeOrder[right.scope]
        || left.displayName.localeCompare(right.displayName)),
      errors: [...errors.values()],
    };
  }

  async setSkillEnabled(skillPath: string, enabled: boolean): Promise<boolean> {
    const response = await this.agent.request<{ effectiveEnabled: boolean }>(
      "skills/config/write",
      { path: skillPath, enabled },
    );
    return response.effectiveEnabled;
  }

  async listThreads(options: {
    cwd?: string;
    searchTerm?: string;
    archived?: boolean;
  } = {}): Promise<ThreadSummary[]> {
    let response: { data?: ServerThread[] } = { data: [] };
    try {
      response = await this.agent.request<{ data?: ServerThread[] }>("thread/list", {
        cursor: null,
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.searchTerm?.trim() ? { searchTerm: options.searchTerm.trim() } : {}),
        archived: Boolean(options.archived),
      });
    } catch {
      // The local session index below remains available without App Server or network access.
    }
    const listedServerThreads = (response.data || []).flatMap((serverThread) => {
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
    const conversationListing = await listConversationSessionsWithDuplicates(this.codexHome);
    const duplicateThreadIds = new Set(conversationListing.duplicateThreadIds);
    for (const duplicateThreadId of duplicateThreadIds) this.removeRuntimeThread(duplicateThreadId);
    const serverThreads = listedServerThreads.filter((thread) => !duplicateThreadIds.has(thread.id));
    const serverThreadIds = new Set(serverThreads.map((thread) => thread.id));
    const diskSessions = conversationListing.sessions
      .filter((session) => session.archived === Boolean(options.archived));
    const searchTerm = options.searchTerm?.trim().toLowerCase();
    const matchesOptions = (thread: ThreadSummary) => (
      (!options.cwd || comparablePath(thread.projectPath) === comparablePath(options.cwd))
      && (!searchTerm || thread.title.toLowerCase().includes(searchTerm))
    );
    const diskThreads = diskSessions.flatMap((session) => {
      if (serverThreadIds.has(session.threadId)) return [];
      const existing = this.threads.get(session.threadId);
      const summary: ThreadSummary = existing || {
        id: session.threadId,
        hostId: "local-desktop",
        title: session.title,
        projectPath: session.projectPath,
        model: session.model,
        status: "completed",
        updatedAt: session.modifiedAt,
      };
      if (!matchesOptions(summary)) return [];
      if (!session.archived) {
        this.threads.set(summary.id, summary);
        this.controlPlane?.store.upsertThread(summary);
        try {
          this.projectDirectories.remember(summary.projectPath);
        } catch {
          // A restored conversation can outlive a project directory that was moved.
        }
      }
      return [summary];
    });
    if (options.archived) {
      return [...serverThreads, ...diskThreads]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 100);
    }

    const diskThreadIds = new Set(diskSessions.map((session) => session.threadId));
    const timelineThreadIds = new Set(
      (this.controlPlane?.store.snapshot().timeline || []).map((item) => item.threadId),
    );
    const emptyLocalThreads = [...this.threads.values()].filter((thread) =>
      !serverThreadIds.has(thread.id)
      && !diskThreadIds.has(thread.id)
      && thread.status === "idle"
      && !timelineThreadIds.has(thread.id)
      && matchesOptions(thread),
    );
    return [...serverThreads, ...diskThreads, ...emptyLocalThreads]
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

  setThreadModel(threadId: string, model: string): ThreadSummary {
    const normalized = model.trim();
    if (!normalized || normalized.length > 500 || normalized.includes("\0")) {
      throw new Error("Thread model is invalid.");
    }
    if (!this.threads.has(threadId)) throw new Error("Thread not found.");
    this.gateway.setThreadModel(threadId, normalized);
    this.updateThread(threadId, { model: normalized });
    return this.threads.get(threadId)!;
  }

  async deleteThread(threadId: string): Promise<void> {
    const removalSequence = this.controlPlane?.store.snapshot().lastSequence;
    if (this.activeTurns.has(threadId)) await this.interruptTurn(threadId);
    else if (this.pendingTurnStarts.has(threadId)) {
      throw new Error("Wait for the task to finish starting, then delete the conversation again.");
    }
    await this.requestPermanentThreadDeletion(threadId, true);
    await deleteConversationSessionFiles(this.codexHome, [threadId]);
    this.managedFiles.removeThread(threadId);
    this.removeRuntimeThread(threadId, removalSequence);
  }

  private async requestPermanentThreadDeletion(threadId: string, allowDiskFallback = false): Promise<void> {
    try {
      await this.agent.request("thread/delete", { threadId }, 5_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isEmptyLocalThread(threadId) && isRolloutNotReadyMessage(message)) return;
      if (!allowDiskFallback) throw error;
      this.emit("agent:diagnostic", `App Server index cleanup failed for ${threadId}: ${message}`);
    }
  }

  async openThread(threadId: string, requireAgent = false): Promise<ThreadDetail> {
    const cached = !requireAgent || this.loadedThreadIds.has(threadId)
      ? this.threadDetailCache.get(threadId)
      : null;
    if (cached) {
      // Never treat sparse local fallback as an agent-backed load. A flaky
      // resume must not permanently hide assistant replies behind this cache.
      if (!requireAgent || !isIncompleteRolloutHistory(cached)) {
        this.rememberThreadDetail(threadId, cached);
        this.activeThreadId = threadId;
        return cached;
      }
      this.loadedThreadIds.delete(threadId);
      this.threadDetailCache.delete(threadId);
    }
    const pending = this.threadLoadPromises.get(threadId);
    if (pending) {
      const detail = await pending;
      if (!requireAgent || (
        this.loadedThreadIds.has(threadId) && !isIncompleteRolloutHistory(detail)
      )) {
        return detail;
      }
    }

    const operation = requireAgent
      ? this.resumeThread(threadId)
      : this.loadThreadForDisplay(threadId);
    this.threadLoadPromises.set(threadId, operation);
    try {
      const detail = await operation;
      this.rememberThreadDetail(threadId, detail);
      return detail;
    } finally {
      if (this.threadLoadPromises.get(threadId) === operation) {
        this.threadLoadPromises.delete(threadId);
      }
    }
  }

  private async loadThreadForDisplay(threadId: string): Promise<ThreadDetail> {
    const localThread = this.threads.get(threadId);
    const localDetail = localThread
      ? await this.loadLocalThreadDetail(localThread)
      : null;

    // Complete local history can be shown without waking App Server. Sparse
    // rollouts (user turns without assistant finals) are common while a turn is
    // still tool-calling or after some Codex builds omit agent_message rows;
    // resume fills those missing replies when the agent is available.
    if (localDetail && !isIncompleteRolloutHistory(localDetail)) {
      this.activeThreadId = threadId;
      return localDetail;
    }

    try {
      const resumed = await this.resumeThread(threadId);
      return preferRicherThreadDetail(localDetail, resumed);
    } catch (error) {
      if (localDetail) {
        this.activeThreadId = threadId;
        return localDetail;
      }
      throw error;
    }
  }

  private async loadLocalThreadDetail(thread: ThreadSummary): Promise<ThreadDetail | null> {
    const managedFiles = await this.loadManagedThreadFiles(thread.id);
    return loadLocalRolloutThread(this.codexHome, thread, managedFiles, {
      materializeArtifacts: (turnId, content) => resolveArtifactPaths(thread.projectPath, [content])
        .flatMap((filePath) => {
          const record = this.managedFiles.storeGenerated(thread.id, turnId, filePath);
          return record ? [record] : [];
        }),
    });
  }

  private async loadManagedThreadFiles(threadId: string): Promise<ManagedFileRecord[]> {
    const rolloutImages = await loadRolloutUploadedImages(this.codexHome, threadId);
    const existing = this.managedFiles.listThread(threadId);
    const existingByTurn = new Map<string, number>();
    for (const file of existing) {
      if (file.source !== "upload" || file.kind !== "image") continue;
      const key = file.turnId || "\u0000";
      existingByTurn.set(key, (existingByTurn.get(key) || 0) + 1);
    }

    const seenByTurn = new Map<string, number>();
    for (const image of rolloutImages) {
      const key = image.turnId || "\u0000";
      const seen = seenByTurn.get(key) || 0;
      seenByTurn.set(key, seen + 1);
      if (seen < (existingByTurn.get(key) || 0)) continue;
      this.managedFiles.storeUploadedImageData(threadId, image.turnId, image.dataUrl, image.name);
    }
    return reconcileRolloutUploadedImages(this.managedFiles.listThread(threadId), rolloutImages);
  }

  private async resumeThread(threadId: string): Promise<ThreadDetail> {
    let response: {
      thread?: ServerThread;
      model?: string;
      cwd?: string;
    };
    let rolloutRetry = 0;
    while (true) {
      try {
        response = await this.agent.request("thread/resume", {
          threadId,
          modelProvider: INTERNAL_MODEL_PROVIDER_ID,
        });
        break;
      } catch (error) {
        const localThread = this.threads.get(threadId);
        const message = error instanceof Error ? error.message : String(error);
        if (localThread) {
          const localDetail = await this.loadLocalThreadDetail(localThread);
          if (localDetail) {
            this.activeThreadId = threadId;
            // Incomplete rollouts are display fallbacks only. Marking them loaded
            // poisons later requireAgent opens so AI replies stay missing.
            if (isIncompleteRolloutHistory(localDetail)) {
              this.loadedThreadIds.delete(threadId);
              this.threadDetailCache.delete(threadId);
            } else {
              this.loadedThreadIds.add(threadId);
            }
            return localDetail;
          }
        }
        if (!localThread || !isRolloutNotReadyMessage(message)) throw error;
        if (this.isEmptyLocalThread(threadId)) {
          this.activeThreadId = threadId;
          this.loadedThreadIds.add(threadId);
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
    this.loadedThreadIds.add(response.thread.id);
    const storedModel = this.threads.get(response.thread.id)?.model;
    const summary = toThreadSummary(
      { ...response.thread, cwd: response.cwd || response.thread.cwd },
      preferredStoredModel(storedModel, response.model),
    );
    this.threads.set(summary.id, summary);
    this.controlPlane?.store.upsertThread(summary);

    const rolloutImages = loadRolloutGeneratedImages(this.codexHome, summary.id);
    for (const image of rolloutImages) {
      this.publishedGeneratedImageIds.add(generatedImageKey(summary.id, image.turnId, image.id));
    }
    for (const turn of response.thread.turns || []) {
      const turnId = typeof turn.id === "string" ? turn.id : null;
      for (const item of turn.items || []) {
        if (item.type !== "agentMessage" && item.type !== "fileChange") continue;
        const values: unknown[] = [item.text];
        if (Array.isArray(item.changes)) values.push(...item.changes);
        for (const filePath of resolveArtifactPaths(summary.projectPath, values)) {
          this.managedFiles.storeGenerated(summary.id, turnId, filePath);
        }
      }
    }
    const managedFiles = await this.loadManagedThreadFiles(summary.id);
    for (const file of managedFiles) this.publishedManagedFileIds.add(file.id);
    const detail = toThreadDetail(
      response.thread,
      summary,
      path.join(this.codexHome, "generated_images"),
      rolloutImages,
      managedFiles,
    );
    for (const item of detail.timeline) this.controlPlane?.store.publish({ type: "timeline.upserted", item });
    for (const item of toGeneratedImageTimeline(
      response.thread,
      summary,
      path.join(this.codexHome, "generated_images"),
    )) {
      this.controlPlane?.store.publish({ type: "timeline.upserted", item });
    }
    for (const image of rolloutImages) {
      this.controlPlane?.store.publish({
        type: "timeline.upserted",
        item: generatedImageTimelineItem(image.id, summary.id, image.image, image.createdAt),
      });
    }
    return detail;
  }

  async startThread(params: {
    cwd: string;
    model?: string;
    approvalPolicy?: ApprovalPolicy;
    sandboxMode?: SandboxMode;
  }): Promise<{ thread?: { id?: string } }> {
    this.projectDirectories.remember(params.cwd);
    const request = {
      cwd: params.cwd,
      modelProvider: INTERNAL_MODEL_PROVIDER_ID,
      ...(params.model ? { model: params.model } : {}),
      ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
      sandbox: params.sandboxMode || "workspace-write",
    };
    let response: { thread?: { id?: string } };
    try {
      response = await this.agent.request<{ thread?: { id?: string } }>("thread/start", request);
    } catch (error) {
      if (!isAgentUnavailableBeforeRequest(error)) throw error;
      await this.restartGateway();
      response = await this.agent.request<{ thread?: { id?: string } }>("thread/start", request);
    }
    const threadId = response.thread?.id;
    if (threadId) {
      if (params.model) this.gateway.setThreadModel(threadId, params.model);
      this.activeThreadId = threadId;
      this.loadedThreadIds.add(threadId);
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
    clientMessageId?: string;
    model?: string;
    approvalPolicy?: ApprovalPolicy;
    sandboxMode?: SandboxMode;
    reasoningEffort?: ReasoningEffort;
    attachments?: ComposerAttachment[];
  }): Promise<{ turn?: { id?: string }; files?: ConversationFile[] }> {
    if (!this.loadedThreadIds.has(params.threadId)) {
      await this.openThread(params.threadId, true);
    }
    const current = this.threads.get(params.threadId);
    this.activeThreadId = params.threadId;
    if (params.model) {
      try {
        await this.prepareThreadModel(params.threadId, params.model);
      } catch (error) {
        this.updateThread(params.threadId, { status: "failed" });
        throw error;
      }
    }
    if (current) {
      this.updateThread(params.threadId, {
        title: current.title === "新任务" ? summarizeTitle(params.text) : current.title,
        status: "running",
      });
    }
    const attachments = validateAttachments(params.attachments || []);
    const managedAttachments = this.managedFiles.registerUploads(params.threadId, attachments);
    this.publishTimeline({
      id: params.clientMessageId ? `user-${params.clientMessageId}` : `user-${Date.now()}`,
      threadId: params.threadId,
      ...(params.clientMessageId ? { clientMessageId: params.clientMessageId } : {}),
      kind: "user",
      status: "completed",
      title: "你",
      content: params.text,
      ...(managedAttachments.length ? {
        files: managedAttachments.map((attachment) => managedFileReference(attachment)),
      } : {}),
      createdAt: new Date().toISOString(),
    });
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
      if (turnId) {
        this.activeTurns.set(params.threadId, turnId);
        if (params.clientMessageId) this.turnClientMessageIds.set(turnId, params.clientMessageId);
        this.managedFiles.bindTurn(managedAttachments.map((attachment) => attachment.id), turnId);
      }
      const files = managedAttachments.map((attachment) => managedFileReference(attachment, true));
      return { ...response, ...(files.length ? { files } : {}) };
    } catch (error) {
      this.managedFiles.removeRecords(managedAttachments.map((attachment) => attachment.id));
      this.updateThread(params.threadId, { status: "failed" });
      throw error;
    } finally {
      this.pendingTurnStarts.delete(params.threadId);
    }
  }

  async interruptTurn(threadId: string): Promise<unknown> {
    const turnId = this.activeTurns.get(threadId);
    if (!turnId) throw new Error("No active turn is available to interrupt.");
    this.clearGatewayFailure(turnId);
    const interruptRequest = this.agent.request("turn/interrupt", { threadId, turnId });
    this.gateway.interruptTurn(turnId);
    const response = await interruptRequest;
    this.activeTurns.delete(threadId);
    this.updateThread(threadId, { status: "interrupted" });
    this.finalizeThreadTimeline(threadId, false);
    this.clearRemoteAttachments(threadId);
    return response;
  }

  remoteCommandHandlers(): ControlCommandHandlers {
    return {
      listModels: () => this.listRemoteModels(),
      listProjects: () => this.listRemoteProjects(),
      browseProjects: (request) => this.browseRemoteDirectories(request),
      createProject: (request) => this.createRemoteProject(request),
      forgetProject: (request) => this.forgetRemoteProject(request),
      listArchivedThreads: (request) => this.listRemoteArchivedThreads(request),
      startThread: (request) => this.startRemoteThread(request),
      openThread: (threadId) => this.openRemoteThread(threadId),
      startTurn: (threadId, request) => this.startRemoteTurn(threadId, request),
      interruptTurn: (threadId) => this.interruptRemoteTurn(threadId),
      submitUserInput: (requestId, request) => this.submitRemoteUserInput(requestId, request),
      setThreadModel: (threadId, request) => this.setRemoteThreadModel(threadId, request),
      renameThread: (threadId, request) => this.renameRemoteThread(threadId, request),
      compactThread: (threadId) => this.compactRemoteThread(threadId),
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
      controlPlane = await createControlPlane({
        logLevel: "warn",
        ...(store ? { store } : {}),
        ...(this.mobileAccess ? { mobileAccess: this.mobileAccess } : {}),
        ...(this.mobileAccess ? { commands: this.remoteCommandHandlers() } : {}),
        generatedImageDirectory: path.join(this.codexHome, "generated_images"),
        managedFiles: this.managedFiles,
      });
      const address = await controlPlane.start({ host: this.syncHost, port: this.syncPort });
      this.controlPlane = controlPlane;
      this.controlStoreUnsubscribe = controlPlane.store.onEvent((event) => this.handleSyncEvent(event));
      controlPlane.store.setProjects(this.projectDirectories.list());
      this.syncStatus = {
        state: "running",
        host: this.syncHost,
        port: address.port,
        url: `http://${this.syncHost}:${address.port}`,
        error: null,
      };
      const accessKey = this.mobileAccess?.status().accessKey?.key;
      if (accessKey && this.syncStatus.url) this.desktopRelay?.updateAccess(this.syncStatus.url, accessKey);
      controlPlane.store.upsertHost({
        id: "local-desktop",
        name: os.hostname(),
        platform: desktopHostPlatform(),
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
    if (this.agent.getStatus().state === "connected") return;
    const catalogPath = this.gateway.getCatalogPath();
    this.loadedThreadIds.clear();
    this.threadLoadPromises.clear();
    this.threadDetailCache.clear();
    this.activeThreadId = null;
    await this.agent.start({
      codexHome: this.codexHome,
      configOverrides: {
        model_provider: INTERNAL_MODEL_PROVIDER_ID,
        "model_providers.rhzy_gateway.name": "RHZYCODE Internal Gateway",
        "model_providers.rhzy_gateway.base_url": this.gateway.getBaseUrl(),
        "model_providers.rhzy_gateway.wire_api": "responses",
        model_catalog_json: catalogPath,
      },
    });
  }

  private handleGatewayRequest(event: GatewayRequestEvent): void {
    const turnId = typeof event.turn_id === "string" ? event.turn_id : "";
    if (!turnId) return;
    const status = Number(event.status);
    if (event.event === "request_started"
      || (event.event === "request_completed" && Number.isFinite(status) && status < 500)) {
      this.clearGatewayFailure(turnId);
      return;
    }
    const terminalFailure = (
      (event.event === "request_failed" || event.event === "request_completed")
      && Number.isFinite(status)
      && status >= 500
    ) || event.event === "stream_interrupted";
    if (!terminalFailure) return;

    const threadId = [...this.activeTurns].find((entry) => entry[1] === turnId)?.[0];
    if (!threadId) return;
    this.clearGatewayFailure(turnId);
    const detail = typeof event.message === "string" && event.message
      ? event.message
      : `The model gateway returned HTTP ${Number.isFinite(status) ? status : 502}.`;
    const timer = setTimeout(() => {
      this.failUnresolvedGatewayTurn(threadId, turnId, detail);
    }, this.gatewayFailureGraceMs);
    timer.unref();
    this.pendingGatewayFailures.set(turnId, { threadId, timer });
  }

  private failUnresolvedGatewayTurn(threadId: string, turnId: string, detail: string): void {
    this.pendingGatewayFailures.delete(turnId);
    if (this.activeTurns.get(threadId) !== turnId) return;

    const message = `${detail} Agent Host did not finish the turn after the gateway request ended.`;
    this.gateway.interruptTurn(turnId);
    void this.agent.request("turn/interrupt", { threadId, turnId }, 10_000).catch((error) => {
      this.emit(
        "agent:diagnostic",
        `Unable to interrupt unresolved turn ${turnId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    this.pendingCompactions.get(threadId)?.reject(new Error(message));
    this.activeTurns.delete(threadId);
    this.updateThread(threadId, { status: "failed" });
    this.publishTimeline({
      id: `error-gateway-${turnId}`,
      threadId,
      kind: "notice",
      status: "failed",
      title: "任务失败",
      content: message,
      createdAt: new Date().toISOString(),
    });
    this.finalizeThreadTimeline(threadId, true);
    this.clearRemoteAttachments(threadId);
  }

  private clearGatewayFailure(turnId: string): void {
    const pending = this.pendingGatewayFailures.get(turnId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingGatewayFailures.delete(turnId);
  }

  private clearGatewayFailuresForThread(threadId: string): void {
    for (const [turnId, pending] of this.pendingGatewayFailures) {
      if (pending.threadId === threadId) this.clearGatewayFailure(turnId);
    }
  }

  private clearAllGatewayFailures(): void {
    for (const turnId of [...this.pendingGatewayFailures.keys()]) this.clearGatewayFailure(turnId);
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
    if (threadId) this.threadDetailCache.delete(threadId);
    const effectiveTurnId = turnId || (threadId ? this.activeTurns.get(threadId) || null : null);
    let forwardedParams = params;
    let completedGeneratedImage: StoredGeneratedImage | null = null;
    if (method === "item/started" || method === "item/completed") {
      const item = (params.item || {}) as Record<string, unknown>;
      if (item.type === "userMessage" && threadId) {
        const uploadedFiles = this.managedFiles.listThread(threadId)
          .filter((file) => file.source === "upload" && file.turnId === effectiveTurnId)
          .map((file) => managedFileReference(file, true));
        if (uploadedFiles.length) forwardedParams = {
          ...params,
          item: { ...item, files: uploadedFiles },
        };
      }
      if (item.type === "imageGeneration") {
        const image = method === "item/completed"
          ? materializeGeneratedImage(path.join(this.codexHome, "generated_images"), item)
          : null;
        completedGeneratedImage = image;
        if (image && threadId) {
          this.publishedGeneratedImageIds.add(generatedImageKey(
            threadId,
            effectiveTurnId,
            String(item.id || image.name),
          ));
        }
        const rendererItem = { ...item };
        delete rendererItem.result;
        if (image) Object.assign(rendererItem, {
          savedPath: image.path,
          name: image.name,
          generated: true,
        });
        if (method === "item/completed" && !image) {
          this.emit("agent:diagnostic", "The generated image result could not be saved or was not a supported image.");
        }
        forwardedParams = { ...params, item: rendererItem };
      }
    }
    const shouldAddThreadId = Boolean(threadId && !extractThreadId(forwardedParams));
    const shouldAddTurnId = Boolean(effectiveTurnId && !extractTurnId(forwardedParams));
    this.emit("agent:message", shouldAddThreadId || shouldAddTurnId || forwardedParams !== params
      ? {
          ...message,
          params: {
            ...forwardedParams,
            ...(shouldAddThreadId ? { threadId } : {}),
            ...(shouldAddTurnId ? { turnId: effectiveTurnId } : {}),
          },
        }
      : message);

    if (method === "item/completed" && threadId) {
      const item = (params.item || {}) as Record<string, unknown>;
      const itemType = String(item.type || "");
      if (itemType === "agentMessage" || itemType === "fileChange") {
        this.publishGeneratedArtifacts(threadId, turnId || this.activeTurns.get(threadId) || null, item);
      }
    }

    if ((method === "thread/archived" || method === "thread/deleted") && threadId) {
      if (method === "thread/deleted") this.managedFiles.removeThread(threadId);
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
      this.publishApproval(message.id, method, params, threadId, effectiveTurnId);
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
      const completedTurnId = typeof turn.id === "string" ? turn.id : effectiveTurnId;
      if (completedTurnId) this.clearGatewayFailure(completedTurnId);
      const status = mapTurnStatus(String(turn.status || "completed"));
      const pendingCompaction = this.pendingCompactions.get(threadId);
      if (pendingCompaction) {
        if (status === "completed") pendingCompaction.resolve();
        else {
          const turnError = (turn.error || {}) as Record<string, unknown>;
          pendingCompaction.reject(new Error(
            String(turnError.message || "Conversation compaction did not complete."),
          ));
        }
      }
      this.activeTurns.delete(threadId);
      this.updateThread(threadId, { status });
      this.finalizeThreadTimeline(threadId, status === "failed");
      this.publishRolloutGeneratedImages(threadId, typeof turn.id === "string" ? turn.id : null);
      this.clearRemoteAttachments(threadId);
    }
    if (method === "item/agentMessage/delta") {
      const itemId = turnScopedItemId(effectiveTurnId, params.itemId || `assistant-${threadId}`);
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
      const itemId = turnScopedItemId(effectiveTurnId, params.itemId || `command-${threadId}`);
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
      const itemId = turnScopedItemId(effectiveTurnId, params.itemId || `reasoning-${threadId}`);
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
      if (effectiveTurnId) this.clearGatewayFailure(effectiveTurnId);
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
        this.clearRemoteAttachments(threadId);
      }
    }
    if (method === "serverRequest/resolved") {
      this.resolveServerRequest(params.requestId);
    }
    if (method === "item/fileChange/patchUpdated") {
      const itemId = turnScopedItemId(effectiveTurnId, params.itemId || `file-change-${Date.now()}`);
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
      const itemId = turnScopedItemId(effectiveTurnId, item.id || `${method}-${Date.now()}`);
      const itemType = String(item.type || "notice");
      if (itemType === "userMessage") return;
      if (itemType === "imageGeneration") {
        if (method === "item/completed" && completedGeneratedImage) {
          this.publishTimeline(generatedImageTimelineItem(
            itemId,
            threadId,
            completedGeneratedImage,
            new Date().toISOString(),
          ));
        }
        return;
      }
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

  private publishRolloutGeneratedImages(threadId: string, turnId: string | null): void {
    for (const generated of loadRolloutGeneratedImages(this.codexHome, threadId)) {
      if (turnId && generated.turnId && generated.turnId !== turnId) continue;
      const key = generatedImageKey(threadId, generated.turnId, generated.id);
      if (this.publishedGeneratedImageIds.has(key)) continue;
      this.publishedGeneratedImageIds.add(key);
      const item = {
        id: generated.id,
        type: "imageGeneration",
        status: "completed",
        savedPath: generated.image.path,
        name: generated.image.name,
        generated: true,
        ...(generated.revisedPrompt ? { revisedPrompt: generated.revisedPrompt } : {}),
      };
      this.emit("agent:message", {
        method: "item/completed",
        params: { threadId, ...(generated.turnId ? { turnId: generated.turnId } : {}), item },
      });
      this.publishTimeline(generatedImageTimelineItem(
        generated.id,
        threadId,
        generated.image,
        generated.createdAt,
      ));
    }
  }

  private clearRemoteAttachments(threadId: string): void {
    const filePaths = this.remoteAttachments.get(threadId);
    if (!filePaths) return;
    this.remoteAttachments.delete(threadId);
    removeRemoteAttachments(path.join(this.codexHome, "temp", "mobile-attachments"), filePaths);
  }

  private clearAllRemoteAttachments(): void {
    this.remoteAttachments.clear();
    removeRemoteAttachments(path.join(this.codexHome, "temp", "mobile-attachments"));
  }

  private publishGeneratedArtifacts(
    threadId: string,
    turnId: string | null,
    item: Record<string, unknown>,
  ): void {
    const projectPath = this.threads.get(threadId)?.projectPath;
    if (!projectPath) return;
    const values: unknown[] = [item.text];
    if (Array.isArray(item.changes)) values.push(...item.changes);
    const records = resolveArtifactPaths(projectPath, values)
      .flatMap((filePath) => {
        const record = this.managedFiles.storeGenerated(threadId, turnId, filePath);
        if (!record || this.publishedManagedFileIds.has(record.id)) return [];
        this.publishedManagedFileIds.add(record.id);
        return [record];
      });
    if (!records.length) return;
    const itemId = `files-${records[0]!.id}`;
    const rendererFiles = records.map((record) => managedFileReference(record, true));
    this.emit("agent:message", {
      method: "item/completed",
      params: {
        threadId,
        item: { id: itemId, type: "artifact", files: rendererFiles },
      },
    });
    this.publishTimeline({
      id: itemId,
      threadId,
      kind: "assistant",
      status: "completed",
      title: "",
      content: "",
      files: records.map((record) => managedFileReference(record)),
      createdAt: new Date().toISOString(),
    });
  }

  private publishApproval(
    rpcId: number | string,
    method: ApprovalMethod,
    params: Record<string, unknown>,
    threadId: string,
    turnId: string | null,
  ): void {
    const { id, pending, approval } = createApprovalRequest({
      rpcId,
      method,
      params,
      threadId,
      turnId,
      itemDetails: this.itemDetails,
    });
    this.pendingApprovals.set(id, pending);
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

  private async openRemoteThread(threadId: string): Promise<RemoteThreadOpenResult> {
    if (!this.threads.has(threadId)) throw new ControlCommandError("not_found");
    try {
      const localThread = this.threads.get(threadId)!;
      const localDetail = await this.loadLocalThreadDetail(localThread);
      // Mobile only receives this payload. Prefer complete local history so large
      // conversations stay fast on flaky links; resume only when the rollout is
      // sparse or missing assistant finals.
      let detail: ThreadDetail;
      if (localDetail && !isIncompleteRolloutHistory(localDetail)) {
        detail = localDetail;
      } else {
        try {
          // Cap resume so a stuck App Server cannot starve mobile of the local
          // user rows; the client keeps retrying sparse opens separately.
          const resumed = await withDeadline(
            this.openThread(threadId, true),
            mobileOpenResumeBudgetMs(),
            "Mobile openThread resume",
          );
          detail = preferRicherThreadDetail(localDetail, resumed);
        } catch (error) {
          if (!localDetail) throw error;
          // Return the best local copy so the client can render something, but the
          // incomplete-cache guards above keep forcing resume on later opens.
          detail = localDetail;
        }
      }
      const timelineById = new Map<string, (typeof detail.timeline)[number]>();
      for (const item of [...detail.timeline, ...remoteMessageTimeline(detail)]) {
        const current = timelineById.get(item.id);
        timelineById.set(item.id, current ? preferTimelineItem(current, item) : item);
      }
      for (const item of this.controlPlane?.store.snapshot().timeline || []) {
        if (item.threadId !== threadId) continue;
        const current = timelineById.get(item.id);
        timelineById.set(item.id, current ? preferTimelineItem(current, item) : item);
      }
      return {
        thread: detail.thread,
        timeline: dedupeTimelineItems([...timelineById.values()]),
      };
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
      const response = await this.listModels();
      const gatewayModels = new Map(this.gateway.getStatus().models.flatMap((model) => [
        [model.id, model] as const,
        [model.upstreamModel, model] as const,
      ]));
      return {
        models: (response.data || []).map((model) => {
          const gatewayModel = gatewayModels.get(model.model) || gatewayModels.get(model.id);
          if (!gatewayModel) throw new Error(`Model ${model.model} is missing from the current gateway catalog.`);
          const { supportedReasoningEfforts: _supportedReasoningEfforts, ...remoteModel } = model;
          return {
            ...remoteModel,
            source: gatewayModelSourceName(gatewayModel),
            sourceModelName: gatewayModel.upstreamModel,
            reasoningEfforts: supportedReasoningEfforts(model),
            isDefault: model.isDefault === true,
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

  private async forgetRemoteProject(
    request: RemoteProjectForgetRequest,
  ): Promise<RemoteProjectListResult> {
    try {
      this.projectDirectories.forget(request.path);
      return { projects: this.projectDirectories.list() };
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
    const attachmentDirectory = path.join(this.codexHome, "temp", "mobile-attachments");
    const attachments = saveRemoteAttachments(attachmentDirectory, request.attachments || []);
    if (attachments.length) this.remoteAttachments.set(threadId, attachments.map((attachment) => attachment.path));
    try {
      const response = await this.startTurn({
        threadId,
        text: request.text,
        ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
        ...(request.model ? { model: request.model } : {}),
        approvalPolicy: request.approvalPolicy || "on-request",
        sandboxMode: request.sandboxMode || "read-only",
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        attachments,
      });
      return {
        threadId,
        turnId: response.turn?.id || null,
        acceptedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.clearRemoteAttachments(threadId);
      if (error instanceof ControlCommandError) throw error;
      throw new ControlCommandError("unavailable");
    }
  }

  private async interruptRemoteTurn(threadId: string): Promise<RemoteTurnInterruptResult> {
    if (!this.threads.has(threadId)) throw new ControlCommandError("not_found");
    if (!this.activeTurns.has(threadId)) throw new ControlCommandError("conflict");
    try {
      await this.interruptTurn(threadId);
      this.clearRemoteAttachments(threadId);
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

  private async setRemoteThreadModel(
    threadId: string,
    request: RemoteThreadModelRequest,
  ): Promise<RemoteThreadMutationResult> {
    if (!this.threads.has(threadId)) throw new ControlCommandError("not_found");
    try {
      this.setThreadModel(threadId, request.model);
      return { threadId, acceptedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ControlCommandError) throw error;
      throw new ControlCommandError("invalid");
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

  private async compactRemoteThread(threadId: string): Promise<RemoteThreadMutationResult> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new ControlCommandError("not_found");
    if (isActiveThreadStatus(thread.status)) throw new ControlCommandError("conflict");
    try {
      await this.compactThread(threadId);
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
    const thread = this.threads.get(threadId)
      || (await this.listThreads({ archived: true })).find((candidate) => candidate.id === threadId);
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

  private removeRuntimeThread(threadId: string, ensureEventAfterSequence?: number): void {
    this.clearGatewayFailuresForThread(threadId);
    const existed = this.threads.delete(threadId);
    this.loadedThreadIds.delete(threadId);
    this.threadLoadPromises.delete(threadId);
    this.threadDetailCache.delete(threadId);
    const store = this.controlPlane?.store;
    const removalAlreadyPublished = ensureEventAfterSequence === undefined
      ? false
      : store?.listEvents(ensureEventAfterSequence).some((event) =>
        event.type === "thread.removed" && event.threadId === threadId);
    if (existed || (ensureEventAfterSequence !== undefined && !removalAlreadyPublished)) {
      store?.removeThread(threadId);
    }
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
    this.threadDetailCache.delete(threadId);
    const thread = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.threads.set(threadId, thread);
    this.controlPlane?.store.upsertThread(thread);
    const lastEvent = typeof patch.status === "string"
      ? taskActivityEventFromTransition(current.status, thread.status, thread.id, thread.title)
      : null;
    this.updateHostTaskCount(lastEvent);
  }

  private rememberThreadDetail(threadId: string, detail: ThreadDetail): void {
    this.threadDetailCache.delete(threadId);
    this.threadDetailCache.set(threadId, detail);
    while (this.threadDetailCache.size > MAX_CACHED_THREAD_DETAILS) {
      const oldestId = this.threadDetailCache.keys().next().value;
      if (typeof oldestId !== "string") break;
      this.threadDetailCache.delete(oldestId);
    }
  }

  private async prepareThreadModel(threadId: string, targetModel: string): Promise<void> {
    this.gateway.setThreadModel(threadId, targetModel);
    const previousModel = loadRolloutThreadState(this.codexHome, threadId).lastSuccessfulModel;
    await this.compactBeforeSmallerModel(threadId, targetModel);
    if (previousModel && previousModel !== targetModel) {
      await this.agent.request("thread/settings/update", {
        threadId,
        model: targetModel,
      });
    }
  }

  private async compactBeforeSmallerModel(threadId: string, targetModel: string): Promise<void> {
    const gatewayModels = this.gateway.getStatus().models;
    const target = gatewayModels.find((model) => model.id === targetModel);
    if (!target?.contextWindow) return;

    const rollout = loadRolloutThreadState(this.codexHome, threadId);
    const compactAt = Math.floor(
      target.contextWindow * (target.effectiveContextWindowPercent || 90) / 100,
    );
    if (rollout.currentTokens == null || rollout.currentTokens < compactAt) return;
    if (!rollout.lastSuccessfulModel || rollout.lastSuccessfulModel === targetModel) return;
    if (!gatewayModels.some((model) => model.id === rollout.lastSuccessfulModel)) return;

    this.emit(
      "agent:diagnostic",
      `Compacting a ${rollout.currentTokens}-token conversation before switching to ${targetModel}.`,
    );
    await this.agent.request("thread/settings/update", {
      threadId,
      model: rollout.lastSuccessfulModel,
    });
    await this.compactThread(threadId);
  }

  async compactThread(threadId: string): Promise<void> {
    if (this.pendingCompactions.has(threadId)) {
      throw new Error("Conversation compaction is already running.");
    }

    let pending!: PendingCompaction;
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCompactions.delete(threadId);
        reject(new Error("Conversation compaction timed out."));
      }, 10 * 60_000);
      timer.unref();
      pending = { resolve, reject, timer };
      this.pendingCompactions.set(threadId, pending);
    });
    try {
      await this.agent.request("thread/compact/start", { threadId }, null);
      await completed;
    } finally {
      if (this.pendingCompactions.get(threadId) === pending) {
        this.pendingCompactions.delete(threadId);
        clearTimeout(pending.timer);
      }
    }
  }

  private updateHostTaskCount(lastEvent: TaskActivityEvent | null = null): void {
    const activity: TaskActivityStatus = summarizeTaskActivity([...this.threads.values()], lastEvent);
    this.controlPlane?.store.upsertHost({
      id: "local-desktop",
      name: os.hostname(),
      platform: desktopHostPlatform(),
      status: activity.activeCount > 0 ? "busy" : "online",
      lastSeenAt: new Date().toISOString(),
      activeTaskCount: activity.activeCount,
    });
    this.emit("task:activity", activity);
  }

  private publishTimeline(item: TimelineItem): void {
    // Coalesce running stream deltas so weak mobile links are not flooded with
    // full-content upserts on every token while still publishing completions immediately.
    this.timelinePublishCoalescer.enqueue(item);
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
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
}): Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"> {
  const values = model.supportedReasoningEfforts?.map((option) => option.reasoningEffort || "") || [];
  return [...new Set(values)].filter((value): value is "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" => reasoningEffortValues.has(value));
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

function preferredStoredModel(storedModel: string | undefined, resumedModel: string | undefined): string {
  if (storedModel && storedModel !== "default" && storedModel !== "previous") return storedModel;
  return resumedModel || storedModel || "previous";
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

function toThreadDetail(
  thread: ServerThread,
  summary: ThreadSummary,
  generatedImageDirectory: string,
  rolloutGeneratedImages: RolloutGeneratedImage[] = [],
  managedFiles: ManagedFileRecord[] = [],
): ThreadDetail {
  const messages: ConversationMessage[] = [];
  const timeline: TimelineItem[] = [];
  const pendingRolloutImages = new Map(rolloutGeneratedImages.map((image) => [image.id, image]));

  for (const turn of thread.turns || []) {
    const firstMessageIndex = messages.length;
    const turnFiles = managedFiles.filter((file) => file.turnId === turn.id);
    const uploadedFiles = turnFiles.filter((file) => file.source === "upload");
    const createdAt = timestampToIso(turn.startedAt || turn.completedAt || thread.updatedAt);
    for (const item of turn.items || []) {
      const rawItemId = String(item.id || `${turn.id || "turn"}-${messages.length + timeline.length}`);
      const itemId = turnScopedItemId(turn.id, rawItemId);
      const itemType = String(item.type || "notice");
      if (itemType === "userMessage") {
        const images = uploadedFiles.some((file) => file.kind === "image")
          ? []
          : describeUserImages(item.content);
        messages.push({
          id: itemId,
          role: "user",
          content: stripAttachedFileInstructions(describeUserContent(item.content)),
          ...(images.length ? { images } : {}),
          ...(uploadedFiles.length ? {
            files: uploadedFiles.map((file) => managedFileReference(file, true)),
          } : {}),
        });
        continue;
      }
      if (itemType === "agentMessage") {
        messages.push({ id: itemId, role: "assistant", content: String(item.text || "") });
        continue;
      }
      if (itemType === "imageGeneration") {
        const image = materializeGeneratedImage(generatedImageDirectory, item);
        if (image) {
          messages.push({ id: itemId, role: "assistant", content: "", images: [image] });
        }
        pendingRolloutImages.delete(rawItemId);
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
    const generatedFiles = turnFiles.filter((file) => file.source === "generated" && file.kind === "file");
    const generatedImages = turnFiles.filter((file) => file.source === "generated" && file.kind === "image");
    if (generatedFiles.length || generatedImages.length) {
      let assistantIndex = -1;
      for (let index = messages.length - 1; index >= firstMessageIndex; index -= 1) {
        if (messages[index]?.role === "assistant") {
          assistantIndex = index;
          break;
        }
      }
      const files = generatedFiles.map((file) => managedFileReference(file, true));
      const images = generatedImages.map((file) => ({ path: file.path, name: file.name, generated: true as const }));
      if (assistantIndex >= firstMessageIndex) {
        messages[assistantIndex] = {
          ...messages[assistantIndex]!,
          ...(files.length ? { files } : {}),
          ...(images.length ? { images } : {}),
        };
      } else {
        const firstArtifact = generatedFiles[0] || generatedImages[0]!;
        messages.push({
          id: `files-${turn.id || firstArtifact.id}`,
          role: "assistant",
          content: "",
          ...(files.length ? { files } : {}),
          ...(images.length ? { images } : {}),
        });
      }
    }
    for (const generated of pendingRolloutImages.values()) {
      if (generated.turnId !== turn.id) continue;
      messages.push({
        id: turnScopedItemId(generated.turnId, generated.id),
        role: "assistant",
        content: "",
        images: [generated.image],
      });
      pendingRolloutImages.delete(generated.id);
    }
  }

  for (const generated of pendingRolloutImages.values()) {
    messages.push({
      id: turnScopedItemId(generated.turnId, generated.id),
      role: "assistant",
      content: "",
      images: [generated.image],
    });
  }

  return { thread: summary, messages, timeline };
}

function isVisibleHistoryMessage(message: ConversationMessage): boolean {
  if (!message.content.trim() && !(message.images?.length || message.files?.length)) return false;
  if (message.role !== "user") return true;
  const normalized = message.content.trimStart();
  return !(
    normalized.startsWith("<environment_context>")
    || normalized.startsWith("<permissions instructions>")
    || normalized.startsWith("<collaboration_mode>")
    || normalized.startsWith("<skills_instructions>")
    || normalized.startsWith("<turn_aborted>")
    || normalized.startsWith("# AGENTS.md instructions")
  );
}

/** Local rollouts often keep user turns while omitting many assistant finals. */
function isIncompleteRolloutHistory(detail: ThreadDetail): boolean {
  const visible = detail.messages.filter(isVisibleHistoryMessage);
  if (!visible.length) return false;
  const users = visible.filter((message) => message.role === "user").length;
  const assistants = visible.filter((message) => message.role === "assistant").length;
  if (users === 0) return false;
  // Zero assistants is the common sparse case; fewer assistants than users also
  // means resume should still run (partial tool-call rollouts, dropped finals).
  return assistants < users;
}

function historyCompletenessScore(detail: ThreadDetail): number {
  let score = 0;
  for (const message of detail.messages) {
    if (!isVisibleHistoryMessage(message)) continue;
    score += 1;
    if (message.role === "assistant") score += 10;
    if (message.content.trim()) score += Math.min(8, Math.floor(message.content.trim().length / 80));
    score += (message.images?.length || 0) * 3;
    score += (message.files?.length || 0) * 2;
  }
  score += detail.timeline.length;
  return score;
}

function preferRicherThreadDetail(
  localDetail: ThreadDetail | null,
  resumed: ThreadDetail,
): ThreadDetail {
  if (!localDetail) return resumed;
  const localAssistants = countVisibleRole(localDetail, "assistant");
  const resumedAssistants = countVisibleRole(resumed, "assistant");
  const localScore = historyCompletenessScore(localDetail);
  const resumedScore = historyCompletenessScore(resumed);

  // Assistant count is the primary signal. Long user-only rollouts must not beat a
  // shorter resume payload that actually restored AI replies.
  if (resumedAssistants > localAssistants) return resumed;
  if (localAssistants > resumedAssistants) {
    return {
      thread: resumed.thread,
      messages: localDetail.messages,
      timeline: resumed.timeline.length ? resumed.timeline : localDetail.timeline,
    };
  }

  if (resumedScore > localScore) return resumed;
  if (localScore > resumedScore) {
    return {
      thread: resumed.thread,
      messages: localDetail.messages,
      timeline: resumed.timeline.length ? resumed.timeline : localDetail.timeline,
    };
  }
  if (resumed.messages.length >= localDetail.messages.length) return resumed;
  return {
    thread: resumed.thread,
    messages: localDetail.messages,
    timeline: resumed.timeline.length ? resumed.timeline : localDetail.timeline,
  };
}

function countVisibleRole(detail: ThreadDetail, role: ConversationMessage["role"]): number {
  return detail.messages.filter((message) => (
    message.role === role && isVisibleHistoryMessage(message)
  )).length;
}

function remoteMessageTimeline(detail: ThreadDetail): TimelineItem[] {
  const finalTimestamp = Date.parse(detail.thread.updatedAt);
  const messages = detail.messages.filter(isVisibleHistoryMessage);
  const baseTimestamp = Number.isFinite(finalTimestamp)
    ? finalTimestamp - Math.max(0, messages.length - 1)
    : Date.now();
  return messages.map((message, index) => {
    const files = message.files?.map(({ path: _path, ...file }) => file);
    const images = message.images
      ?.filter((image) => image.generated)
      .map((image) => ({ id: image.name, name: image.name, generated: true as const }));
    return {
      id: message.id,
      threadId: detail.thread.id,
      kind: message.role,
      status: "completed" as const,
      title: message.role === "user" ? "You" : "RHZYCODE",
      content: message.content,
      ...(images?.length ? { images } : {}),
      ...(files?.length ? { files } : {}),
      createdAt: new Date(baseTimestamp + index).toISOString(),
    };
  });
}

function managedFileReference(record: ManagedFileRecord, includePath = false): ConversationFile {
  return {
    id: record.id,
    name: record.name,
    size: record.size,
    mimeType: record.mimeType,
    source: record.source,
    ...(includePath ? { path: record.path } : {}),
  };
}

function stripAttachedFileInstructions(value: string): string {
  const clean = stripImageAttachmentMarkup(value);
  return clean.split("\n\nAttached files (use these absolute paths):\n", 1)[0] || clean;
}

function generatedImageKey(threadId: string, turnId: string | null | undefined, itemId: string): string {
  return `${threadId}\u0000${turnScopedItemId(turnId, itemId)}`;
}

function toGeneratedImageTimeline(
  thread: ServerThread,
  summary: ThreadSummary,
  generatedImageDirectory: string,
): TimelineItem[] {
  const timeline: TimelineItem[] = [];
  for (const turn of thread.turns || []) {
    const createdAt = timestampToIso(turn.startedAt || turn.completedAt || thread.updatedAt);
    for (const item of turn.items || []) {
      if (item.type !== "imageGeneration") continue;
      const image = materializeGeneratedImage(generatedImageDirectory, item);
      if (!image) continue;
      const itemId = turnScopedItemId(
        turn.id,
        item.id || `${turn.id || "turn"}-generated-image-${timeline.length}`,
      );
      timeline.push(generatedImageTimelineItem(itemId, summary.id, image, createdAt));
    }
  }
  return timeline;
}

function generatedImageTimelineItem(
  id: string,
  threadId: string,
  image: StoredGeneratedImage,
  createdAt: string,
): TimelineItem {
  return {
    id,
    threadId,
    kind: "assistant",
    status: "completed",
    title: "",
    content: "",
    images: [{ id: image.name, name: image.name, generated: true }],
    createdAt,
  };
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
  return stripImageAttachmentMarkup(value
    .map((rawItem) => {
      const item = (rawItem || {}) as Record<string, unknown>;
      if (item.type === "text" || item.type === "input_text") return String(item.text || "");
      if (item.type === "skill") return `Skill: ${String(item.name || item.path || "")}`;
      if (item.type === "mention") return `Mention: ${String(item.name || item.path || "")}`;
      if (item.type === "image" || item.type === "localImage") return "";
      return "";
    })
    .filter(Boolean)
    .join("\n"));
}

function describeUserImages(value: unknown): Array<{ path: string; name: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawItem) => {
    const item = (rawItem || {}) as Record<string, unknown>;
    if (item.type !== "image" && item.type !== "localImage" && item.type !== "input_image") return [];
    const imagePath = String(item.path || item.image_url || "");
    if (!imagePath) return [];
    if (imagePath.startsWith("data:")) return [];
    return [{ path: imagePath, name: path.basename(imagePath) || "image" }];
  });
}

function stripImageAttachmentMarkup(value: string): string {
  return value
    .replace(/<image\b[^>]*\bpath=(?:"[^"]*"|'[^']*')[^>]*>\s*<\/image>/gi, "")
    .replace(/<image\b[^>]*\bpath=(?:"[^"]*"|'[^']*')[^>]*>/gi, "")
    .replace(/<\/image>/gi, "")
    .trim();
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

function limitDetail(detail: string): string {
  const maxLength = 12_000;
  return detail.length > maxLength ? `${detail.slice(0, maxLength)}\n...` : detail;
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
