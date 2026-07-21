import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentStatus,
  GatewayStatus,
  MobileAccessStatus,
  RhzycodeDesktopApi,
  RpcNotification,
  SyncStatus,
  TerminalOutput,
  TerminalStatus,
  UpdateStatus,
} from "../shared/desktop-api";
import type { AgentEvent } from "@rhzycode/protocol";
import type { ProjectDirectory } from "@rhzycode/protocol";

const api: RhzycodeDesktopApi = {
  getAgentStatus: () => ipcRenderer.invoke("agent:status"),
  connectAgent: () => ipcRenderer.invoke("agent:connect"),
  listModels: () => ipcRenderer.invoke("agent:models"),
  listThreads: (options?: { cwd?: string; searchTerm?: string; archived?: boolean }) =>
    ipcRenderer.invoke("agent:threads", options),
  openThread: (threadId: string) => ipcRenderer.invoke("agent:thread:open", threadId),
  chooseProject: () => ipcRenderer.invoke("project:choose"),
  listProjects: () => ipcRenderer.invoke("project:list"),
  rememberProject: (path: string) => ipcRenderer.invoke("project:remember", path),
  forgetProject: (path: string) => ipcRenderer.invoke("project:forget", path),
  chooseFiles: () => ipcRenderer.invoke("project:choose-files"),
  savePastedImage: (input) => ipcRenderer.invoke("project:save-pasted-image", input),
  readLocalImage: (path: string) => ipcRenderer.invoke("project:read-local-image", path),
  startThread: (params: { cwd: string; model?: string; approvalPolicy?: "on-request" | "untrusted" | "never"; sandboxMode?: "read-only" | "workspace-write" | "danger-full-access" }) =>
    ipcRenderer.invoke("agent:thread:start", params),
  archiveThread: (threadId: string) => ipcRenderer.invoke("agent:thread:archive", threadId),
  unarchiveThread: (threadId: string) => ipcRenderer.invoke("agent:thread:unarchive", threadId),
  renameThread: (threadId: string, name: string) => ipcRenderer.invoke("agent:thread:rename", threadId, name),
  deleteThread: (threadId: string) => ipcRenderer.invoke("agent:thread:delete", threadId),
  startTurn: (params: { threadId: string; text: string; model?: string; approvalPolicy?: "on-request" | "untrusted" | "never"; sandboxMode?: "read-only" | "workspace-write" | "danger-full-access"; reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"; attachments?: Array<{ path: string; name: string; kind: "file" | "image"; size: number }> }) =>
    ipcRenderer.invoke("agent:turn:start", params),
  interruptTurn: (threadId: string) => ipcRenderer.invoke("agent:turn:interrupt", threadId),
  getGatewayStatus: () => ipcRenderer.invoke("gateway:status"),
  startGateway: () => ipcRenderer.invoke("gateway:start"),
  stopGateway: () => ipcRenderer.invoke("gateway:stop"),
  restartGateway: () => ipcRenderer.invoke("gateway:restart"),
  probeProviders: () => ipcRenderer.invoke("gateway:probe"),
  getCredentialStatus: () => ipcRenderer.invoke("credentials:status"),
  setProviderCredential: (providerId: string, apiKey: string) =>
    ipcRenderer.invoke("credentials:set", providerId, apiKey),
  configureLlmProvider: (input) => ipcRenderer.invoke("providers:configure", input),
  removeLlmProvider: (providerId: string) => ipcRenderer.invoke("providers:remove", providerId),
  getUpdateStatus: () => ipcRenderer.invoke("updates:status"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  getMobileAccessStatus: () => ipcRenderer.invoke("mobile-access:status"),
  rotateMobileAccessKey: () => ipcRenderer.invoke("mobile-access:key:rotate"),
  copyText: (value: string) => ipcRenderer.invoke("clipboard:write", value),
  getPersistenceStatus: () => ipcRenderer.invoke("storage:status"),
  getSyncStatus: () => ipcRenderer.invoke("sync:status"),
  setSyncPort: (port: number) => ipcRenderer.invoke("sync:port:set", port),
  getSyncSnapshot: () => ipcRenderer.invoke("sync:snapshot"),
  resolveApproval: (id: string, decision: "approved" | "declined") =>
    ipcRenderer.invoke("sync:approval:resolve", id, decision),
  resolveUserInput: (id: string, answers: Record<string, string[]>) =>
    ipcRenderer.invoke("sync:user-input:resolve", id, answers),
  getTerminalStatus: () => ipcRenderer.invoke("terminal:status"),
  startTerminal: (params: { cwd: string; cols?: number; rows?: number }) =>
    ipcRenderer.invoke("terminal:start", params),
  writeTerminal: (processId: string, data: string) =>
    ipcRenderer.invoke("terminal:write", processId, data),
  resizeTerminal: (processId: string, cols: number, rows: number) =>
    ipcRenderer.invoke("terminal:resize", processId, cols, rows),
  stopTerminal: (processId: string) => ipcRenderer.invoke("terminal:stop", processId),
  onAgentStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: AgentStatus) => listener(status);
    ipcRenderer.on("agent:status", handler);
    return () => ipcRenderer.removeListener("agent:status", handler);
  },
  onAgentMessage: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: RpcNotification) => listener(message);
    ipcRenderer.on("agent:message", handler);
    return () => ipcRenderer.removeListener("agent:message", handler);
  },
  onDiagnostic: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
    ipcRenderer.on("agent:diagnostic", handler);
    return () => ipcRenderer.removeListener("agent:diagnostic", handler);
  },
  onGatewayStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: GatewayStatus) => listener(status);
    ipcRenderer.on("gateway:status", handler);
    return () => ipcRenderer.removeListener("gateway:status", handler);
  },
  onSyncStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: SyncStatus) => listener(status);
    ipcRenderer.on("sync:status", handler);
    return () => ipcRenderer.removeListener("sync:status", handler);
  },
  onSyncEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: AgentEvent) => listener(event);
    ipcRenderer.on("sync:event", handler);
    return () => ipcRenderer.removeListener("sync:event", handler);
  },
  onTerminalStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: TerminalStatus | null) => listener(status);
    ipcRenderer.on("terminal:status", handler);
    return () => ipcRenderer.removeListener("terminal:status", handler);
  },
  onTerminalOutput: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, output: TerminalOutput) => listener(output);
    ipcRenderer.on("terminal:output", handler);
    return () => ipcRenderer.removeListener("terminal:output", handler);
  },
  onUpdateStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => listener(status);
    ipcRenderer.on("updates:status", handler);
    return () => ipcRenderer.removeListener("updates:status", handler);
  },
  onMobileAccessStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: MobileAccessStatus) => listener(status);
    ipcRenderer.on("mobile-access:status", handler);
    return () => ipcRenderer.removeListener("mobile-access:status", handler);
  },
  onProjectsChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, projects: ProjectDirectory[]) => listener(projects);
    ipcRenderer.on("projects:changed", handler);
    return () => ipcRenderer.removeListener("projects:changed", handler);
  },
};

contextBridge.exposeInMainWorld("rhzycode", api);

export type { RhzycodeDesktopApi } from "../shared/desktop-api";
