import {
  Activity,
  Bot,
  Brain,
  Check,
  ChevronDown,
  CircleStop,
  Copy,
  Download,
  FolderGit2,
  File,
  FolderOpen,
  GitBranch,
  Image as ImageIcon,
  KeyRound,
  Network,
  MoreHorizontal,
  PanelRight,
  Paperclip,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Search,
  Save,
  Server,
  ShieldCheck,
  Smartphone,
  Settings,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type {
  AgentEvent,
  ApprovalRequest,
  ConversationMessage,
  ThreadDetail,
  ThreadSummary,
  UserInputAnswers,
  UserInputRequest,
} from "@rhzycode/protocol";
import type {
  AgentStatus,
  ApprovalPolicy,
  ComposerAttachment,
  CredentialStatus,
  GatewayStatus,
  LlmProviderConfigurationInput,
  ModelOption,
  MobileAccessStatus,
  PersistenceStatus,
  ReasoningEffort,
  RpcNotification,
  SandboxMode,
  SyncStatus,
  UpdateStatus,
} from "../../shared/desktop-api";
import { isGemma31bBf16Model } from "../../../model-gateway/src/gemma-31b-policy.js";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  activityFromTimeline,
  activityLabel,
  approvalKindLabel,
  basename,
  credentialSourceLabel,
  describeItem,
  formatFileChanges,
  formatFileSize,
  getErrorMessage,
  groupModelsBySource,
  isActiveThreadStatus,
  isComposerRunning,
  modelReasoningEfforts,
  notificationThreadId,
  providerDisplayName,
  providerCredentialPresentation,
  storedApprovalPolicy,
  storedLastProject,
  storedLastThread,
  storedRecentProjects,
  storedReasoningEffort,
  storedSandboxMode,
  storedSelectedModel,
  storeLastThread,
  summarizePrompt,
  updateStateLabel,
  type ActivityEntry,
} from "./app-utils";

interface ChatMessage extends ConversationMessage {
  streaming?: boolean;
  images?: Array<{ path: string; name: string }>;
}

interface ComposerDraft {
  text: string;
  attachments: ComposerAttachment[];
}

const emptyGateway: GatewayStatus = {
  state: "starting",
  transport: "internal",
  providerCount: 0,
  modelCount: 0,
  configSource: null,
  providers: [],
  models: [],
  error: null,
};

const emptySync: SyncStatus = {
  state: "stopped",
  host: "127.0.0.1",
  port: 8790,
  url: null,
  error: null,
};

const emptyCredentials: CredentialStatus = {
  encryptionAvailable: true,
  providers: [],
};

const emptyUpdates: UpdateStatus = {
  enabled: false,
  state: "disabled",
  version: null,
  percent: null,
  error: null,
};

const emptyMobileAccess: MobileAccessStatus = {
  accessKey: null,
  audit: [],
};

const emptyPersistence: PersistenceStatus = {
  encryptionAvailable: true,
  controlState: "missing",
  mobileAccessState: "missing",
};

export function App() {
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ state: "connecting", error: null });
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>(emptyGateway);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(emptySync);
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus>(emptyCredentials);
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({});
  const [savingCredentialId, setSavingCredentialId] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(emptyUpdates);
  const [mobileAccessStatus, setMobileAccessStatus] = useState<MobileAccessStatus>(emptyMobileAccess);
  const [persistenceStatus, setPersistenceStatus] = useState<PersistenceStatus>(emptyPersistence);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState(() => storedSelectedModel());
  const [projectPath, setProjectPath] = useState(() => storedLastProject());
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadSearch, setThreadSearch] = useState("");
  const [threadActionsId, setThreadActionsId] = useState<string | null>(null);
  const [threadMenuPosition, setThreadMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [openingThreadId, setOpeningThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [userInputs, setUserInputs] = useState<UserInputRequest[]>([]);
  const [resolvingUserInputId, setResolvingUserInputId] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [recentProjects, setRecentProjects] = useState<string[]>(() => storedRecentProjects());
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(() => storedApprovalPolicy());
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>(() => storedSandboxMode());
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() => storedReasoningEffort());
  const [failedPrompt, setFailedPrompt] = useState<string | null>(null);
  const [submittingTurn, setSubmittingTurn] = useState(false);
  const [activeThreadIds, setActiveThreadIds] = useState<Set<string>>(() => new Set());
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [rightView, setRightView] = useState<"activity" | "settings">("activity");
  const projectPickerRef = useRef<HTMLButtonElement | null>(null);
  const threadActionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const conversationRef = useRef<HTMLElement | null>(null);
  const selectedModelRef = useRef(selectedModel);
  const selectedProjectPathRef = useRef(projectPath);
  const selectedThreadIdRef = useRef<string | null>(null);
  const navigationRevisionRef = useRef(0);
  const threadSearchRef = useRef(threadSearch);
  const followConversationRef = useRef(true);
  const lastPrompt = useRef("");
  const composerDraftsRef = useRef(new Map<string, ComposerDraft>());

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    selectedProjectPathRef.current = projectPath;
    if (projectPath) localStorage.setItem("rhzycode.lastProject", projectPath);
  }, [projectPath]);

  useEffect(() => {
    selectedThreadIdRef.current = threadId;
    if (projectPath && threadId) storeLastThread(projectPath, threadId);
  }, [projectPath, threadId]);

  useEffect(() => {
    threadSearchRef.current = threadSearch;
  }, [threadSearch]);

  useEffect(() => {
    const unsubscribers = [
      window.rhzycode.onAgentStatus(setAgentStatus),
      window.rhzycode.onGatewayStatus(setGatewayStatus),
      window.rhzycode.onSyncStatus(setSyncStatus),
      window.rhzycode.onAgentMessage(handleNotification),
      window.rhzycode.onSyncEvent(handleSyncEvent),
      window.rhzycode.onUpdateStatus(setUpdateStatus),
      window.rhzycode.onMobileAccessStatus(setMobileAccessStatus),
      window.rhzycode.onProjectsChanged((projects) => {
        const paths = projects.map((project) => project.path).slice(0, 50);
        setRecentProjects(paths);
        localStorage.setItem("rhzycode.recentProjects", JSON.stringify(paths));
      }),
      window.rhzycode.onDiagnostic((message) => {
        if (/error|failed/i.test(message)) {
          upsertActivity(`diagnostic-${Date.now()}`, "Agent diagnostic", message.trim(), "error");
        }
      }),
    ];

    void connectAndLoad();
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  useEffect(() => {
    if (agentStatus.state !== "connected") return;
    const timeout = window.setTimeout(() => {
      void loadThreads().catch((error) => {
        upsertActivity(`history-error-${Date.now()}`, "History unavailable", getErrorMessage(error), "error");
      });
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [agentStatus.state, projectPath, threadSearch]);

  useEffect(() => {
    if (!followConversationRef.current) return;
    const frame = requestAnimationFrame(() => {
      const conversation = conversationRef.current;
      if (conversation) conversation.scrollTop = conversation.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages]);

  useEffect(() => {
    if (!projectMenuOpen && !threadActionsId) return;

    const closeThreadMenu = (restoreFocus: boolean) => {
      setThreadActionsId(null);
      setThreadMenuPosition(null);
      if (restoreFocus) {
        window.requestAnimationFrame(() => threadActionsTriggerRef.current?.focus());
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (projectMenuOpen && !target.closest(".project-picker-wrap")) {
        setProjectMenuOpen(false);
      }
      if (threadActionsId && !target.closest(".thread-actions-menu, .thread-actions-toggle")) {
        closeThreadMenu(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (threadActionsId) {
        event.preventDefault();
        closeThreadMenu(true);
      } else if (projectMenuOpen) {
        event.preventDefault();
        setProjectMenuOpen(false);
        window.requestAnimationFrame(() => projectPickerRef.current?.focus());
      }
    };
    const handleViewportChange = (event?: Event) => {
      const target = event?.target;
      if (target instanceof Element && target.closest(".thread-actions-menu")) return;
      if (threadActionsId) closeThreadMenu(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [projectMenuOpen, threadActionsId]);

  const activeModel = useMemo(
    () => models.find((model) => model.model === selectedModel),
    [models, selectedModel],
  );
  const modelGroups = useMemo(
    () => groupModelsBySource(models, credentialStatus.providers),
    [credentialStatus.providers, models],
  );
  const reasoningEfforts = useMemo(() => modelReasoningEfforts(activeModel), [activeModel]);

  useEffect(() => {
    const next = reasoningEfforts.includes(reasoningEffort)
      ? reasoningEffort
      : reasoningEfforts[0] || "high";
    if (next !== reasoningEffort) setReasoningEffort(next);
    localStorage.setItem("rhzycode.reasoningEffort", next);
  }, [reasoningEffort, reasoningEfforts]);

  const running = isComposerRunning(threadId, activeThreadIds, submittingTurn);

  function setWorkspaceProject(path: string): void {
    selectedProjectPathRef.current = path;
    setProjectPath(path);
    if (path) localStorage.setItem("rhzycode.lastProject", path);
  }

  function setWorkspaceThread(id: string | null): void {
    selectedThreadIdRef.current = id;
    setThreadId(id);
    if (id && selectedProjectPathRef.current) {
      storeLastThread(selectedProjectPathRef.current, id);
    }
  }

  function markThreadActive(id: string, active: boolean): void {
    setActiveThreadIds((current) => {
      const next = new Set(current);
      if (active) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function composerDraftKey(project: string, id: string | null): string {
    return `${project}\u0000${id || "new"}`;
  }

  function saveComposerDraft(): void {
    const project = selectedProjectPathRef.current;
    if (!project) return;
    const key = composerDraftKey(project, selectedThreadIdRef.current);
    if (!composer.trim() && attachments.length === 0) {
      composerDraftsRef.current.delete(key);
      return;
    }
    composerDraftsRef.current.set(key, { text: composer, attachments: [...attachments] });
  }

  function restoreComposerDraft(project: string, id: string): void {
    const draft = composerDraftsRef.current.get(composerDraftKey(project, id));
    setComposer(draft?.text || "");
    setAttachments(draft ? [...draft.attachments] : []);
  }

  function resetConversation(): void {
    setWorkspaceThread(null);
    setMessages([]);
    setActivities([]);
    setComposer("");
    setFailedPrompt(null);
    setAttachments([]);
    lastPrompt.current = "";
  }

  function applyThreadDetail(detail: ThreadDetail, availableModels: ModelOption[] = models): void {
    const changedThread = selectedThreadIdRef.current !== detail.thread.id
      || selectedProjectPathRef.current !== detail.thread.projectPath;
    if (changedThread) {
      saveComposerDraft();
      restoreComposerDraft(detail.thread.projectPath, detail.thread.id);
    }
    setWorkspaceProject(detail.thread.projectPath);
    setWorkspaceThread(detail.thread.id);
    if (detail.thread.projectPath) rememberProject(detail.thread.projectPath);
    setMessages(detail.messages);
    setActivities(detail.timeline.map(activityFromTimeline));
    const active = isActiveThreadStatus(detail.thread.status);
    markThreadActive(detail.thread.id, active);
    const previousPrompt = [...detail.messages].reverse()
      .find((message) => message.role === "user")?.content || "";
    lastPrompt.current = previousPrompt;
    setFailedPrompt(detail.thread.status === "failed" && previousPrompt ? previousPrompt : null);
    if (availableModels.some((entry) => entry.model === detail.thread.model)) {
      setSelectedModel(detail.thread.model);
      localStorage.setItem("rhzycode.selectedModel", detail.thread.model);
    }
  }

  async function loadThreadDetail(
    selectedThreadId: string,
    revision: number,
    availableModels: ModelOption[] = models,
  ): Promise<void> {
    setOpeningThreadId(selectedThreadId);
    try {
      followConversationRef.current = true;
      const detail = await window.rhzycode.openThread(selectedThreadId);
      if (revision !== navigationRevisionRef.current) return;
      applyThreadDetail(detail, availableModels);
    } catch (error) {
      if (revision === navigationRevisionRef.current) {
        upsertActivity(`history-error-${Date.now()}`, "Thread unavailable", getErrorMessage(error), "error");
      }
    } finally {
      if (revision === navigationRevisionRef.current) setOpeningThreadId(null);
    }
  }

  async function connectAndLoad() {
    try {
      const [gateway, sync, snapshot, credentials, updates, mobileAccess, persistence, projects] = await Promise.all([
        window.rhzycode.getGatewayStatus(),
        window.rhzycode.getSyncStatus(),
        window.rhzycode.getSyncSnapshot(),
        window.rhzycode.getCredentialStatus(),
        window.rhzycode.getUpdateStatus(),
        window.rhzycode.getMobileAccessStatus(),
        window.rhzycode.getPersistenceStatus(),
        window.rhzycode.listProjects(),
      ]);
      setGatewayStatus(gateway);
      setSyncStatus(sync);
      setCredentialStatus(credentials);
      setUpdateStatus(updates);
      setMobileAccessStatus(mobileAccess);
      setPersistenceStatus(persistence);
      const storedProjects = [...new Set([
        selectedProjectPathRef.current,
        ...storedRecentProjects(),
      ].filter(Boolean))];
      const rememberedStoredProjects = (await Promise.allSettled(
        storedProjects.map((path) => window.rhzycode.rememberProject(path)),
      )).flatMap((result) => result.status === "fulfilled" ? [result.value.path] : []);
      const synchronizedProjects = [
        ...projects.map((project) => project.path),
        ...rememberedStoredProjects.filter((path) => !projects.some((project) => project.path === path)),
      ].slice(0, 50);
      setRecentProjects(synchronizedProjects);
      setApprovals(snapshot.approvals);
      setUserInputs(snapshot.userInputs || []);
      setActiveThreadIds(new Set(snapshot.threads.filter((thread) => isActiveThreadStatus(thread.status)).map((thread) => thread.id)));
      const status = await window.rhzycode.connectAgent();
      setAgentStatus(status);
      if (status.state !== "connected") return;
      const refreshedProjects = await window.rhzycode.listProjects();
      const connectedProjects = [
        ...refreshedProjects.map((project) => project.path),
        ...rememberedStoredProjects.filter((path) =>
          !refreshedProjects.some((project) => project.path === path)),
      ].slice(0, 50);
      setRecentProjects(connectedProjects);
      const restoredProject = connectedProjects.includes(selectedProjectPathRef.current)
        ? selectedProjectPathRef.current
        : connectedProjects[0] || "";
      const revision = ++navigationRevisionRef.current;
      setWorkspaceProject(restoredProject);
      const [response, availableThreads] = await Promise.all([
        window.rhzycode.listModels(),
        window.rhzycode.listThreads(restoredProject ? { cwd: restoredProject } : {}),
      ]);
      const available = response.data || [];
      setModels(available);
      setThreads(availableThreads);
      setActiveThreadIds((current) => new Set([
        ...current,
        ...availableThreads.filter((thread) => isActiveThreadStatus(thread.status)).map((thread) => thread.id),
      ]));
      const storedModel = storedSelectedModel();
      const initialModel = available.some((model) => model.model === storedModel)
        ? storedModel
        : available.find((model) => model.isDefault)?.model || available[0]?.model || "";
      setSelectedModel(initialModel);
      if (initialModel) localStorage.setItem("rhzycode.selectedModel", initialModel);

      const preferredThreadId = restoredProject ? storedLastThread(restoredProject) : null;
      const preferredThread = availableThreads.find((thread) => thread.id === preferredThreadId)
        || availableThreads[0];
      if (preferredThread) await loadThreadDetail(preferredThread.id, revision, available);
      else if (revision === navigationRevisionRef.current) resetConversation();
    } catch (error) {
      setAgentStatus({ state: "error", error: getErrorMessage(error) });
    }
  }

  async function loadThreads(): Promise<void> {
    const requestedProject = projectPath;
    const availableThreads = await window.rhzycode.listThreads({
      ...(requestedProject ? { cwd: requestedProject } : {}),
      ...(threadSearch.trim() ? { searchTerm: threadSearch.trim() } : {}),
    });
    if (requestedProject === selectedProjectPathRef.current) setThreads(availableThreads);
  }

  async function chooseProject(): Promise<string | null> {
    const path = await window.rhzycode.chooseProject();
    if (!path) return null;
    await selectProject(path);
    return path;
  }

  async function selectProject(path: string): Promise<void> {
    const revision = ++navigationRevisionRef.current;
    setProjectMenuOpen(false);
    saveComposerDraft();
    setWorkspaceProject(path);
    rememberProject(path);
    resetConversation();
    followConversationRef.current = true;
    try {
      const availableThreads = await window.rhzycode.listThreads({ cwd: path });
      if (revision !== navigationRevisionRef.current) return;
      setThreads(availableThreads);
      const preferredThreadId = storedLastThread(path);
      const preferredThread = availableThreads.find((thread) => thread.id === preferredThreadId)
        || availableThreads[0];
      if (preferredThread) await loadThreadDetail(preferredThread.id, revision);
    } catch (error) {
      if (revision === navigationRevisionRef.current) {
        upsertActivity(`history-error-${Date.now()}`, "History unavailable", getErrorMessage(error), "error");
      }
    }
  }

  function rememberProject(path: string) {
    setRecentProjects((current) => {
      const next = [path, ...current.filter((entry) => entry !== path)].slice(0, 50);
      localStorage.setItem("rhzycode.recentProjects", JSON.stringify(next));
      return next;
    });
    void window.rhzycode.rememberProject(path).catch(() => undefined);
  }

  function forgetProject(path: string) {
    setRecentProjects((current) => {
      const next = current.filter((entry) => entry !== path);
      localStorage.setItem("rhzycode.recentProjects", JSON.stringify(next));
      return next;
    });
    void window.rhzycode.forgetProject(path).catch(() => undefined);
  }

  function startNewTask() {
    navigationRevisionRef.current += 1;
    setProjectMenuOpen(false);
    closeThreadActions();
    setOpeningThreadId(null);
    saveComposerDraft();
    composerDraftsRef.current.delete(composerDraftKey(selectedProjectPathRef.current, null));
    resetConversation();
  }

  function changeSelectedModel(nextModel: string) {
    const recoverFailedTask = Boolean(
      failedPrompt
      && selectedThreadIdRef.current
      && isGemma31bBf16Model(selectedModelRef.current)
      && nextModel !== selectedModelRef.current,
    );
    if (recoverFailedTask) {
      const retryText = composer.trim() ? composer : failedPrompt || "";
      const retryAttachments = [...attachments];
      navigationRevisionRef.current += 1;
      setOpeningThreadId(null);
      resetConversation();
      setComposer(retryText);
      setAttachments(retryAttachments);
    }
    selectedModelRef.current = nextModel;
    setSelectedModel(nextModel);
    localStorage.setItem("rhzycode.selectedModel", nextModel);
  }

  async function chooseAttachments() {
    try {
      const selected = await window.rhzycode.chooseFiles();
      appendAttachments(selected);
    } catch (error) {
      upsertActivity(`attachment-error-${Date.now()}`, "Attachment unavailable", getErrorMessage(error), "error");
    }
  }

  function appendAttachments(selected: ComposerAttachment[]) {
    setAttachments((current) => {
      const combined = [...current];
      for (const attachment of selected) {
        if (!combined.some((entry) => entry.path === attachment.path)) combined.push(attachment);
      }
      return combined.slice(0, 20);
    });
  }

  async function pasteComposerImages(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (imageFiles.length === 0) return;

    event.preventDefault();
    const availableSlots = Math.max(0, 20 - attachments.length);
    if (availableSlots === 0) {
      upsertActivity(`attachment-error-${Date.now()}`, "Attachment limit reached", "A task can include at most 20 attachments.", "error");
      return;
    }

    const saved = await Promise.allSettled(imageFiles.slice(0, availableSlots).map(async (file) =>
      window.rhzycode.savePastedImage({
        name: file.name || "pasted-image",
        mimeType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })));
    appendAttachments(saved.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
    const failure = saved.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) {
      upsertActivity(`attachment-error-${Date.now()}`, "Clipboard image unavailable", getErrorMessage(failure.reason), "error");
    }
  }

  function beginRename(thread: ThreadSummary) {
    closeThreadActions();
    setRenamingThreadId(thread.id);
    setRenameValue(thread.title);
  }

  async function submitRename(threadId: string) {
    const name = renameValue.replace(/\s+/g, " ").trim();
    if (!name) return;
    try {
      await window.rhzycode.renameThread(threadId, name);
      setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, title: name } : thread));
      setRenamingThreadId(null);
    } catch (error) {
      upsertActivity(`rename-error-${Date.now()}`, "Rename failed", getErrorMessage(error), "error");
    }
  }

  async function permanentlyDeleteThread(selectedThreadId: string) {
    const thread = threads.find((entry) => entry.id === selectedThreadId);
    if (thread && isActiveThreadStatus(thread.status)) {
      closeThreadActions();
      window.alert("Stop the running task before deleting it.");
      return;
    }
    if (!window.confirm(`Permanently delete "${thread?.title || "this thread"}"? This cannot be undone.`)) return;
    closeThreadActions();
    try {
      await window.rhzycode.deleteThread(selectedThreadId);
      markThreadActive(selectedThreadId, false);
      setThreads((current) => current.filter((entry) => entry.id !== selectedThreadId));
      if (selectedThreadId === threadId) startNewTask();
    } catch (error) {
      const message = getErrorMessage(error);
      upsertActivity(`delete-error-${Date.now()}`, "Delete failed", message, "error");
      window.alert(`Delete failed: ${message}`);
    }
  }

  function closeThreadActions() {
    setThreadActionsId(null);
    setThreadMenuPosition(null);
  }

  function toggleThreadActions(event: ReactMouseEvent<HTMLButtonElement>, selectedThreadId: string) {
    setProjectMenuOpen(false);
    if (threadActionsId === selectedThreadId) {
      closeThreadActions();
      return;
    }

    const trigger = event.currentTarget;
    const bounds = trigger.getBoundingClientRect();
    const menuWidth = 180;
    const menuHeight = 108;
    const viewportPadding = 8;
    const availableBelow = window.innerHeight - bounds.bottom - viewportPadding;
    threadActionsTriggerRef.current = trigger;
    setThreadMenuPosition({
      top: availableBelow >= menuHeight
        ? bounds.bottom + 4
        : Math.max(viewportPadding, bounds.top - menuHeight - 4),
      left: Math.min(
        window.innerWidth - menuWidth - viewportPadding,
        Math.max(viewportPadding, bounds.right - menuWidth),
      ),
    });
    setThreadActionsId(selectedThreadId);
  }

  async function openThread(selectedThreadId: string) {
    const revision = ++navigationRevisionRef.current;
    if (selectedThreadIdRef.current !== selectedThreadId) {
      saveComposerDraft();
      restoreComposerDraft(selectedProjectPathRef.current, selectedThreadId);
    }
    setWorkspaceThread(selectedThreadId);
    setMessages([]);
    setActivities([]);
    setFailedPrompt(null);
    await loadThreadDetail(selectedThreadId, revision);
  }

  async function sendTurn(retryText?: string) {
    const selectedAttachments = retryText == null ? attachments : [];
    const text = (retryText ?? composer).trim() || (selectedAttachments.length ? "Review the attached files." : "");
    if (!text || running || agentStatus.state !== "connected") return;
    if (!projectPath) {
      await chooseProject();
      return;
    }

    const submissionProject = projectPath;
    const submissionModel = selectedModelRef.current;
    const submissionRevision = navigationRevisionRef.current;
    const existingThreadId = threadId;
    let submittedThreadId = existingThreadId;
    composerDraftsRef.current.delete(composerDraftKey(submissionProject, existingThreadId));
    setComposer("");
    setAttachments([]);
    setFailedPrompt(null);
    followConversationRef.current = true;
    lastPrompt.current = text;
    setSubmittingTurn(true);
    setMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: selectedAttachments.some((attachment) => attachment.kind === "file")
          ? `${text}\n\nAttachments: ${selectedAttachments.filter((attachment) => attachment.kind === "file").map((attachment) => attachment.name).join(", ")}`
          : text,
        images: selectedAttachments
          .filter((attachment) => attachment.kind === "image")
          .map((attachment) => ({ path: attachment.path, name: attachment.name })),
      },
    ]);

    try {
      let activeThreadId = submittedThreadId;
      if (!activeThreadId) {
        const response = await window.rhzycode.startThread({
          cwd: submissionProject,
          ...(submissionModel ? { model: submissionModel } : {}),
          approvalPolicy,
          sandboxMode,
        });
        activeThreadId = response.thread?.id || null;
        if (!activeThreadId) throw new Error("Agent Host did not return a thread id.");
        submittedThreadId = activeThreadId;
        const createdThread: ThreadSummary = {
          id: activeThreadId,
          hostId: "local-desktop",
          title: summarizePrompt(text),
          projectPath: submissionProject,
          model: submissionModel || "default",
          status: "running",
          updatedAt: new Date().toISOString(),
        };
        if (selectedProjectPathRef.current === submissionProject) {
          setThreads((current) => [
            createdThread,
            ...current.filter((thread) => thread.id !== activeThreadId),
          ]);
        }
        if (
          submissionRevision === navigationRevisionRef.current
          && selectedProjectPathRef.current === submissionProject
          && selectedThreadIdRef.current === null
        ) {
          setWorkspaceThread(activeThreadId);
        }
      }
      markThreadActive(activeThreadId, true);
      setThreads((current) => current.map((thread) => thread.id === activeThreadId
        ? {
            ...thread,
            title: thread.title === "New task" ? summarizePrompt(text) : thread.title,
            model: submissionModel || thread.model,
            status: "running",
            updatedAt: new Date().toISOString(),
          }
        : thread));
      await window.rhzycode.startTurn({
        threadId: activeThreadId,
        text,
        ...(submissionModel ? { model: submissionModel } : {}),
        approvalPolicy,
        sandboxMode,
        reasoningEffort,
        attachments: selectedAttachments,
      });
    } catch (error) {
      if (submittedThreadId) {
        markThreadActive(submittedThreadId, false);
        setThreads((current) => current.map((thread) => thread.id === submittedThreadId
          ? { ...thread, status: "failed", updatedAt: new Date().toISOString() }
          : thread));
      }
      const stillSelected = submittedThreadId
        ? selectedThreadIdRef.current === submittedThreadId
        : submissionRevision === navigationRevisionRef.current && selectedThreadIdRef.current === null;
      if (stillSelected) {
        setFailedPrompt(text);
        if (retryText == null) setAttachments(selectedAttachments);
        upsertActivity(`turn-error-${Date.now()}`, "Turn failed", getErrorMessage(error), "error");
      }
    } finally {
      setSubmittingTurn(false);
    }
  }

  async function interruptTurn() {
    const interruptedThreadId = selectedThreadIdRef.current;
    if (!interruptedThreadId) return;
    try {
      await window.rhzycode.interruptTurn(interruptedThreadId);
      markThreadActive(interruptedThreadId, false);
      setThreads((current) => current.map((thread) => thread.id === interruptedThreadId
        ? { ...thread, status: "interrupted", updatedAt: new Date().toISOString() }
        : thread));
    } catch (error) {
      if (selectedThreadIdRef.current === interruptedThreadId) {
        upsertActivity(`interrupt-error-${Date.now()}`, "Stop failed", getErrorMessage(error), "error");
      }
    }
  }

  async function saveProviderCredential(providerId: string, apiKey: string) {
    setSavingCredentialId(providerId);
    try {
      const result = await window.rhzycode.setProviderCredential(providerId, apiKey);
      setCredentialStatus(result.credentials);
      setGatewayStatus(result.gateway);
      setCredentialDrafts((current) => ({ ...current, [providerId]: "" }));
      if (result.gatewayError) {
        upsertActivity(`credential-error-${Date.now()}`, "Gateway configuration incomplete", result.gatewayError, "error");
      } else {
        await connectAndLoad();
      }
    } catch (error) {
      upsertActivity(`credential-error-${Date.now()}`, "Credential update failed", getErrorMessage(error), "error");
    } finally {
      setSavingCredentialId(null);
    }
  }

  async function configureLlmProvider(input: LlmProviderConfigurationInput) {
    try {
      if (typeof window.rhzycode.configureLlmProvider !== "function") {
        throw new Error("The desktop bridge is out of date. Fully quit and reopen RHZYCODE, then save again.");
      }
      const result = await window.rhzycode.configureLlmProvider(input);
      setCredentialStatus(result.credentials);
      setGatewayStatus(result.gateway);
      setCredentialDrafts((current) => ({ ...current, [input.providerId]: "" }));
      if (result.gatewayError) {
        upsertActivity(`provider-error-${Date.now()}`, "Provider saved; gateway unavailable", result.gatewayError, "error");
      } else {
        await connectAndLoad();
      }
    } catch (error) {
      upsertActivity(`provider-error-${Date.now()}`, "Provider configuration failed", getErrorMessage(error), "error");
      throw error;
    }
  }

  async function removeLlmProvider(providerId: string) {
    try {
      if (typeof window.rhzycode.removeLlmProvider !== "function") {
        throw new Error("The desktop bridge is out of date. Fully quit and reopen RHZYCODE, then try again.");
      }
      const result = await window.rhzycode.removeLlmProvider(providerId);
      setCredentialStatus(result.credentials);
      setGatewayStatus(result.gateway);
      if (result.gatewayError) {
        upsertActivity(`provider-error-${Date.now()}`, "Provider removed; gateway unavailable", result.gatewayError, "error");
      } else {
        await connectAndLoad();
      }
    } catch (error) {
      upsertActivity(`provider-error-${Date.now()}`, "Provider removal failed", getErrorMessage(error), "error");
      throw error;
    }
  }

  async function runUpdateAction(action: "check" | "download" | "install") {
    try {
      if (action === "install") {
        await window.rhzycode.installUpdate();
        return;
      }
      const status = action === "check"
        ? await window.rhzycode.checkForUpdates()
        : await window.rhzycode.downloadUpdate();
      setUpdateStatus(status);
      if (action === "check" && status.state === "not_available") {
        window.alert("Current version is up to date.");
      }
    } catch (error) {
      upsertActivity(`update-error-${Date.now()}`, "Update failed", getErrorMessage(error), "error");
    }
  }

  async function rotateMobileAccessKey() {
    if (
      mobileAccessStatus.accessKey
      && !window.confirm("Generate a new mobile access key? The current key will stop working immediately.")
    ) return;
    try {
      const accessKey = await window.rhzycode.rotateMobileAccessKey();
      setMobileAccessStatus((current) => ({ ...current, accessKey }));
    } catch (error) {
      upsertActivity(`mobile-access-error-${Date.now()}`, "Access key update failed", getErrorMessage(error), "error");
    }
  }

  async function updateSyncPort(port: number): Promise<SyncStatus> {
    const status = await window.rhzycode.setSyncPort(port);
    setSyncStatus(status);
    return status;
  }

  async function resolveApproval(id: string, decision: "approved" | "declined") {
    setResolvingApprovalId(id);
    try {
      await window.rhzycode.resolveApproval(id, decision);
      setApprovals((current) => current.filter((approval) => approval.id !== id));
    } catch (error) {
      upsertActivity(
        `approval-error-${Date.now()}`,
        "Approval failed",
        getErrorMessage(error),
        "error",
      );
    } finally {
      setResolvingApprovalId(null);
    }
  }

  async function resolveUserInput(id: string, answers: UserInputAnswers) {
    setResolvingUserInputId(id);
    try {
      await window.rhzycode.resolveUserInput(id, answers);
      setUserInputs((current) => current.filter((request) => request.id !== id));
    } catch (error) {
      upsertActivity(
        `user-input-error-${Date.now()}`,
        "Answer failed",
        getErrorMessage(error),
        "error",
      );
    } finally {
      setResolvingUserInputId(null);
    }
  }

  function handleNotification(notification: RpcNotification) {
    const method = notification.method || "unknown";
    const params = notification.params || {};
    const eventThreadId = notificationThreadId(params);
    const isSelectedThread = eventThreadId !== null && eventThreadId === selectedThreadIdRef.current;

    if (method === "turn/started" && eventThreadId) {
      markThreadActive(eventThreadId, true);
    }

    if (method === "turn/completed" && eventThreadId) {
      markThreadActive(eventThreadId, false);
    }

    if (!isSelectedThread) return;

    if (method === "item/agentMessage/delta") {
      const delta = String(params.delta || "");
      if (!delta) return;
      const messageId = String(params.itemId || `assistant-${eventThreadId || "current"}`);
      setMessages((current) => current.some((message) => message.id === messageId)
        ? current.map((message) => message.id === messageId
          ? { ...message, content: message.content + delta, streaming: true }
          : message)
        : [...current, { id: messageId, role: "assistant", content: delta, streaming: true }]);
      return;
    }

    if (method === "turn/completed") {
      const turn = (params.turn || {}) as Record<string, unknown>;
      const status = String(turn.status || "completed");
      if (/fail/i.test(status)) {
        const error = (turn.error || {}) as Record<string, unknown>;
        setFailedPrompt(lastPrompt.current || null);
        upsertActivity(
          `turn-error-${String(turn.id || Date.now())}`,
          "Turn failed",
          String(error.message || error.additionalDetails || "Agent turn failed"),
          "error",
        );
      } else {
        setFailedPrompt(null);
      }
      setMessages((current) => current.map((message) => message.streaming
        ? { ...message, streaming: false }
        : message));
    }

    if (method === "item/commandExecution/outputDelta") {
      appendActivity(
        String(params.itemId || "command-output"),
        "Command output",
        String(params.delta || ""),
        "running",
      );
    }

    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      appendActivity(
        String(params.itemId || "reasoning"),
        "Analysis",
        String(params.delta || ""),
        "running",
      );
    }

    if (method === "item/fileChange/patchUpdated") {
      upsertActivity(
        String(params.itemId || "file-change"),
        "File change",
        formatFileChanges(params.changes),
        "running",
      );
    }

    if (method === "turn/diff/updated") {
      upsertActivity(
        `diff-${String(params.turnId || "current")}`,
        "Workspace diff",
        String(params.diff || ""),
        "running",
      );
    }

    if (method === "error") {
      const error = (params.error || {}) as Record<string, unknown>;
      const willRetry = Boolean(params.willRetry);
      upsertActivity(
        `agent-error-${String(params.turnId || Date.now())}`,
        willRetry ? "Retrying" : "Agent error",
        String(error.message || error.additionalDetails || "Agent error"),
        willRetry ? "running" : "error",
      );
      if (!willRetry) {
        if (eventThreadId) markThreadActive(eventThreadId, false);
        setFailedPrompt(lastPrompt.current || null);
      }
    }

    if (method === "item/started" || method === "item/completed") {
      const item = (params.item || {}) as Record<string, unknown>;
      const itemId = String(item.id || `${method}-${Date.now()}`);
      const itemType = String(item.type || "activity");
      if (method === "item/completed" && itemType === "userMessage") {
        const incoming = userMessageFromNotification(itemId, item);
        setMessages((current) => {
          const exactIndex = current.findIndex((message) => message.id === itemId);
          if (exactIndex !== -1) {
            return current.map((message, index) => index === exactIndex ? incoming : message);
          }
          const reversedIndex = [...current].reverse().findIndex((message) => (
            message.role === "user" && message.content.trim() === incoming.content.trim()
          ));
          const optimisticIndex = reversedIndex === -1 ? -1 : current.length - reversedIndex - 1;
          if (optimisticIndex !== -1) {
            return current.map((message, index) => index === optimisticIndex
              ? { ...message, images: incoming.images }
              : message);
          }
          return [...current, incoming];
        });
        return;
      }
      upsertActivity(
        itemId,
        activityLabel(itemType),
        describeItem(item),
        method === "item/completed" ? "done" : "running",
      );
    }
  }

  function handleSyncEvent(event: AgentEvent) {
    if (event.type === "thread.updated") {
      const active = isActiveThreadStatus(event.thread.status);
      markThreadActive(event.thread.id, active);
      const searchTerm = threadSearchRef.current.trim().toLowerCase();
      const belongsInCurrentList = event.thread.projectPath === selectedProjectPathRef.current
        && (!searchTerm || event.thread.title.toLowerCase().includes(searchTerm));
      setThreads((current) => {
        const existingIndex = current.findIndex((thread) => thread.id === event.thread.id);
        if (!belongsInCurrentList) {
          return existingIndex === -1
            ? current
            : current.filter((thread) => thread.id !== event.thread.id);
        }
        if (existingIndex === -1) return [event.thread, ...current];
        return current.map((thread, index) => index === existingIndex ? event.thread : thread);
      });
    }
    if (event.type === "thread.removed") {
      markThreadActive(event.threadId, false);
      setThreads((current) => current.filter((thread) => thread.id !== event.threadId));
      if (event.threadId === selectedThreadIdRef.current) resetConversation();
    }
    if (event.type === "approval.requested") {
      setApprovals((current) => [
        event.approval,
        ...current.filter((approval) => approval.id !== event.approval.id),
      ]);
      setRightView("activity");
      setRightPanelOpen(true);
      upsertActivity(
        `sync-${event.sequence}`,
        event.approval.title,
        event.approval.detail,
        "running",
      );
    }
    if (event.type === "approval.resolved") {
      setApprovals((current) => current.filter((approval) => approval.id !== event.approvalId));
      upsertActivity(
        `sync-${event.sequence}`,
        "Approval resolved",
        event.decision === "approved" ? "Approved" : "Declined",
        "done",
      );
    }
    if (event.type === "user_input.requested") {
      setUserInputs((current) => [
        event.request,
        ...current.filter((request) => request.id !== event.request.id),
      ]);
      setRightView("activity");
      setRightPanelOpen(true);
      upsertActivity(
        `sync-${event.sequence}`,
        "Input requested",
        event.request.questions.map((question) => question.question).join("\n"),
        "running",
      );
    }
    if (event.type === "user_input.resolved") {
      setUserInputs((current) => current.filter((request) => request.id !== event.requestId));
      upsertActivity(`sync-${event.sequence}`, "Input received", "Answer submitted", "done");
    }
  }

  function upsertActivity(
    id: string,
    label: string,
    detail: string,
    state: ActivityEntry["state"],
  ) {
    setActivities((current) => {
      const entry = { id, label, detail, state };
      return current.some((value) => value.id === id)
        ? current.map((value) => (value.id === id ? entry : value))
        : [entry, ...current].slice(0, 30);
    });
  }

  function appendActivity(
    id: string,
    label: string,
    delta: string,
    state: ActivityEntry["state"],
  ) {
    if (!delta) return;
    setActivities((current) => {
      const existing = current.find((entry) => entry.id === id);
      const detail = `${existing?.detail || ""}${delta}`.slice(-12_000);
      const entry = { id, label, detail, state };
      return existing
        ? current.map((value) => (value.id === id ? entry : value))
        : [entry, ...current].slice(0, 30);
    });
  }

  return (
    <div className={`app-shell ${rightPanelOpen ? "with-panel" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <div><span className="product-name">RHZYCODE</span><span className="product-channel">DESKTOP</span></div>
        </div>

        <div className="project-picker-wrap">
          <button
            className="project-picker"
            ref={projectPickerRef}
            aria-haspopup="menu"
            aria-expanded={projectMenuOpen}
            aria-controls="project-menu"
            onClick={() => { closeThreadActions(); setProjectMenuOpen((value) => !value); }}
          >
            <FolderGit2 size={17} />
            <span>
              <strong>{projectPath ? basename(projectPath) : "Select project"}</strong>
              <small>{projectPath || "No working directory selected"}</small>
            </span>
            <ChevronDown size={15} />
          </button>
          {projectMenuOpen && (
            <div
              className="project-menu"
              id="project-menu"
              role="menu"
            >
              <button role="menuitem" onClick={() => { setProjectMenuOpen(false); void chooseProject(); }}><FolderOpen size={13} /> Open project folder</button>
              {recentProjects.length > 0 && <span className="project-menu-label">Recent</span>}
              {recentProjects.map((path) => (
                <div className="recent-project" key={path}>
                  <button role="menuitem" onClick={() => void selectProject(path)}><FolderGit2 size={13} /><span><strong>{basename(path)}</strong><small>{path}</small></span></button>
                  <button title={`Remove ${basename(path)} from recent projects`} onClick={() => forgetProject(path)}><X size={12} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="section-heading">
          <span>Tasks ({threads.length})</span>
          <button className="icon-button compact" title="New task" aria-label="New task" onClick={startNewTask}><Plus size={15} /></button>
        </div>
        <label className="thread-search">
          <Search size={13} />
          <input
            value={threadSearch}
            onChange={(event) => setThreadSearch(event.target.value)}
            placeholder="Search threads"
            aria-label="Search threads"
          />
          {threadSearch && <button title="Clear search" onClick={() => setThreadSearch("")}><X size={12} /></button>}
        </label>
        <div className="thread-list">
          {threads.length > 0 ? threads.map((thread) => (
            <div className={`thread-row-wrap ${thread.id === threadId ? "active" : ""}`} key={thread.id}>
              {renamingThreadId === thread.id ? (
                <div className="thread-rename">
                  <input aria-label={`Rename ${thread.title}`} value={renameValue} maxLength={200} autoFocus onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submitRename(thread.id); if (event.key === "Escape") setRenamingThreadId(null); }} />
                  <button title="Save name" disabled={!renameValue.trim()} onClick={() => void submitRename(thread.id)}><Check size={12} /></button>
                  <button title="Cancel rename" onClick={() => setRenamingThreadId(null)}><X size={12} /></button>
                </div>
              ) : (
                <button
                  className="thread-row"
                  title={`Model: ${thread.model}`}
                  onClick={() => void openThread(thread.id)}
                >
                  <span className={`thread-state ${thread.status}`} />
                  <span>
                    <strong>{thread.title}</strong>
                  </span>
                </button>
              )}
              {renamingThreadId !== thread.id && (
                <button className="thread-actions-toggle" title={`Thread actions for ${thread.title}`} aria-label={`Thread actions for ${thread.title}`} aria-haspopup="menu" aria-expanded={threadActionsId === thread.id} onClick={(event) => toggleThreadActions(event, thread.id)}><MoreHorizontal size={14} /></button>
              )}
              {threadActionsId === thread.id && threadMenuPosition && (
                <div className="thread-actions-menu" role="menu" style={threadMenuPosition}>
                  <button role="menuitem" onClick={() => beginRename(thread)}><Pencil size={13} /> Rename task</button>
                  <button role="menuitem" className="danger" onClick={() => void permanentlyDeleteThread(thread.id)}><Trash2 size={13} /> Delete task permanently</button>
                </div>
              )}
            </div>
          )) : <div className="sidebar-empty">{threadSearch ? "No matching threads" : "No tasks in this project"}</div>}
        </div>

      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div className="workspace-title">
            <GitBranch size={16} />
            <span>{projectPath ? basename(projectPath) : "Local workspace"}</span>
            <span className="branch-name">main</span>
          </div>
          <div className="header-actions">
            <label className="model-select" title="Model for the next turn">
              <Bot size={15} />
              <select value={selectedModel} onChange={(event) => changeSelectedModel(event.target.value)} disabled={!models.length} aria-label="Model for next turn">
                {!models.length && <option value="">Loading models</option>}
                {modelGroups.map((group) => (
                  <optgroup key={group.key} label={group.source}>
                    {group.models.map((model) => <option key={model.id} value={model.model}>{model.sourceModelName}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <button className={`icon-button ${rightPanelOpen ? "selected" : ""}`} title="Side panel" aria-label="Side panel" aria-pressed={rightPanelOpen} onClick={() => setRightPanelOpen((value) => !value)}>
              <PanelRight size={17} />
            </button>
          </div>
        </header>

        <section
          key={`${projectPath}\u0000${threadId || "new"}`}
          className="conversation"
          aria-live="polite"
          ref={conversationRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            followConversationRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
          }}
        >
          {messages.length === 0 ? (
            <div className="empty-thread">
              <div className="empty-icon"><Bot size={28} /></div>
              <h1>{projectPath ? "Start a new task" : "Select a project"}</h1>
              <p>{projectPath ? activeModel?.displayName || "Agent ready" : "Connect a local repository to begin"}</p>
            </div>
          ) : (
            <div className="message-list">
              {messages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <div className="message-body">
                    {message.streaming && <div className="message-author"><span className="streaming-label">Streaming</span></div>}
                    <div className="message-content">
                      {!!message.content && <div>{message.content}</div>}
                      {!!message.images?.length && (
                        <div className="message-images">
                          {message.images.map((image) => (
                            <MessageImage key={image.path} image={image} onOpen={setPreviewImage} />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <div className="composer-wrap">
          <div className="composer-box">
            {attachments.length > 0 && (
              <div className="attachment-list">
                {attachments.map((attachment) => (
                  <div className={`attachment-chip ${attachment.kind}`} key={attachment.path} title={attachment.path}>
                    {attachment.kind === "image" ? <ImageIcon size={14} /> : <File size={14} />}
                    <span><strong>{attachment.name}</strong><small>{formatFileSize(attachment.size)}</small></span>
                    <button title={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((entry) => entry.path !== attachment.path))}><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onPaste={(event) => void pasteComposerImages(event)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendTurn();
                }
              }}
              placeholder={projectPath ? "Describe the task" : "Select a project first"}
              aria-label="Task prompt"
              rows={3}
            />
            <div className="composer-toolbar">
              <div>
                <button className="icon-button" title="Attach files or images" onClick={() => void chooseAttachments()}><Paperclip size={17} /></button>
                <label className="approval-mode" title="Sandbox policy">
                  <ShieldCheck size={14} />
                  <select
                    aria-label="Sandbox policy"
                    value={sandboxMode}
                    onChange={(event) => {
                      const next = event.target.value as SandboxMode;
                      setSandboxMode(next);
                      localStorage.setItem("rhzycode.sandboxMode", next);
                    }}
                  >
                    <option value="read-only">Read only</option>
                    <option value="workspace-write">Edit workspace</option>
                    <option value="danger-full-access">Full access</option>
                  </select>
                </label>
                <label className="approval-mode" title="Approval mode">
                  <Check size={14} />
                  <select
                    aria-label="Approval mode"
                    value={approvalPolicy}
                    onChange={(event) => {
                      const next = event.target.value as ApprovalPolicy;
                      setApprovalPolicy(next);
                      localStorage.setItem("rhzycode.approvalPolicy", next);
                    }}
                  >
                    <option value="on-request">Ask as needed</option>
                    <option value="untrusted">Ask if untrusted</option>
                    <option value="never">Never ask</option>
                  </select>
                </label>
                <label className="approval-mode" title="Reasoning effort">
                  <Brain size={14} />
                  <select
                    aria-label="Reasoning effort"
                    value={reasoningEffort}
                    onChange={(event) => {
                      const next = event.target.value as ReasoningEffort;
                      setReasoningEffort(next);
                      localStorage.setItem("rhzycode.reasoningEffort", next);
                    }}
                  >
                    {reasoningEfforts.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort === "xhigh" ? "XHigh" : effort.charAt(0).toUpperCase() + effort.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
                {failedPrompt && !running && (
                  <button className="retry-turn" title="Retry last turn" onClick={() => void sendTurn(failedPrompt)}>
                    <RotateCcw size={14} /> Retry
                  </button>
                )}
              </div>
              {running ? (
                <button className="send-button stop" title="Stop" onClick={interruptTurn}><CircleStop size={17} /></button>
              ) : (
                <button className="send-button" title="Send" onClick={() => void sendTurn()} disabled={(!composer.trim() && attachments.length === 0) || agentStatus.state !== "connected"}><Send size={17} /></button>
              )}
            </div>
          </div>
        </div>
      </main>

      {rightPanelOpen && (
        <aside className="activity-panel">
          <div className="panel-tabs" role="tablist" aria-label="Side panel views">
            <button role="tab" aria-selected={rightView === "activity"} aria-busy={running} className={rightView === "activity" ? "active" : ""} onClick={() => setRightView("activity")}><Activity className={running ? "activity-wave-running" : ""} size={15} /> Activity</button>
            <button role="tab" aria-selected={rightView === "settings"} className={rightView === "settings" ? "active" : ""} onClick={() => setRightView("settings")}><Settings size={15} /> Settings</button>
            <button className="panel-close" title="Close side panel" aria-label="Close side panel" onClick={() => setRightPanelOpen(false)}><X size={15} /></button>
          </div>
          {rightView === "activity" ? (
            <ActivityView
              activities={activities}
              approvals={approvals}
              resolvingApprovalId={resolvingApprovalId}
              onResolve={resolveApproval}
              userInputs={userInputs}
              resolvingUserInputId={resolvingUserInputId}
              onResolveUserInput={resolveUserInput}
            />
          ) : (
            <SettingsView
              status={credentialStatus}
              updateStatus={updateStatus}
              mobileAccessStatus={mobileAccessStatus}
              persistenceStatus={persistenceStatus}
              syncStatus={syncStatus}
              drafts={credentialDrafts}
              savingProviderId={savingCredentialId}
              onChange={(providerId, value) => setCredentialDrafts((current) => ({ ...current, [providerId]: value }))}
              onSave={saveProviderCredential}
              onConfigure={configureLlmProvider}
              onRemove={removeLlmProvider}
              onUpdateAction={runUpdateAction}
              onRotateAccessKey={rotateMobileAccessKey}
              onSyncPortChange={updateSyncPort}
            />
          )}
        </aside>
      )}
      {previewImage && (
        <button className="image-preview" aria-label="Close image preview" onClick={() => setPreviewImage(null)}>
          <img src={previewImage} alt="Full size attachment" onClick={(event) => event.stopPropagation()} />
          <span><X size={20} /></span>
        </button>
      )}
    </div>
  );
}

function MessageImage({
  image,
  onOpen,
}: {
  image: { path: string; name: string };
  onOpen: (source: string) => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void window.rhzycode.readLocalImage(image.path)
      .then((value) => { if (active) setSource(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [image.path]);
  if (!source) return null;
  return (
    <button className="message-image" title={`Open ${image.name}`} onClick={() => onOpen(source)}>
      <img src={source} alt={image.name} />
    </button>
  );
}

function userMessageFromNotification(id: string, item: Record<string, unknown>): ChatMessage {
  const contentItems = Array.isArray(item.content) ? item.content : [];
  const content = contentItems.flatMap((rawItem) => {
    const entry = (rawItem || {}) as Record<string, unknown>;
    return entry.type === "text" ? [String(entry.text || "")] : [];
  }).filter(Boolean).join("\n");
  const images = contentItems.flatMap((rawItem) => {
    const entry = (rawItem || {}) as Record<string, unknown>;
    if (entry.type !== "image" && entry.type !== "localImage") return [];
    const imagePath = String(entry.path || "");
    if (!imagePath) return [];
    return [{ path: imagePath, name: imagePath.split(/[\\/]/).at(-1) || "image" }];
  });
  return { id, role: "user", content, ...(images.length ? { images } : {}) };
}

function ActivityView({
  activities,
  approvals,
  resolvingApprovalId,
  onResolve,
  userInputs,
  resolvingUserInputId,
  onResolveUserInput,
}: {
  activities: ActivityEntry[];
  approvals: ApprovalRequest[];
  resolvingApprovalId: string | null;
  onResolve: (id: string, decision: "approved" | "declined") => Promise<void>;
  userInputs: UserInputRequest[];
  resolvingUserInputId: string | null;
  onResolveUserInput: (id: string, answers: UserInputAnswers) => Promise<void>;
}) {
  return (
    <div className="activity-view">
      {(approvals.length > 0 || userInputs.length > 0) && (
        <div className="activity-requests">
          {userInputs.map((request) => (
            <UserInputRequestCard
              key={request.id}
              request={request}
              resolving={resolvingUserInputId === request.id}
              onSubmit={onResolveUserInput}
            />
          ))}
          {approvals.map((approval) => {
            const resolving = resolvingApprovalId === approval.id;
            return (
              <section className="approval-request" key={approval.id}>
                <div className="approval-heading">
                  <ShieldCheck size={16} />
                  <div>
                    <strong>{approval.title}</strong>
                    <small>{approvalKindLabel(approval.kind)}</small>
                  </div>
                </div>
                <pre>{approval.detail}</pre>
                <div className="approval-actions">
                  <button
                    className="decline"
                    disabled={resolving}
                    onClick={() => void onResolve(approval.id, "declined")}
                  >
                    <X size={14} /> Decline
                  </button>
                  <button
                    className={`approve ${resolving ? "resolving" : ""}`}
                    disabled={resolving}
                    onClick={() => void onResolve(approval.id, "approved")}
                  >
                    {resolving ? <RefreshCw size={14} /> : <Check size={14} />} Approve
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      )}
      <div className="activity-list">
        {activities.length === 0 ? <div className="activity-empty">Waiting for Agent activity</div> : activities.map((entry) => (
          <div className="activity-entry" key={entry.id}>
            <span className={`activity-state ${entry.state}`}>
              {entry.state === "done" ? <Check size={12} /> : entry.state === "running" ? <RefreshCw size={12} /> : "!"}
            </span>
            <div><strong>{entry.label}</strong><p>{entry.detail}</p></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UserInputRequestCard({
  request,
  resolving,
  onSubmit,
}: {
  request: UserInputRequest;
  resolving: boolean;
  onSubmit: (id: string, answers: UserInputAnswers) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const complete = request.questions.every((question) => Boolean(values[question.id]?.trim()));
  const submit = () => {
    const answers = Object.fromEntries(
      Object.entries(values)
        .filter(([, value]) => value.trim())
        .map(([questionId, value]) => [questionId, [value.trim()]]),
    );
    void onSubmit(request.id, answers);
  };

  return (
    <section className="user-input-request">
      <div className="approval-heading">
        <Bot size={16} />
        <div><strong>Agent question</strong><small>Input required</small></div>
      </div>
      <div className="question-list">
        {request.questions.map((question) => (
          <div className="question-field" key={question.id}>
            {question.header && <span>{question.header}</span>}
            <label>{question.question}</label>
            {question.options && question.options.length > 0 && (
              <div className="question-options">
                {question.options.map((option) => (
                  <button
                    className={values[question.id] === option.label ? "selected" : ""}
                    aria-pressed={values[question.id] === option.label}
                    key={option.label}
                    title={option.description || option.label}
                    type="button"
                    onClick={() => setValues((current) => ({ ...current, [question.id]: option.label }))}
                  >
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </button>
                ))}
              </div>
            )}
            {(!question.options || question.isOther) && (
              <input
                type={question.isSecret ? "password" : "text"}
                placeholder={question.isOther ? "Other" : "Response"}
                aria-label={question.header || question.question}
                value={values[question.id] || ""}
                onChange={(event) => setValues((current) => ({
                  ...current,
                  [question.id]: event.target.value,
                }))}
              />
            )}
          </div>
        ))}
      </div>
      <div className="approval-actions">
        <button className="decline" disabled={resolving} onClick={() => void onSubmit(request.id, {})}>
          <X size={14} /> Skip
        </button>
        <button className={`approve ${resolving ? "resolving" : ""}`} disabled={resolving || !complete} onClick={submit}>
          {resolving ? <RefreshCw size={14} /> : <Check size={14} />} Submit
        </button>
      </div>
    </section>
  );
}

function GatewayView({
  status,
  syncStatus,
  busy,
  onAction,
}: {
  status: GatewayStatus;
  syncStatus: SyncStatus;
  busy: boolean;
  onAction: (action: "start" | "stop" | "restart" | "probe") => Promise<void>;
}) {
  return (
    <div className="gateway-view">
      <section className="gateway-summary">
        <div className="gateway-heading"><Server size={18} /><div><strong>Internal Model Gateway</strong><small>Managed by RHZYCODE Desktop</small></div></div>
        <dl>
          <div><dt>Status</dt><dd className={`status-text ${status.state}`}>{status.state}</dd></div>
          <div><dt>Transport</dt><dd>Private runtime</dd></div>
          <div><dt>Providers</dt><dd>{status.providerCount}</dd></div>
          <div><dt>Models</dt><dd>{status.modelCount}</dd></div>
        </dl>
        {status.error && <p className="gateway-error">{status.error}</p>}
        <div className="gateway-actions">
          {status.state === "stopped" || status.state === "error" ? (
            <button title="Start gateway" disabled={busy} onClick={() => onAction("start")}><Play size={15} /> Start</button>
          ) : (
            <button title="Stop gateway" disabled={busy} onClick={() => onAction("stop")}><Square size={14} /> Stop</button>
          )}
          <button title="Restart gateway" disabled={status.state !== "running" || busy} onClick={() => onAction("restart")}><RotateCcw size={15} /> Restart</button>
          <button title="Test all provider connections" disabled={status.state !== "running"} onClick={() => onAction("probe")}><RefreshCw size={15} /> Test providers</button>
        </div>
      </section>

      <section className="gateway-section">
        <h3>Providers</h3>
        {status.providers.map((provider) => (
          <div className={`provider-row ${provider.health.state}`} key={provider.id} title={provider.health.lastError || provider.health.checkedAt || "Not checked yet"}>
            <span className="provider-icon"><Network size={14} /></span>
            <div>
              <strong>{provider.id}</strong>
              <small>
                {provider.protocol} · {provider.health.state}
                {provider.health.latencyMs != null ? ` · ${provider.health.latencyMs} ms` : ""}
                {provider.health.circuitState === "open" ? " · circuit open" : ""}
              </small>
              {provider.health.lastError && <small className="provider-error">{provider.health.lastError}</small>}
            </div>
            {provider.health.state === "healthy" ? <Check size={14} /> : provider.health.state === "degraded" ? <X size={14} /> : <RefreshCw size={13} />}
          </div>
        ))}
      </section>

      <section className="gateway-section">
        <h3>Mobile sync</h3>
        <div className="sync-row"><span className={`connection-dot ${syncStatus.state}`} /><div><strong>{syncStatus.state}</strong><small>{syncStatus.state === "running" ? `External port ${syncStatus.port}` : syncStatus.error || "Not running"}</small></div></div>
      </section>
    </div>
  );
}

function SettingsView({
  status,
  updateStatus,
  mobileAccessStatus,
  persistenceStatus,
  syncStatus,
  drafts,
  savingProviderId,
  onChange,
  onSave,
  onConfigure,
  onRemove,
  onUpdateAction,
  onRotateAccessKey,
  onSyncPortChange,
}: {
  status: CredentialStatus;
  updateStatus: UpdateStatus;
  mobileAccessStatus: MobileAccessStatus;
  persistenceStatus: PersistenceStatus;
  syncStatus: SyncStatus;
  drafts: Record<string, string>;
  savingProviderId: string | null;
  onChange: (providerId: string, value: string) => void;
  onSave: (providerId: string, value: string) => Promise<void>;
  onConfigure: (input: LlmProviderConfigurationInput) => Promise<void>;
  onRemove: (providerId: string) => Promise<void>;
  onUpdateAction: (action: "check" | "download" | "install") => Promise<void>;
  onRotateAccessKey: () => Promise<void>;
  onSyncPortChange: (port: number) => Promise<SyncStatus>;
}) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState(String(syncStatus.port));
  const [savingPort, setSavingPort] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);
  const [providerEditor, setProviderEditor] = useState<LlmProviderConfigurationInput | null>(null);
  const [providerEditorError, setProviderEditorError] = useState<string | null>(null);
  const [savingProviderConfig, setSavingProviderConfig] = useState(false);
  const parsedPort = Number(portDraft);
  const portValid = /^\d{1,5}$/.test(portDraft) && Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65_535;
  const portChanged = portValid && parsedPort !== syncStatus.port;

  useEffect(() => {
    if (savingPort) return;
    setPortDraft(String(syncStatus.port));
  }, [savingPort, syncStatus.port]);

  async function copyValue(field: string, value: string) {
    try {
      await window.rhzycode.copyText(value);
      setCopiedField(field);
      window.setTimeout(() => setCopiedField((current) => current === field ? null : current), 1400);
    } catch {
      setCopiedField(null);
    }
  }

  async function savePort() {
    if (!portValid) {
      setPortError("Port must be an integer between 1 and 65535.");
      return;
    }
    setSavingPort(true);
    setPortError(null);
    try {
      const status = await onSyncPortChange(parsedPort);
      setPortDraft(String(status.port));
    } catch (error) {
      setPortError(getErrorMessage(error));
    } finally {
      setSavingPort(false);
    }
  }

  function addProvider() {
    let sequence = status.providers.length + 1;
    let providerId = `provider-${sequence}`;
    while (status.providers.some((provider) => provider.providerId === providerId)) {
      providerId = `provider-${++sequence}`;
    }
    setProviderEditor({
      providerId,
      name: "",
      baseUrl: "",
      apiKey: "",
      protocol: "auto",
      models: [],
    });
    setProviderEditorError(null);
  }

  function editProvider(provider: CredentialStatus["providers"][number]) {
    const presentation = providerCredentialPresentation(provider.providerId);
    setProviderEditor({
      providerId: provider.providerId,
      name: provider.name || presentation.label.replace(/ API key$/i, ""),
      baseUrl: provider.baseUrl || presentation.domain,
      apiKey: "",
      protocol: provider.protocol || "responses",
      models: provider.models || [],
    });
    setProviderEditorError(null);
  }

  async function saveProviderConfiguration() {
    if (!providerEditor) return;
    if (!providerEditor.name.trim() || !providerEditor.baseUrl.trim()) {
      setProviderEditorError("Name and URL are required.");
      return;
    }
    if (!/^https?:\/\//i.test(providerEditor.baseUrl.trim())) {
      setProviderEditorError("URL must start with http:// or https://.");
      return;
    }
    setSavingProviderConfig(true);
    setProviderEditorError(null);
    try {
      await onConfigure(providerEditor);
      setProviderEditor(null);
    } catch (error) {
      setProviderEditorError(getErrorMessage(error));
    } finally {
      setSavingProviderConfig(false);
    }
  }

  async function removeProvider(providerId: string) {
    const provider = status.providers.find((entry) => entry.providerId === providerId);
    const name = provider ? providerDisplayName(provider) : providerId;
    if (!window.confirm(`Delete ${name} and its saved API key?`)) return;
    setSavingProviderConfig(true);
    setProviderEditorError(null);
    try {
      await onRemove(providerId);
      setProviderEditor(null);
    } catch (error) {
      setProviderEditorError(getErrorMessage(error));
    } finally {
      setSavingProviderConfig(false);
    }
  }

  return (
    <div className="settings-view">
      <section className="settings-section">
        <div className="settings-heading"><KeyRound size={18} /><div><strong>Provider credentials</strong><small>Windows secure storage</small></div></div>
        {!status.encryptionAvailable && <p className="gateway-error">Secure credential storage is unavailable.</p>}
        <div className="provider-config-toolbar">
          <button disabled={!status.encryptionAvailable || savingProviderConfig} onClick={addProvider}><Plus size={13} /> Add provider</button>
        </div>
        {providerEditor && (
          <div className="provider-editor">
            <div className="provider-editor-title">
              <strong>{status.providers.some((provider) => provider.providerId === providerEditor.providerId) ? "Edit provider" : "New provider"}</strong>
              <button title="Close provider editor" aria-label="Close provider editor" onClick={() => setProviderEditor(null)}><X size={14} /></button>
            </div>
            <div className="provider-editor-fields">
              <label><span>ID</span><input value={providerEditor.providerId} disabled={status.providers.some((provider) => provider.providerId === providerEditor.providerId)} onChange={(event) => setProviderEditor({ ...providerEditor, providerId: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} /></label>
              <label><span>Name</span><input value={providerEditor.name} onChange={(event) => setProviderEditor({ ...providerEditor, name: event.target.value })} /></label>
              <label className="wide"><span>URL</span><input type="url" placeholder="https://api.example.com/v1" value={providerEditor.baseUrl} onChange={(event) => setProviderEditor({ ...providerEditor, baseUrl: event.target.value })} /></label>
              <label className="wide"><span>KEY</span><input type="password" autoComplete="new-password" placeholder={status.providers.some((provider) => provider.providerId === providerEditor.providerId) ? "Leave blank to keep current KEY" : "API key"} value={providerEditor.apiKey} onChange={(event) => setProviderEditor({ ...providerEditor, apiKey: event.target.value })} /></label>
              <label className="wide"><span>Protocol</span><select value={providerEditor.protocol} onChange={(event) => setProviderEditor({ ...providerEditor, protocol: event.target.value as LlmProviderConfigurationInput["protocol"] })}><option value="auto">Auto detect (recommended)</option><option value="responses">Codex / Responses</option><option value="chat_completions">OpenAI / Chat Completions</option><option value="anthropic_messages">Claude / Messages</option></select></label>
              <label className="wide"><span>Models (optional)</span><textarea rows={3} placeholder="Auto-discover from /models" value={providerEditor.models.join("\n")} onChange={(event) => setProviderEditor({ ...providerEditor, models: event.target.value.split(/[\n,]/).map((value) => value.trim()).filter(Boolean) })} /></label>
            </div>
            {providerEditorError && <p className="gateway-error">{providerEditorError}</p>}
            <div className="provider-editor-actions">
              <span />
              <button className="secondary" disabled={savingProviderConfig} onClick={() => setProviderEditor(null)}>Cancel</button>
              <button disabled={savingProviderConfig || !providerEditor.providerId || !providerEditor.name.trim() || !providerEditor.baseUrl.trim()} onClick={() => void saveProviderConfiguration()}>{savingProviderConfig ? <RefreshCw className="spinning" size={13} /> : <Save size={13} />} {providerEditor.protocol === "auto" ? "Detect and save" : "Save"}</button>
            </div>
          </div>
        )}
        <div className="credential-list">
          {status.providers.map((provider) => {
            const draft = drafts[provider.providerId] || "";
            const saving = savingProviderId === provider.providerId;
            const presentation = providerCredentialPresentation(provider.providerId);
            const label = `${providerDisplayName(provider)} API key`;
            const domain = provider.baseUrl || presentation.domain;
            const protocol = provider.detectedProtocol || provider.protocol || "responses";
            return (
              <div className="credential-row" key={provider.providerId}>
                <div className="credential-label">
                  <span className={`connection-dot ${provider.configured ? "running" : "error"}`} />
                  <div><strong>{label}</strong><small>{domain} | {protocol} | KEY starts with {presentation.prefix} | {credentialSourceLabel(provider.source)}</small></div>
                </div>
                <input
                  type="password"
                  aria-label={`${label} for ${provider.custom ? domain : presentation.domain}`}
                  value={draft}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={provider.configured ? `Configured | paste new ${presentation.prefix} KEY` : `Enter the ${presentation.prefix} KEY`}
                  disabled={!status.encryptionAvailable || saving}
                  onChange={(event) => onChange(provider.providerId, event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && draft.trim()) void onSave(provider.providerId, draft); }}
                />
                <div className="credential-actions">
                  <button className="clear" disabled={saving || savingProviderConfig} onClick={() => editProvider(provider)}><Pencil size={13} /> Edit</button>
                  <button className="clear danger" disabled={saving || savingProviderConfig} onClick={() => void removeProvider(provider.providerId)}><Trash2 size={13} /> Delete</button>
                  <button disabled={!draft.trim() || saving || !status.encryptionAvailable} onClick={() => void onSave(provider.providerId, draft)}>{saving ? <RefreshCw size={13} /> : <Save size={13} />} Save KEY</button>
                </div>
              </div>
            );
          })}
          {status.providers.length === 0 && <div className="activity-empty">No credential-backed providers</div>}
        </div>
      </section>
      <section className="settings-section mobile-access-settings">
        <div className="settings-heading"><Smartphone size={18} /><div><strong>Mobile connection</strong><small>{syncStatus.state === "running" && mobileAccessStatus.accessKey ? "Ready" : "Unavailable"}</small></div></div>
        <div className="mobile-connection-fields">
          <ConnectionField
            label="IP address"
            value={syncStatus.host}
            copied={copiedField === "ip"}
            onCopy={() => void copyValue("ip", syncStatus.host)}
          />
          <label className="connection-field connection-port-field">
            <span>Port</span>
            <div>
              <input
                aria-label="Mobile connection port"
                inputMode="numeric"
                maxLength={5}
                value={portDraft}
                disabled={savingPort}
                onChange={(event) => {
                  setPortDraft(event.target.value.replace(/\D/g, "").slice(0, 5));
                  setPortError(null);
                }}
                onKeyDown={(event) => { if (event.key === "Enter" && portChanged) void savePort(); }}
              />
              <button
                title="Save mobile connection port"
                aria-label="Save mobile connection port"
                disabled={!portChanged || savingPort}
                onClick={() => void savePort()}
              >
                {savingPort ? <RefreshCw className="spinning" size={13} /> : <Save size={13} />}
              </button>
            </div>
          </label>
          <ConnectionField
            label="Access key"
            value={mobileAccessStatus.accessKey?.key || "Not generated"}
            copied={copiedField === "key"}
            onCopy={mobileAccessStatus.accessKey
              ? () => void copyValue("key", mobileAccessStatus.accessKey!.key)
              : undefined}
            secret
          />
        </div>
        {portError && <p className="gateway-error">{portError}</p>}
        {syncStatus.error && <p className="gateway-error">{syncStatus.error}</p>}
        <div className="update-actions">
          <button
            disabled={!persistenceStatus.encryptionAvailable}
            onClick={() => void onRotateAccessKey()}
          >
            <RefreshCw size={13} /> {mobileAccessStatus.accessKey ? "Regenerate key" : "Generate key"}
          </button>
        </div>
      </section>
      <section className="settings-section update-settings">
        <div className="settings-heading"><Download size={18} /><div><strong>Application updates</strong><small>{updateStateLabel(updateStatus)}</small></div></div>
        {updateStatus.error && <p className="gateway-error">{updateStatus.error}</p>}
        {updateStatus.state === "downloading" && (
          <div className="update-progress"><span style={{ width: `${updateStatus.percent || 0}%` }} /></div>
        )}
        <div className="update-actions">
          {updateStatus.state === "available" ? (
            <button onClick={() => void onUpdateAction("download")}><Download size={13} /> Download {updateStatus.version || "update"}</button>
          ) : updateStatus.state === "downloaded" ? (
            <button onClick={() => void onUpdateAction("install")}><RotateCcw size={13} /> Install and restart</button>
          ) : (
            <button disabled={!updateStatus.enabled || updateStatus.state === "checking" || updateStatus.state === "downloading"} onClick={() => void onUpdateAction("check")}><RefreshCw size={13} /> Check for updates</button>
          )}
        </div>
      </section>
    </div>
  );
}

function ConnectionField({
  label,
  value,
  copied,
  onCopy,
  secret = false,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy?: () => void;
  secret?: boolean;
}) {
  return (
    <div className={`connection-field ${secret ? "secret" : ""}`}>
      <span>{label}</span>
      <div>
        <code>{value}</code>
        {onCopy && (
          <button title={`Copy ${label.toLowerCase()}`} aria-label={`Copy ${label.toLowerCase()}`} onClick={onCopy}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
      </div>
    </div>
  );
}
