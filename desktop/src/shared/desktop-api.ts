import type {
  AgentEvent,
  ControlSnapshot,
  ProjectDirectory,
  ThreadDetail,
  ThreadSummary,
  UserInputAnswers,
} from "@rhzycode/protocol";

export type Unsubscribe = () => void;
export type ApprovalPolicy = "on-request" | "untrusted" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface ComposerAttachment {
  path: string;
  name: string;
  kind: "file" | "image";
  size: number;
}

export interface PastedImageInput {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ThreadListOptions {
  cwd?: string;
  searchTerm?: string;
  archived?: boolean;
}

export interface StartThreadParams {
  cwd: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandboxMode?: SandboxMode;
}

export interface StartTurnParams {
  threadId: string;
  text: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandboxMode?: SandboxMode;
  reasoningEffort?: ReasoningEffort;
  attachments?: ComposerAttachment[];
}

export interface TerminalStartParams {
  cwd: string;
  cols?: number;
  rows?: number;
}

export interface AgentStatus {
  state: "disconnected" | "connecting" | "connected" | "error";
  error: string | null;
}

export interface GatewayProviderStatus {
  id: string;
  protocol: string;
  health: {
    state: "unknown" | "healthy" | "degraded";
    latencyMs: number | null;
    checkedAt: string | null;
    httpStatus: number | null;
    circuitState: "closed" | "open";
    lastError: string | null;
  };
}

export interface GatewayStatus {
  state: "stopped" | "starting" | "running" | "error";
  transport: "internal";
  providerCount: number;
  modelCount: number;
  configSource: string | null;
  providers: GatewayProviderStatus[];
  models: Array<{ id: string; ownedBy: string }>;
  error: string | null;
}

export interface SyncStatus {
  state: "stopped" | "running" | "error";
  host: string;
  port: number;
  url: string | null;
  error: string | null;
}

export interface CredentialStatus {
  encryptionAvailable: boolean;
  providers: Array<{
    providerId: string;
    name: string;
    baseUrl: string;
    protocol: "auto" | "responses" | "chat_completions" | "anthropic_messages";
    detectedProtocol: "responses" | "chat_completions" | "anthropic_messages";
    models: string[];
    custom: boolean;
    configured: boolean;
    source: "secure_store" | "environment" | "missing";
  }>;
}

export interface LlmProviderConfigurationInput {
  providerId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol: "auto" | "responses" | "chat_completions" | "anthropic_messages";
  models: string[];
}

export interface CredentialUpdateResult {
  credentials: CredentialStatus;
  gateway: GatewayStatus;
  gatewayError: string | null;
}

export interface UpdateStatus {
  enabled: boolean;
  state:
    | "disabled"
    | "idle"
    | "checking"
    | "available"
    | "not_available"
    | "downloading"
    | "downloaded"
    | "error";
  version: string | null;
  percent: number | null;
  error: string | null;
}

export interface MobileAccessStatus {
  accessKey: {
    key: string;
    createdAt: string;
    lastUsedAt: string | null;
  } | null;
  audit: Array<{
    id: string;
    clientId: string;
    action:
      | "approval.resolved"
      | "project.created"
      | "project.removed"
      | "task.thread_started"
      | "task.turn_started"
      | "task.turn_interrupted"
      | "task.user_input_submitted"
      | "task.thread_model_changed"
      | "task.thread_renamed"
      | "task.thread_archived"
      | "task.thread_unarchived"
      | "task.thread_deleted";
    detail: string;
    createdAt: string;
  }>;
}

export type EncryptedLoadStatus =
  | "missing"
  | "restored"
  | "partial"
  | "invalid"
  | "unavailable";

export interface PersistenceStatus {
  encryptionAvailable: boolean;
  controlState: EncryptedLoadStatus;
  mobileAccessState: EncryptedLoadStatus;
}

export interface TerminalStatus {
  processId: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  output: string;
  error: string | null;
}

export interface TerminalOutput {
  processId: string;
  delta: string;
  stream: string;
  capReached: boolean;
}

export interface ModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string;
    description: string;
  }>;
  isDefault?: boolean;
}

export interface ModelListResponse {
  data?: ModelOption[];
}

export type SkillScope = "user" | "repo" | "system" | "admin";
export type SkillImportSource = "codex" | "claude";

export interface SkillInfo {
  name: string;
  displayName: string;
  description: string;
  shortDescription: string | null;
  enabled: boolean;
  path: string;
  scope: SkillScope;
  canRemove: boolean;
}

export interface SkillLoadError {
  path: string;
  message: string;
}

export interface SkillSourceStatus {
  available: boolean;
  count: number;
}

export interface SkillsStatus {
  skills: SkillInfo[];
  errors: SkillLoadError[];
  sources: Record<SkillImportSource, SkillSourceStatus>;
}

export interface SkillInstallResult {
  installedName: string;
  status: SkillsStatus;
}

export interface SkillImportResult {
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  status: SkillsStatus;
}

export interface StartThreadResult {
  thread?: { id?: string };
}

export interface TurnStartResult {
  turn?: { id?: string };
  files?: Array<{
    id: string;
    name: string;
    size: number;
    mimeType?: string;
    source: "upload" | "generated";
    path?: string;
  }>;
}

export interface RpcNotification {
  method?: string;
  params?: Record<string, unknown>;
}

export interface RhzycodeDesktopApi {
  getAgentStatus(): Promise<AgentStatus>;
  connectAgent(): Promise<AgentStatus>;
  listModels(): Promise<ModelListResponse>;
  listThreads(options?: ThreadListOptions): Promise<ThreadSummary[]>;
  openThread(threadId: string): Promise<ThreadDetail>;
  chooseProject(): Promise<string | null>;
  listProjects(): Promise<ProjectDirectory[]>;
  rememberProject(path: string): Promise<ProjectDirectory>;
  forgetProject(path: string): Promise<void>;
  chooseFiles(): Promise<ComposerAttachment[]>;
  savePastedImage(input: PastedImageInput): Promise<ComposerAttachment>;
  readLocalImage(path: string): Promise<string>;
  openLocalFile(path: string): Promise<void>;
  revealLocalFile(path: string): Promise<void>;
  saveLocalFile(path: string, suggestedName: string): Promise<string | null>;
  startThread(params: StartThreadParams): Promise<StartThreadResult>;
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<unknown>;
  setThreadModel(threadId: string, model: string): Promise<ThreadSummary>;
  renameThread(threadId: string, name: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  startTurn(params: StartTurnParams): Promise<TurnStartResult>;
  interruptTurn(threadId: string): Promise<unknown>;
  getGatewayStatus(): Promise<GatewayStatus>;
  startGateway(): Promise<GatewayStatus>;
  stopGateway(): Promise<GatewayStatus>;
  restartGateway(): Promise<GatewayStatus>;
  probeProviders(): Promise<GatewayStatus>;
  getCredentialStatus(): Promise<CredentialStatus>;
  setProviderCredential(providerId: string, apiKey: string): Promise<CredentialUpdateResult>;
  configureLlmProvider(input: LlmProviderConfigurationInput): Promise<CredentialUpdateResult>;
  removeLlmProvider(providerId: string): Promise<CredentialUpdateResult>;
  getSkills(forceReload?: boolean): Promise<SkillsStatus>;
  chooseAndInstallSkill(): Promise<SkillInstallResult | null>;
  importSkills(source: SkillImportSource): Promise<SkillImportResult>;
  setSkillEnabled(path: string, enabled: boolean): Promise<SkillsStatus>;
  removeSkill(path: string): Promise<SkillsStatus>;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
  getMobileAccessStatus(): Promise<MobileAccessStatus>;
  rotateMobileAccessKey(): Promise<NonNullable<MobileAccessStatus["accessKey"]>>;
  copyText(value: string): Promise<void>;
  getPersistenceStatus(): Promise<PersistenceStatus>;
  getSyncStatus(): Promise<SyncStatus>;
  setSyncPort(port: number): Promise<SyncStatus>;
  getSyncSnapshot(): Promise<ControlSnapshot>;
  resolveApproval(id: string, decision: "approved" | "declined"): Promise<AgentEvent>;
  resolveUserInput(id: string, answers: UserInputAnswers): Promise<AgentEvent>;
  getTerminalStatus(): Promise<TerminalStatus | null>;
  startTerminal(params: TerminalStartParams): Promise<TerminalStatus>;
  writeTerminal(processId: string, data: string): Promise<unknown>;
  resizeTerminal(processId: string, cols: number, rows: number): Promise<unknown>;
  stopTerminal(processId: string): Promise<unknown>;
  onAgentStatus(listener: (status: AgentStatus) => void): Unsubscribe;
  onAgentMessage(listener: (message: RpcNotification) => void): Unsubscribe;
  onDiagnostic(listener: (message: string) => void): Unsubscribe;
  onGatewayStatus(listener: (status: GatewayStatus) => void): Unsubscribe;
  onSyncStatus(listener: (status: SyncStatus) => void): Unsubscribe;
  onSyncEvent(listener: (event: AgentEvent) => void): Unsubscribe;
  onTerminalStatus(listener: (status: TerminalStatus | null) => void): Unsubscribe;
  onTerminalOutput(listener: (output: TerminalOutput) => void): Unsubscribe;
  onUpdateStatus(listener: (status: UpdateStatus) => void): Unsubscribe;
  onMobileAccessStatus(listener: (status: MobileAccessStatus) => void): Unsubscribe;
  onProjectsChanged(listener: (projects: ProjectDirectory[]) => void): Unsubscribe;
}
