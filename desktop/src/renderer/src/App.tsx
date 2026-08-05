import {
  Activity,
  Archive,
  ArrowUpDown,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Copy,
  Download,
  File,
  FolderOpen,
  GitBranch,
  House,
  Image as ImageIcon,
  KeyRound,
  Moon,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Send,
  Search,
  Save,
  ShieldCheck,
  Smartphone,
  Sun,
  Settings,
  Square,
  TerminalSquare,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { codexComposerCommandPrompt, parseCodexComposerCommand, type ParsedCodexComposerCommand } from "@rhzycode/protocol";
import type {
  AgentEvent,
  ApprovalRequest,
  ThreadDetail,
  ThreadSummary,
  UserInputAnswers,
  UserInputRequest,
} from "@rhzycode/protocol";
import type {
  AgentStatus,
  ApprovalPolicy,
  ComposerAttachment,
  ConversationExportItem,
  CredentialStatus,
  GatewayStatus,
  LlmProviderConfigurationInput,
  ModelOption,
  MobileAccessStatus,
  PersistenceStatus,
  ReasoningEffort,
  RpcNotification,
  SandboxMode,
  SkillImportSource,
  SkillsStatus,
  SyncStatus,
  TaskActivityStatus,
  TerminalStatus,
  UpdateStatus,
} from "../../shared/desktop-api";
import { turnScopedItemId } from "../../shared/item-identity";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  activityFromTimeline,
  activityLabel,
  approvalKindLabel,
  basename,
  completeAssistantMessage,
  credentialSourceLabel,
  describeItem,
  fitImagePreviewSize,
  formatFileChanges,
  formatFileSize,
  getErrorMessage,
  groupModelsBySource,
  groupThreadsByProject,
  isActiveThreadStatus,
  isComposerRunning,
  isSameProjectPath,
  mergeActivityDeltas,
  mergeStreamingMessageDeltas,
  modelReasoningEfforts,
  notificationThreadId,
  providerDisplayName,
  providerCredentialPresentation,
  reconcileProjectRegistry,
  storedApprovalPolicy,
  storedCollapsedProjectPaths,
  storedForgottenProjects,
  storedLastProject,
  storedLastThread,
  storedRecentProjects,
  storedReasoningEffort,
  storedSandboxMode,
  storedSelectedModel,
  storeCollapsedProjectPaths,
  storeLastThread,
  summarizePrompt,
  updateStateLabel,
  type ActivityDelta,
  type ActivityEntry,
  type ChatMessage,
} from "./app-utils";

interface ComposerDraft {
  text: string;
  attachments: ComposerAttachment[];
}

interface PendingMessageDelta {
  threadId: string;
  delta: string;
}

interface PendingActivityDelta extends ActivityDelta {
  threadId: string;
}

interface ThreadViewSnapshot {
  messages: ChatMessage[];
  activities: ActivityEntry[];
  failedPrompt: string | null;
  lastPrompt: string;
}

const MAX_CACHED_THREAD_VIEWS = 10;

type AppDialogView = "settings" | "skills" | "transfer" | "export";
type ThemeMode = "light" | "dark";
type ThemePreset = "forest" | "studio" | "glass" | "noir" | "rose" | "ocean";
const THEME_PRESETS: Array<{ id: ThemePreset; label: string }> = [
  { id: "forest", label: "Forest" },
  { id: "studio", label: "Studio" },
  { id: "glass", label: "Glass" },
  { id: "noir", label: "Noir" },
  { id: "rose", label: "Rose" },
  { id: "ocean", label: "Ocean" },
];
const THEME_PRESET_IDS = new Set<string>(THEME_PRESETS.map((item) => item.id));

interface ExportProjectGroup {
  key: string;
  path: string;
  name: string;
  conversations: ConversationExportItem[];
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
  port: 0,
  url: null,
  error: null,
};

const emptyCredentials: CredentialStatus = {
  encryptionAvailable: true,
  providers: [],
};

const emptyUpdates: UpdateStatus = {
  enabled: false,
  currentVersion: null,
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

const emptySkills: SkillsStatus = {
  skills: [],
  errors: [],
  sources: {
    codex: { available: false, count: 0 },
    claude: { available: false, count: 0 },
  },
};

function storedThemeMode(): ThemeMode {
  const mode = localStorage.getItem("rhzycode.themeMode") === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
  return mode;
}

function storedThemePreset(): ThemePreset {
  const preset = localStorage.getItem("rhzycode.themePreset");
  const value = THEME_PRESET_IDS.has(preset ?? "") ? (preset as ThemePreset) : "forest";
  document.documentElement.dataset.preset = value;
  return value;
}

export function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(storedThemeMode);
  const [themePreset, setThemePreset] = useState<ThemePreset>(storedThemePreset);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ state: "connecting", error: null });
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>(emptyGateway);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(emptySync);
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus>(emptyCredentials);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(emptyUpdates);
  const [mobileAccessStatus, setMobileAccessStatus] = useState<MobileAccessStatus>(emptyMobileAccess);
  const [persistenceStatus, setPersistenceStatus] = useState<PersistenceStatus>(emptyPersistence);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState(() => storedSelectedModel());
  const [projectPath, setProjectPath] = useState(() => storedLastProject());
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadSearch, setThreadSearch] = useState("");
  const [collapsedProjectPaths, setCollapsedProjectPaths] = useState<Set<string>>(() => new Set(storedCollapsedProjectPaths()));
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
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [recentProjects, setRecentProjects] = useState<string[]>(() => storedRecentProjects());
  const [forgottenProjectPaths, setForgottenProjectPaths] = useState<string[]>(() => storedForgottenProjects());
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(() => storedApprovalPolicy());
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>(() => storedSandboxMode());
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() => storedReasoningEffort());
  const [failedPrompt, setFailedPrompt] = useState<string | null>(null);
  const [submittingTurn, setSubmittingTurn] = useState(false);
  const [activeThreadIds, setActiveThreadIds] = useState<Set<string>>(() => new Set());
  const [taskActivity, setTaskActivity] = useState<TaskActivityStatus>({
    activeCount: 0,
    runningCount: 0,
    waitingCount: 0,
    lastEvent: null,
    accent: "idle",
    toast: null,
  });
  const [taskToast, setTaskToast] = useState<{ tone: "success" | "error" | "warning" | "info"; message: string } | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [primaryView, setPrimaryView] = useState<"workspace" | "terminal">("workspace");
  const [dialogView, setDialogView] = useState<AppDialogView | null>(null);
  const [exportItems, setExportItems] = useState<ConversationExportItem[]>([]);
  const [selectedExportThreadIds, setSelectedExportThreadIds] = useState<Set<string>>(() => new Set());
  const [exportLoading, setExportLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const threadActionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const conversationRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composerValueRef = useRef(composer);
  const attachmentsRef = useRef(attachments);
  const bootstrapStartedRef = useRef(false);
  const bootstrapCompleteRef = useRef(false);
  const bootstrapComposerTouchedRef = useRef(false);
  const threadSearchRef = useRef<HTMLInputElement | null>(null);
  const modelSelectRef = useRef<HTMLSelectElement | null>(null);
  const selectedModelRef = useRef(selectedModel);
  const selectedProjectPathRef = useRef(projectPath);
  const selectedThreadIdRef = useRef<string | null>(null);
  const loadedThreadIdRef = useRef<string | null>(null);
  const openingThreadIdRef = useRef<string | null>(null);
  const navigationRevisionRef = useRef(0);
  const followConversationRef = useRef(true);
  const lastPrompt = useRef("");
  const composerDraftsRef = useRef(new Map<string, ComposerDraft>());
  const threadViewCacheRef = useRef(new Map<string, ThreadViewSnapshot>());
  const pendingThreadDeletionsRef = useRef(new Set<string>());
  const composerDragDepthRef = useRef(0);
  const streamingFrameRef = useRef<number | null>(null);
  const pendingMessageDeltasRef = useRef(new Map<string, PendingMessageDelta>());
  const pendingActivityDeltasRef = useRef(new Map<string, PendingActivityDelta>());
  const recentProjectsRef = useRef(recentProjects);
  const forgottenProjectPathsRef = useRef(forgottenProjectPaths);

  composerValueRef.current = composer;
  attachmentsRef.current = attachments;

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode;
    localStorage.setItem("rhzycode.themeMode", themeMode);
  }, [themeMode]);

  useEffect(() => {
    document.documentElement.dataset.preset = themePreset;
    localStorage.setItem("rhzycode.themePreset", themePreset);
  }, [themePreset]);

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    recentProjectsRef.current = recentProjects;
  }, [recentProjects]);

  useEffect(() => {
    forgottenProjectPathsRef.current = forgottenProjectPaths;
  }, [forgottenProjectPaths]);

  useEffect(() => {
    selectedProjectPathRef.current = projectPath;
    if (projectPath) localStorage.setItem("rhzycode.lastProject", projectPath);
  }, [projectPath]);

  useEffect(() => {
    selectedThreadIdRef.current = threadId;
    if (projectPath && threadId) storeLastThread(projectPath, threadId);
  }, [projectPath, threadId]);

  useEffect(() => {
    if (!dialogView) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDialogView(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [dialogView]);

  useLayoutEffect(() => {
    if (composerFocusRequest === 0 || primaryView !== "workspace" || dialogView) return;
    composerRef.current?.focus({ preventScroll: true });
  }, [composerFocusRequest, dialogView, primaryView]);

  useEffect(() => {
    const focusComposerWhenWindowActivates = () => {
      if (document.visibilityState !== "visible" || primaryView !== "workspace" || dialogView) return;
      if (document.activeElement === document.body || document.activeElement === null) {
        composerRef.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("focus", focusComposerWhenWindowActivates);
    document.addEventListener("visibilitychange", focusComposerWhenWindowActivates);
    return () => {
      window.removeEventListener("focus", focusComposerWhenWindowActivates);
      document.removeEventListener("visibilitychange", focusComposerWhenWindowActivates);
    };
  }, [dialogView, primaryView]);

  useEffect(() => window.rhzycode.onWindowFocus(() => {
    if (primaryView !== "workspace" || dialogView) return;
    if (document.activeElement === document.body || document.activeElement === null) {
      composerRef.current?.focus({ preventScroll: true });
    }
  }), [dialogView, primaryView]);

  useEffect(() => {
    const unsubscribers = [
      window.rhzycode.onAgentStatus(setAgentStatus),
      window.rhzycode.onTaskActivity((status) => {
        setTaskActivity(status);
        if (status.toast) setTaskToast(status.toast);
      }),
      window.rhzycode.onGatewayStatus(setGatewayStatus),
      window.rhzycode.onSyncStatus(setSyncStatus),
      window.rhzycode.onAgentMessage(handleNotification),
      window.rhzycode.onSyncEvent(handleSyncEvent),
      window.rhzycode.onUpdateStatus(setUpdateStatus),
      window.rhzycode.onMobileAccessStatus(setMobileAccessStatus),
      window.rhzycode.onProjectsChanged((projects) => {
        const synchronized = reconcileProjectRegistry(
          recentProjectsRef.current,
          projects.map((project) => project.path),
          forgottenProjectPathsRef.current,
        );
        recentProjectsRef.current = synchronized.projects;
        forgottenProjectPathsRef.current = synchronized.forgottenProjects;
        setRecentProjects(synchronized.projects);
        setForgottenProjectPaths(synchronized.forgottenProjects);
        localStorage.setItem("rhzycode.recentProjects", JSON.stringify(synchronized.projects));
        localStorage.setItem("rhzycode.forgottenProjects", JSON.stringify(synchronized.forgottenProjects));

        if (synchronized.removedProjects.some((path) =>
          isSameProjectPath(path, selectedProjectPathRef.current))) {
          navigationRevisionRef.current += 1;
          localStorage.removeItem("rhzycode.lastProject");
          setWorkspaceProject("");
          resetConversation();
        }
      }),
      window.rhzycode.onDiagnostic((message) => {
        if (/error|failed/i.test(message)) {
          upsertActivity(`diagnostic-${Date.now()}`, "Agent diagnostic", message.trim(), "error");
        }
      }),
    ];

    if (!bootstrapStartedRef.current) {
      bootstrapStartedRef.current = true;
      void connectAndLoad();
    }
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  useEffect(() => {
    if (!followConversationRef.current) return;
    const frame = requestAnimationFrame(() => {
      const conversation = conversationRef.current;
      if (conversation) conversation.scrollTop = conversation.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages]);

  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => {
      if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
      event.preventDefault();
      if (event.type === "drop") {
        composerDragDepthRef.current = 0;
        setComposerDragActive(false);
      }
    };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);

  useEffect(() => () => discardPendingStreamingUpdates(), []);

  useEffect(() => {
    if (!threadActionsId) return;

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
      if (threadActionsId && !target.closest(".thread-actions-menu, .thread-actions-toggle")) {
        closeThreadMenu(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (threadActionsId) {
        event.preventDefault();
        closeThreadMenu(true);
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
  }, [threadActionsId]);

  const activeModel = useMemo(
    () => models.find((model) => model.model === selectedModel),
    [models, selectedModel],
  );
  const modelGroups = useMemo(
    () => groupModelsBySource(models, credentialStatus.providers),
    [credentialStatus.providers, models],
  );
  const projectGroups = useMemo(() => {
    const isForgotten = (path: string) => forgottenProjectPaths.some((entry) => isSameProjectPath(entry, path));
    return groupThreadsByProject(
      recentProjects.filter((path) => !isForgotten(path)),
      isForgotten(projectPath) ? "" : projectPath,
      threads.filter((thread) => !isForgotten(thread.projectPath)),
      threadSearch,
    );
  }, [forgottenProjectPaths, projectPath, recentProjects, threadSearch, threads]);
  const exportProjectGroups = useMemo<ExportProjectGroup[]>(() => {
    const paths = new Map<string, string>();
    const addPath = (value: string) => {
      const key = value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
      if (!paths.has(key)) paths.set(key, value);
    };
    for (const path of recentProjects) addPath(path);
    for (const item of exportItems) addPath(item.projectPath);
    return [...paths.entries()].flatMap(([key, path]) => {
      const conversations = exportItems
        .filter((item) => isSameProjectPath(item.projectPath, path))
        .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
      return conversations.length > 0
        ? [{ key, path, name: basename(path), conversations }]
        : [];
    });
  }, [exportItems, recentProjects]);
  const reasoningEfforts = useMemo(() => modelReasoningEfforts(activeModel), [activeModel]);

  useEffect(() => {
    const next = reasoningEfforts.includes(reasoningEffort)
      ? reasoningEffort
      : reasoningEfforts[0] || "high";
    if (next !== reasoningEffort) setReasoningEffort(next);
    localStorage.setItem("rhzycode.reasoningEffort", next);
  }, [reasoningEffort, reasoningEfforts]);

  useEffect(() => {
    if (!taskToast) return;
    const timer = window.setTimeout(() => setTaskToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [taskToast]);

  const running = isComposerRunning(threadId, activeThreadIds, submittingTurn);
  const isOpeningSelectedThread = threadId !== null && openingThreadId === threadId;

  function applyPendingStreamingUpdates(): void {
    const selectedThreadId = selectedThreadIdRef.current;
    const messageDeltas = new Map<string, string>();
    const activityDeltas = new Map<string, ActivityDelta>();
    for (const [id, update] of pendingMessageDeltasRef.current) {
      if (update.threadId === selectedThreadId) messageDeltas.set(id, update.delta);
    }
    for (const [id, update] of pendingActivityDeltasRef.current) {
      if (update.threadId === selectedThreadId) {
        activityDeltas.set(id, {
          label: update.label,
          delta: update.delta,
          state: update.state,
        });
      }
    }
    pendingMessageDeltasRef.current.clear();
    pendingActivityDeltasRef.current.clear();
    if (messageDeltas.size > 0) {
      setMessages((current) => mergeStreamingMessageDeltas(current, messageDeltas));
    }
    if (activityDeltas.size > 0) {
      setActivities((current) => mergeActivityDeltas(current, activityDeltas));
    }
  }

  function scheduleStreamingUpdate(): void {
    if (streamingFrameRef.current !== null) return;
    streamingFrameRef.current = window.requestAnimationFrame(() => {
      streamingFrameRef.current = null;
      applyPendingStreamingUpdates();
    });
  }

  function flushPendingStreamingUpdates(): void {
    if (streamingFrameRef.current !== null) {
      window.cancelAnimationFrame(streamingFrameRef.current);
      streamingFrameRef.current = null;
    }
    applyPendingStreamingUpdates();
  }

  function discardPendingStreamingUpdates(): void {
    if (streamingFrameRef.current !== null) {
      window.cancelAnimationFrame(streamingFrameRef.current);
      streamingFrameRef.current = null;
    }
    pendingMessageDeltasRef.current.clear();
    pendingActivityDeltasRef.current.clear();
  }

  function appendMessageDelta(threadId: string, messageId: string, delta: string): void {
    const pending = pendingMessageDeltasRef.current.get(messageId);
    pendingMessageDeltasRef.current.set(messageId, {
      threadId,
      delta: pending?.threadId === threadId ? pending.delta + delta : delta,
    });
    scheduleStreamingUpdate();
  }

  function appendActivityDelta(
    threadId: string,
    id: string,
    label: string,
    delta: string,
    state: ActivityEntry["state"],
  ): void {
    if (!delta) return;
    const pending = pendingActivityDeltasRef.current.get(id);
    pendingActivityDeltasRef.current.set(id, {
      threadId,
      label,
      delta: `${pending?.threadId === threadId ? pending.delta : ""}${delta}`.slice(-12_000),
      state,
    });
    scheduleStreamingUpdate();
  }

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
    const text = composerValueRef.current;
    const currentAttachments = attachmentsRef.current;
    if (!text.trim() && currentAttachments.length === 0) {
      composerDraftsRef.current.delete(key);
      return;
    }
    composerDraftsRef.current.set(key, { text, attachments: [...currentAttachments] });
  }

  function markBootstrapComposerTouched(): void {
    if (!bootstrapCompleteRef.current) bootstrapComposerTouchedRef.current = true;
  }

  function restoreComposerDraft(project: string, id: string): void {
    const draft = composerDraftsRef.current.get(composerDraftKey(project, id));
    setComposer(draft?.text || "");
    setAttachments(draft ? [...draft.attachments] : []);
  }

  function rememberThreadView(id: string, snapshot: ThreadViewSnapshot): void {
    const cache = threadViewCacheRef.current;
    cache.delete(id);
    cache.set(id, snapshot);
    while (cache.size > MAX_CACHED_THREAD_VIEWS) {
      const oldestId = cache.keys().next().value;
      if (typeof oldestId !== "string") break;
      cache.delete(oldestId);
    }
  }

  function cacheCurrentThreadView(): void {
    const currentThreadId = selectedThreadIdRef.current;
    if (!currentThreadId || loadedThreadIdRef.current !== currentThreadId) return;
    rememberThreadView(currentThreadId, {
      messages,
      activities,
      failedPrompt,
      lastPrompt: lastPrompt.current,
    });
  }

  function resetConversation(): void {
    discardPendingStreamingUpdates();
    openingThreadIdRef.current = null;
    setOpeningThreadId(null);
    setWorkspaceThread(null);
    loadedThreadIdRef.current = null;
    setMessages([]);
    setActivities([]);
    setComposer("");
    setFailedPrompt(null);
    setAttachments([]);
    lastPrompt.current = "";
  }

  function focusComposer(): void {
    composerRef.current?.focus({ preventScroll: true });
    setComposerFocusRequest((current) => current + 1);
  }

  function leaveRemovedThread(removedThreadId: string): void {
    if (removedThreadId !== selectedThreadIdRef.current) return;
    navigationRevisionRef.current += 1;
    composerDraftsRef.current.delete(composerDraftKey(selectedProjectPathRef.current, removedThreadId));
    resetConversation();
    focusComposer();
  }

  function applyThreadDetail(detail: ThreadDetail, availableModels: ModelOption[] = models): void {
    discardPendingStreamingUpdates();
    const changedThread = selectedThreadIdRef.current !== detail.thread.id
      || !isSameProjectPath(selectedProjectPathRef.current, detail.thread.projectPath);
    if (changedThread) {
      saveComposerDraft();
      restoreComposerDraft(detail.thread.projectPath, detail.thread.id);
    }
    const nextActivities = detail.timeline.map(activityFromTimeline);
    const previousPrompt = [...detail.messages].reverse()
      .find((message) => message.role === "user")?.content || "";
    const nextFailedPrompt = detail.thread.status === "failed" && previousPrompt ? previousPrompt : null;
    rememberThreadView(detail.thread.id, {
      messages: detail.messages,
      activities: nextActivities,
      failedPrompt: nextFailedPrompt,
      lastPrompt: previousPrompt,
    });
    setWorkspaceProject(detail.thread.projectPath);
    setWorkspaceThread(detail.thread.id);
    loadedThreadIdRef.current = detail.thread.id;
    setMessages(detail.messages);
    setActivities(nextActivities);
    const active = isActiveThreadStatus(detail.thread.status);
    markThreadActive(detail.thread.id, active);
    lastPrompt.current = previousPrompt;
    setFailedPrompt(nextFailedPrompt);
    if (availableModels.some((entry) => entry.model === detail.thread.model)) {
      setSelectedModel(detail.thread.model);
      localStorage.setItem("rhzycode.selectedModel", detail.thread.model);
    }
  }

  async function loadThreadDetail(
    selectedThreadId: string,
    revision: number,
    availableModels: ModelOption[] = models,
    skipIfBootstrapComposerTouched = false,
  ): Promise<void> {
    openingThreadIdRef.current = selectedThreadId;
    setOpeningThreadId(selectedThreadId);
    try {
      followConversationRef.current = true;
      const detail = await window.rhzycode.openThread(selectedThreadId);
      if (revision !== navigationRevisionRef.current) return;
      if (skipIfBootstrapComposerTouched && bootstrapComposerTouchedRef.current) return;
      applyThreadDetail(detail, availableModels);
    } catch (error) {
      if (revision === navigationRevisionRef.current) {
        upsertActivity(`history-error-${Date.now()}`, "Thread unavailable", getErrorMessage(error), "error");
      }
    } finally {
      if (openingThreadIdRef.current === selectedThreadId) openingThreadIdRef.current = null;
      if (revision === navigationRevisionRef.current) setOpeningThreadId(null);
    }
  }

  async function connectAndLoad() {
    const initialBootstrap = !bootstrapCompleteRef.current;
    const initialNavigationRevision = navigationRevisionRef.current;
    const connection = window.rhzycode.connectAgent().then(
      (status) => {
        setAgentStatus(status);
        return { ok: true as const, status };
      },
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      const initialState = await Promise.all([
        window.rhzycode.getGatewayStatus(),
        window.rhzycode.getSyncStatus(),
        window.rhzycode.getSyncSnapshot(),
        window.rhzycode.getCredentialStatus(),
        window.rhzycode.getUpdateStatus(),
        window.rhzycode.getMobileAccessStatus(),
        window.rhzycode.getPersistenceStatus(),
        window.rhzycode.listProjects(),
      ]).catch((error) => {
        upsertActivity(`startup-state-error-${Date.now()}`, "Workspace state unavailable", getErrorMessage(error), "error");
        return null;
      });
      const [gateway, sync, snapshot, credentials, updates, mobileAccess, persistence, projects] = initialState || [
        emptyGateway,
        emptySync,
        { threads: [], approvals: [], userInputs: [] },
        emptyCredentials,
        emptyUpdates,
        emptyMobileAccess,
        emptyPersistence,
        [],
      ];
      setGatewayStatus(gateway);
      setSyncStatus(sync);
      setCredentialStatus(credentials);
      setUpdateStatus(updates);
      setMobileAccessStatus(mobileAccess);
      setPersistenceStatus(persistence);
      const forgottenProjects = storedForgottenProjects();
      const isForgottenProject = (path: string) =>
        forgottenProjects.some((entry) => isSameProjectPath(entry, path));
      const storedProjects = [...new Set([
        selectedProjectPathRef.current,
        ...storedRecentProjects(),
      ].filter((path) => path && !isForgottenProject(path)))];
      const rememberedStoredProjects = (await Promise.allSettled(
        storedProjects.map((path) => window.rhzycode.rememberProject(path)),
      )).flatMap((result) => result.status === "fulfilled" ? [result.value.path] : []);
      const synchronizedProjects = [
        ...projects.map((project) => project.path).filter((path) => !isForgottenProject(path)),
        ...rememberedStoredProjects.filter((path) => !projects.some((project) => isSameProjectPath(project.path, path))),
      ].slice(0, 50);
      recentProjectsRef.current = synchronizedProjects;
      setRecentProjects(synchronizedProjects);
      setApprovals(snapshot.approvals);
      setUserInputs(snapshot.userInputs || []);
      setActiveThreadIds(new Set(
        snapshot.threads.filter((thread) => isActiveThreadStatus(thread.status)).map((thread) => thread.id),
      ));
      const connectionResult = await connection;
      if (!connectionResult.ok) throw connectionResult.error;
      const status = connectionResult.status;
      const refreshedProjects = await window.rhzycode.listProjects();
      const connectedProjects = [
        ...refreshedProjects.map((project) => project.path).filter((path) => !isForgottenProject(path)),
        ...rememberedStoredProjects.filter((path) =>
          !refreshedProjects.some((project) => isSameProjectPath(project.path, path))),
      ].slice(0, 50);
      recentProjectsRef.current = connectedProjects;
      setRecentProjects(connectedProjects);
      const restoredProject = connectedProjects.find((path) => isSameProjectPath(path, selectedProjectPathRef.current))
        ? selectedProjectPathRef.current
        : connectedProjects[0] || "";
      const shouldRestoreWorkspace = navigationRevisionRef.current === initialNavigationRevision;
      const revision = shouldRestoreWorkspace
        ? ++navigationRevisionRef.current
        : navigationRevisionRef.current;
      if (shouldRestoreWorkspace) setWorkspaceProject(restoredProject);
      const [response, availableThreads] = await Promise.all([
        status.state === "connected"
          ? window.rhzycode.listModels().catch(() => ({ data: [] }))
          : Promise.resolve({ data: [] }),
        window.rhzycode.listThreads(),
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

      if (!shouldRestoreWorkspace || revision !== navigationRevisionRef.current) return;

      const preferredThreadId = restoredProject ? storedLastThread(restoredProject) : null;
      const projectThreads = availableThreads.filter((thread) => isSameProjectPath(thread.projectPath, restoredProject));
      const preferredThread = projectThreads.find((thread) => thread.id === preferredThreadId)
        || projectThreads[0];
      if (preferredThread) {
        await loadThreadDetail(preferredThread.id, revision, available, initialBootstrap);
      } else if (
        revision === navigationRevisionRef.current
        && !(initialBootstrap && bootstrapComposerTouchedRef.current)
      ) {
        resetConversation();
      }
    } catch (error) {
      setAgentStatus({ state: "error", error: getErrorMessage(error) });
    } finally {
      if (initialBootstrap) bootstrapCompleteRef.current = true;
    }
  }

  async function loadThreads(): Promise<void> {
    setThreads(await window.rhzycode.listThreads());
  }

  async function chooseProject(): Promise<string | null> {
    const navigationRevision = navigationRevisionRef.current;
    const path = await window.rhzycode.chooseProject();
    if (!path) return null;
    if (navigationRevision !== navigationRevisionRef.current) return path;
    await selectProject(path);
    return path;
  }

  async function selectProject(path: string): Promise<void> {
    const revision = ++navigationRevisionRef.current;
    cacheCurrentThreadView();
    saveComposerDraft();
    setWorkspaceProject(path);
    rememberProject(path);
    resetConversation();
    followConversationRef.current = true;
    try {
      const availableThreads = await window.rhzycode.listThreads();
      if (revision !== navigationRevisionRef.current) return;
      setThreads(availableThreads);
      const preferredThreadId = storedLastThread(path);
      const projectThreads = availableThreads.filter((thread) => isSameProjectPath(thread.projectPath, path));
      const preferredThread = projectThreads.find((thread) => thread.id === preferredThreadId)
        || projectThreads[0];
      if (preferredThread) await loadThreadDetail(preferredThread.id, revision);
    } catch (error) {
      if (revision === navigationRevisionRef.current) {
        upsertActivity(`history-error-${Date.now()}`, "History unavailable", getErrorMessage(error), "error");
      }
    }
  }

  function rememberProject(path: string) {
    if (isSameProjectPath(selectedProjectPathRef.current, path)) {
      localStorage.setItem("rhzycode.lastProject", path);
    }
    setRecentProjects((current) => {
      const next = current.some((entry) => isSameProjectPath(entry, path)) ? current : [...current, path].slice(0, 50);
      localStorage.setItem("rhzycode.recentProjects", JSON.stringify(next));
      return next;
    });
    setForgottenProjectPaths((current) => {
      const next = current.filter((entry) => !isSameProjectPath(entry, path));
      if (next.length === current.length) return current;
      localStorage.setItem("rhzycode.forgottenProjects", JSON.stringify(next));
      return next;
    });
    void window.rhzycode.rememberProject(path).catch(() => undefined);
  }

  async function removeProject(path: string): Promise<void> {
    const name = basename(path);
    if (!window.confirm(
      `Permanently delete "${name}" from RHZYCODE and delete all of its conversations from this computer?\n\nThe project source files in ${path} will not be deleted. This cannot be undone.`,
    )) return;

    closeThreadActions();
    try {
      const result = await window.rhzycode.deleteProject(path);
      setThreads((current) => current.filter((thread) => !isSameProjectPath(thread.projectPath, path)));
      for (const key of composerDraftsRef.current.keys()) {
        if (isSameProjectPath(key.split("\0", 1)[0] || "", path)) composerDraftsRef.current.delete(key);
      }
      try {
        const lastThreads = JSON.parse(localStorage.getItem("rhzycode.lastThreads") || "{}") as Record<string, unknown>;
        const remaining = Object.fromEntries(
          Object.entries(lastThreads).filter(([project]) => !isSameProjectPath(project, path)),
        );
        localStorage.setItem("rhzycode.lastThreads", JSON.stringify(remaining));
      } catch {
        localStorage.removeItem("rhzycode.lastThreads");
      }
      setForgottenProjectPaths((current) => {
        const next = current.some((entry) => isSameProjectPath(entry, path))
          ? current
          : [...current, path].slice(-50);
        localStorage.setItem("rhzycode.forgottenProjects", JSON.stringify(next));
        return next;
      });
      setRecentProjects((current) => {
        const next = current.filter((entry) => !isSameProjectPath(entry, path));
        localStorage.setItem("rhzycode.recentProjects", JSON.stringify(next));
        return next;
      });
      setCollapsedProjectPaths((current) => {
        const next = new Set([...current].filter((entry) => !isSameProjectPath(entry, path)));
        storeCollapsedProjectPaths(next);
        return next;
      });

      if (isSameProjectPath(selectedProjectPathRef.current, path)) {
        localStorage.removeItem("rhzycode.lastProject");
        const fallback = projectGroups.find((group) => !isSameProjectPath(group.path, path));
        if (fallback) void selectProject(fallback.path);
        else {
          navigationRevisionRef.current += 1;
          setWorkspaceProject("");
          resetConversation();
        }
      }
      upsertActivity(
        `project-delete-${Date.now()}`,
        "Project deleted",
        `${result.deletedConversationCount} conversation${result.deletedConversationCount === 1 ? "" : "s"} permanently deleted. Project source files were kept.`,
        "done",
      );
    } catch (error) {
      const message = getErrorMessage(error);
      upsertActivity(`project-remove-error-${Date.now()}`, "Project deletion failed", message, "error");
      window.alert(`Project deletion failed: ${message}`);
    }
  }

  async function restoreConversationBackup(): Promise<void> {
    closeThreadActions();
    setImporting(true);
    setImportStatus(null);
    try {
      const result = await window.rhzycode.restoreProjectConversations();
      if (!result) return;
      for (const restoredProjectPath of result.projectPaths) rememberProject(restoredProjectPath);
      await loadThreads();
      const detail = `${result.importedCount} restored, ${result.skippedCount} already present`;
      upsertActivity(`conversation-restore-${Date.now()}`, "Conversation restore complete", detail, "done");
      setImportStatus(detail);
    } catch (error) {
      const message = getErrorMessage(error);
      upsertActivity(`conversation-restore-error-${Date.now()}`, "Conversation restore failed", message, "error");
      setImportStatus(message);
    } finally {
      setImporting(false);
    }
  }

  async function openExportDialog(): Promise<void> {
    closeThreadActions();
    setDialogView("export");
    setExportItems([]);
    setSelectedExportThreadIds(new Set());
    setExportStatus(null);
    setExportLoading(true);
    try {
      setExportItems(await window.rhzycode.listExportConversations());
    } catch (error) {
      setExportStatus(getErrorMessage(error));
    } finally {
      setExportLoading(false);
    }
  }

  function toggleExportProject(group: ExportProjectGroup): void {
    setSelectedExportThreadIds((current) => {
      const next = new Set(current);
      const everySelected = group.conversations.every((conversation) => next.has(conversation.threadId));
      for (const conversation of group.conversations) {
        if (everySelected) next.delete(conversation.threadId);
        else next.add(conversation.threadId);
      }
      return next;
    });
    setExportStatus(null);
  }

  function toggleExportConversation(threadId: string): void {
    setSelectedExportThreadIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
    setExportStatus(null);
  }

  async function exportSelectedConversations(): Promise<void> {
    if (selectedExportThreadIds.size === 0) return;
    setExporting(true);
    setExportStatus(null);
    try {
      const result = await window.rhzycode.exportConversations([...selectedExportThreadIds]);
      if (!result) return;
      const detail = `${result.conversationCount} conversation${result.conversationCount === 1 ? "" : "s"} exported`;
      upsertActivity(`conversation-export-${Date.now()}`, "Conversation export complete", `${detail} to ${result.filePath}`, "done");
      setExportStatus(detail);
    } catch (error) {
      const message = getErrorMessage(error);
      upsertActivity(`conversation-export-error-${Date.now()}`, "Conversation export failed", message, "error");
      setExportStatus(message);
    } finally {
      setExporting(false);
    }
  }

  function toggleProjectGroup(path: string) {
    closeThreadActions();
    setCollapsedProjectPaths((current) => {
      const next = new Set(current);
      const storedPath = [...next].find((entry) => isSameProjectPath(entry, path));
      if (storedPath) next.delete(storedPath);
      else next.add(path);
      storeCollapsedProjectPaths(next);
      return next;
    });
  }

  function startNewTask() {
    navigationRevisionRef.current += 1;
    closeThreadActions();
    cacheCurrentThreadView();
    saveComposerDraft();
    composerDraftsRef.current.delete(composerDraftKey(selectedProjectPathRef.current, null));
    resetConversation();
    focusComposer();
  }

  function startNewTaskInProject(path: string) {
    navigationRevisionRef.current += 1;
    closeThreadActions();
    cacheCurrentThreadView();
    saveComposerDraft();
    setWorkspaceProject(path);
    rememberProject(path);
    composerDraftsRef.current.delete(composerDraftKey(path, null));
    resetConversation();
    focusComposer();
  }

  function changeSelectedModel(nextModel: string) {
    selectedModelRef.current = nextModel;
    setSelectedModel(nextModel);
    localStorage.setItem("rhzycode.selectedModel", nextModel);
    const selectedThread = selectedThreadIdRef.current;
    if (!selectedThread) return;
    void window.rhzycode.setThreadModel(selectedThread, nextModel)
      .then((updated) => {
        setThreads((current) => current.map((thread) => thread.id === updated.id ? updated : thread));
      })
      .catch((error) => {
        upsertActivity(`model-error-${Date.now()}`, "Model selection unavailable", getErrorMessage(error), "error");
      });
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
    if (selected.length > 0) markBootstrapComposerTouched();
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

  function composerDragEnter(event: ReactDragEvent<HTMLDivElement>): void {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    composerDragDepthRef.current += 1;
    setComposerDragActive(true);
  }

  function composerDragOver(event: ReactDragEvent<HTMLDivElement>): void {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function composerDragLeave(event: ReactDragEvent<HTMLDivElement>): void {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current === 0) setComposerDragActive(false);
  }

  async function dropComposerFiles(event: ReactDragEvent<HTMLDivElement>): Promise<void> {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = 0;
    setComposerDragActive(false);

    const droppedFiles = Array.from(event.dataTransfer.files);
    if (droppedFiles.length === 0) return;
    const availableSlots = Math.max(0, 20 - attachments.length);
    if (availableSlots === 0) {
      upsertActivity(`attachment-error-${Date.now()}`, "Attachment limit reached", "A task can include at most 20 attachments.", "error");
      return;
    }

    try {
      const selected = await window.rhzycode.resolveDroppedFiles(droppedFiles.slice(0, availableSlots));
      appendAttachments(selected);
      if (selected.length === 0) {
        upsertActivity(`attachment-error-${Date.now()}`, "Attachment unavailable", "The drop did not contain a readable local file.", "error");
      } else if (droppedFiles.length > availableSlots) {
        upsertActivity(`attachment-error-${Date.now()}`, "Attachment limit reached", "Only the first available attachments were added.", "error");
      }
    } catch (error) {
      upsertActivity(`attachment-error-${Date.now()}`, "Attachment unavailable", getErrorMessage(error), "error");
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
      focusComposer();
      return;
    }
    const confirmed = window.confirm(`Permanently delete "${thread?.title || "this thread"}" and its data from this computer?\n\nThis cannot be undone.`);
    closeThreadActions();
    focusComposer();
    if (!confirmed) return;
    const deletingSelectedThread = selectedThreadId === selectedThreadIdRef.current;
    pendingThreadDeletionsRef.current.add(selectedThreadId);
    leaveRemovedThread(selectedThreadId);
    if (!deletingSelectedThread) focusComposer();
    try {
      await window.rhzycode.deleteThread(selectedThreadId);
      threadViewCacheRef.current.delete(selectedThreadId);
      markThreadActive(selectedThreadId, false);
      setThreads((current) => current.filter((entry) => entry.id !== selectedThreadId));
      leaveRemovedThread(selectedThreadId);
    } catch (error) {
      const message = getErrorMessage(error);
      upsertActivity(`delete-error-${Date.now()}`, "Delete failed", message, "error");
      window.alert(`Delete failed: ${message}`);
    } finally {
      pendingThreadDeletionsRef.current.delete(selectedThreadId);
      if (pendingThreadDeletionsRef.current.size === 0) focusComposer();
    }
  }

  async function archiveSelectedThread(selectedThreadId: string) {
    const thread = threads.find((entry) => entry.id === selectedThreadId);
    if (thread && isActiveThreadStatus(thread.status)) {
      closeThreadActions();
      window.alert("Stop the running task before archiving it.");
      return;
    }
    closeThreadActions();
    if (selectedThreadId === selectedThreadIdRef.current) startNewTask();
    try {
      await window.rhzycode.archiveThread(selectedThreadId);
      threadViewCacheRef.current.delete(selectedThreadId);
      setThreads((current) => current.filter((entry) => entry.id !== selectedThreadId));
      if (selectedThreadId === selectedThreadIdRef.current) startNewTask();
    } catch (error) {
      upsertActivity(`archive-error-${Date.now()}`, "Archive failed", getErrorMessage(error), "error");
    }
  }

  function closeThreadActions() {
    setThreadActionsId(null);
    setThreadMenuPosition(null);
  }

  function toggleThreadActions(event: ReactMouseEvent<HTMLButtonElement>, selectedThreadId: string) {
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
    if (
      selectedThreadIdRef.current === selectedThreadId
      && (loadedThreadIdRef.current === selectedThreadId || openingThreadIdRef.current === selectedThreadId)
    ) return;
    const revision = ++navigationRevisionRef.current;
    const selectedThread = threads.find((thread) => thread.id === selectedThreadId);
    const targetProjectPath = selectedThread?.projectPath || selectedProjectPathRef.current;
    if (selectedThreadIdRef.current !== selectedThreadId) {
      cacheCurrentThreadView();
      saveComposerDraft();
      restoreComposerDraft(targetProjectPath, selectedThreadId);
    }
    if (targetProjectPath) setWorkspaceProject(targetProjectPath);
    setWorkspaceThread(selectedThreadId);
    focusComposer();
    const cached = threadViewCacheRef.current.get(selectedThreadId);
    if (cached) {
      rememberThreadView(selectedThreadId, cached);
      loadedThreadIdRef.current = selectedThreadId;
      setMessages(cached.messages);
      setActivities(cached.activities);
      setFailedPrompt(cached.failedPrompt);
      lastPrompt.current = cached.lastPrompt;
    } else {
      loadedThreadIdRef.current = null;
      setMessages([]);
      setActivities([]);
      setFailedPrompt(null);
      lastPrompt.current = "";
    }
    await loadThreadDetail(selectedThreadId, revision);
  }

  async function executeComposerCommand(command: ParsedCodexComposerCommand): Promise<string | null> {
    const prompt = codexComposerCommandPrompt(command);
    if (prompt) return prompt;
    if (!command.known) {
      window.alert(`Unknown Codex command: /${command.name}`);
      return null;
    }
    if (attachments.length) {
      window.alert("Remove attachments before running a Codex command.");
      return null;
    }

    if (command.name === "new" || command.name === "clear") {
      startNewTask();
      return null;
    }
    if (command.name === "resume") {
      setComposer("");
      const target = command.args
        ? threads.find((thread) => thread.id === command.args)
          || threads.find((thread) => thread.title.toLocaleLowerCase() === command.args.toLocaleLowerCase())
        : null;
      if (target) await openThread(target.id);
      else {
        setThreadSearch(command.args);
        window.requestAnimationFrame(() => threadSearchRef.current?.focus());
      }
      return null;
    }
    if (command.name === "model") {
      setComposer("");
      if (command.args) {
        const target = models.find((model) => model.model === command.args)
          || models.find((model) => model.displayName.toLocaleLowerCase().includes(command.args.toLocaleLowerCase()));
        if (target) changeSelectedModel(target.model);
        else window.alert(`Model not found: ${command.args}`);
      } else {
        window.requestAnimationFrame(() => {
          modelSelectRef.current?.focus();
          modelSelectRef.current?.showPicker?.();
        });
      }
      return null;
    }
    if (command.name === "compact") {
      if (!threadId) {
        window.alert("Open a conversation before running /compact.");
        return null;
      }
      setComposer("");
      setSubmittingTurn(true);
      try {
        await window.rhzycode.compactThread(threadId);
        upsertActivity(`compact-${Date.now()}`, "Conversation compacted", "Context was summarized successfully.", "done");
      } catch (error) {
        window.alert(`Conversation compaction failed: ${getErrorMessage(error)}`);
      } finally {
        setSubmittingTurn(false);
      }
      return null;
    }
    if (command.name === "status" || command.name === "permissions") {
      setComposer("");
      window.alert([
        `Model: ${selectedModelRef.current || "default"}`,
        `Sandbox: ${sandboxMode}`,
        `Approvals: ${approvalPolicy}`,
        `Project: ${selectedProjectPathRef.current || "none"}`,
        `Conversation: ${selectedThreadIdRef.current || "new"}`,
      ].join("\n"));
      return null;
    }
    if (command.name === "skills") {
      setComposer("");
      setDialogView("skills");
      return null;
    }
    if (command.name === "help") {
      setComposer("");
      window.alert("Supported commands: /new, /clear, /resume, /model, /compact, /status, /permissions, /review, /diff, /init, /skills");
      return null;
    }

    window.alert(`/${command.name} is recognized but is not available in RHZYCODE yet.`);
    return null;
  }

  async function sendTurn(retryText?: string) {
    const selectedAttachments = retryText == null ? attachments : [];
    let text = (retryText ?? composer).trim() || (selectedAttachments.length ? "Review the attached files." : "");
    const command = retryText == null ? parseCodexComposerCommand(text) : null;
    if (command) {
      const commandPrompt = await executeComposerCommand(command);
      if (!commandPrompt) return;
      text = commandPrompt;
    }
    if (!text || running || isOpeningSelectedThread || agentStatus.state !== "connected") return;
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
    const optimisticMessageId = `user-${Date.now()}`;
    setMessages((current) => [
      ...current,
      {
        id: optimisticMessageId,
        role: "user",
        content: text,
        images: selectedAttachments
          .filter((attachment) => attachment.kind === "image")
          .map((attachment) => ({ path: attachment.path, name: attachment.name })),
        files: selectedAttachments
          .filter((attachment) => attachment.kind === "file")
          .map((attachment) => ({
            id: `local-${attachment.path}`,
            path: attachment.path,
            name: attachment.name,
            size: attachment.size,
            source: "upload" as const,
          })),
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
          loadedThreadIdRef.current = activeThreadId;
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
      const result = await window.rhzycode.startTurn({
        threadId: activeThreadId,
        text,
        ...(submissionModel ? { model: submissionModel } : {}),
        approvalPolicy,
        sandboxMode,
        ...(reasoningEfforts.length ? { reasoningEffort } : {}),
        attachments: selectedAttachments,
      });
      if (result.files?.length) {
        setMessages((current) => current.map((message) => message.id === optimisticMessageId
          ? {
              ...message,
              ...(result.files?.some(isImageFile) ? { images: undefined } : {}),
              files: result.files,
            }
          : message));
      }
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

  async function configureLlmProvider(input: LlmProviderConfigurationInput) {
    try {
      if (typeof window.rhzycode.configureLlmProvider !== "function") {
        throw new Error("The desktop bridge is out of date. Fully quit and reopen RHZYCODE, then save again.");
      }
      const result = await window.rhzycode.configureLlmProvider(input);
      setCredentialStatus(result.credentials);
      setGatewayStatus(result.gateway);
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
    const eventTurnId = typeof params.turnId === "string"
      ? params.turnId
      : typeof (params.turn as Record<string, unknown> | undefined)?.id === "string"
        ? String((params.turn as Record<string, unknown>).id)
        : null;
    const eventItemId = (itemId: unknown, fallback: string) =>
      turnScopedItemId(eventTurnId, itemId || fallback);
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
      const messageId = eventItemId(params.itemId, `assistant-${eventThreadId || "current"}`);
      appendMessageDelta(eventThreadId!, messageId, delta);
      return;
    }

    if (method === "turn/completed") {
      flushPendingStreamingUpdates();
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
      appendActivityDelta(
        eventThreadId!,
        eventItemId(params.itemId, "command-output"),
        "Command output",
        String(params.delta || ""),
        "running",
      );
    }

    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      appendActivityDelta(
        eventThreadId!,
        eventItemId(params.itemId, "reasoning"),
        "Analysis",
        String(params.delta || ""),
        "running",
      );
    }

    if (method === "item/fileChange/patchUpdated") {
      upsertActivity(
        eventItemId(params.itemId, "file-change"),
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
      const itemId = eventItemId(item.id, `${method}-${Date.now()}`);
      const itemType = String(item.type || "activity");
      if (itemType === "agentMessage") {
        if (method === "item/completed") {
          flushPendingStreamingUpdates();
          setMessages((current) => completeAssistantMessage(current, itemId, String(item.text || "")));
        }
        return;
      }
      if (method === "item/completed" && itemType === "imageGeneration") {
        const imagePath = String(item.savedPath || "");
        if (imagePath) {
          const incoming: ChatMessage = {
            id: itemId,
            role: "assistant",
            content: "",
            images: [{
              path: imagePath,
              name: String(item.name || basename(imagePath) || "generated-image"),
              generated: true,
            }],
          };
          setMessages((current) => current.some((message) => message.id === itemId)
            ? current.map((message) => message.id === itemId ? incoming : message)
            : [...current, incoming]);
        } else {
          upsertActivity(itemId, "Generated image", "The generated image could not be loaded.", "error");
        }
        return;
      }
      if (itemType === "imageGeneration") return;
      if (method === "item/completed" && itemType === "artifact") {
        const files = Array.isArray(item.files)
          ? item.files.flatMap((value) => {
              const file = (value || {}) as Record<string, unknown>;
              if (!file.id || !file.name || !file.path) return [];
              return [{
                id: String(file.id),
                name: String(file.name),
                path: String(file.path),
                size: Number(file.size || 0),
                mimeType: file.mimeType ? String(file.mimeType) : undefined,
                source: "generated" as const,
              }];
            })
          : [];
        if (files.length) {
          const incoming: ChatMessage = { id: itemId, role: "assistant", content: "", files };
          setMessages((current) => current.some((message) => message.id === itemId)
            ? current.map((message) => message.id === itemId ? incoming : message)
            : [...current, incoming]);
        }
        return;
      }
      if (method === "item/completed" && itemType === "userMessage") {
        const incoming = userMessageFromNotification(itemId, item);
        setMessages((current) => {
          const exactIndex = current.findIndex((message) => message.id === itemId);
          if (exactIndex !== -1) {
            return current.map((message, index) => index === exactIndex
              ? {
                  ...incoming,
                  images: (incoming.files || message.files)?.some(isImageFile)
                    ? undefined
                    : incoming.images || message.images,
                  files: incoming.files || message.files,
                }
              : message);
          }
          const reversedIndex = [...current].reverse().findIndex((message) => (
            message.role === "user" && message.content.trim() === incoming.content.trim()
          ));
          const optimisticIndex = reversedIndex === -1 ? -1 : current.length - reversedIndex - 1;
          if (optimisticIndex !== -1) {
            return current.map((message, index) => index === optimisticIndex
              ? {
                  ...message,
                  images: message.files?.some(isImageFile) ? undefined : incoming.images,
                  files: incoming.files || message.files,
                }
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
      setThreads((current) => {
        const existingIndex = current.findIndex((thread) => thread.id === event.thread.id);
        if (existingIndex === -1) return [event.thread, ...current];
        return current.map((thread, index) => index === existingIndex ? event.thread : thread);
      });
    }
    if (event.type === "thread.removed") {
      threadViewCacheRef.current.delete(event.threadId);
      markThreadActive(event.threadId, false);
      setThreads((current) => current.filter((thread) => thread.id !== event.threadId));
      leaveRemovedThread(event.threadId);
    }
    if (event.type === "approval.requested") {
      setApprovals((current) => [
        event.approval,
        ...current.filter((approval) => approval.id !== event.approval.id),
      ]);
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
    flushPendingStreamingUpdates();
    setActivities((current) => {
      const entry = { id, label, detail, state };
      return current.some((value) => value.id === id)
        ? current.map((value) => (value.id === id ? entry : value))
        : [entry, ...current].slice(0, 30);
    });
  }

  return (
    <div className={`app-shell ${rightPanelOpen ? "with-panel" : ""}`} data-task-accent={taskActivity.accent}>
      {taskToast && (
        <div className={`task-toast ${taskToast.tone}`} role="status" aria-live="polite">
          <span className="task-toast-dot" aria-hidden="true" />
          <span>{taskToast.message}</span>
          <button
            type="button"
            className="task-toast-close"
            title="Dismiss"
            aria-label="Dismiss notification"
            onClick={() => setTaskToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <nav className="app-rail" aria-label="Primary navigation">
        <button
          className={`rail-brand ${primaryView === "workspace" ? "active" : ""}`}
          title="Workspace"
          aria-label="Workspace"
          aria-current={primaryView === "workspace" ? "page" : undefined}
          onClick={() => { setDialogView(null); setPrimaryView("workspace"); }}
        >
          <House size={21} />
          <span className="rail-label">工作台</span>
        </button>
        <div className="rail-actions">
          <button
            className={`${rightPanelOpen ? "panel-open" : ""} ${approvals.length + userInputs.length > 0 ? "attention" : ""}`}
            title={approvals.length + userInputs.length > 0 ? `${approvals.length + userInputs.length} request${approvals.length + userInputs.length === 1 ? "" : "s"} need attention` : "Activity"}
            aria-label="Activity"
            aria-pressed={rightPanelOpen}
            onClick={() => setRightPanelOpen((value) => !value)}
          >
            <Activity className={running ? "activity-wave-running" : ""} size={20} />
            <span className="rail-label">活动</span>
            {approvals.length + userInputs.length > 0 && <span className="rail-badge">{Math.min(approvals.length + userInputs.length, 99)}</span>}
          </button>
          <button
            className={dialogView === "transfer" || dialogView === "export" ? "active" : ""}
            title="Import or export conversations"
            aria-label="Import or export conversations"
            onClick={() => { setImportStatus(null); setExportStatus(null); setDialogView("transfer"); }}
          >
            <ArrowUpDown size={19} />
            <span className="rail-label">传输</span>
          </button>
          <button
            className={primaryView === "terminal" ? "active" : ""}
            title="Terminal"
            aria-label="Terminal"
            aria-current={primaryView === "terminal" ? "page" : undefined}
            onClick={() => { setDialogView(null); setPrimaryView("terminal"); }}
          >
            <TerminalSquare size={19} />
            <span className="rail-label">终端</span>
          </button>
          <button className={dialogView === "skills" ? "active" : ""} title="Skills" aria-label="Skills" onClick={() => setDialogView("skills")}>
            <Puzzle size={19} />
            <span className="rail-label">技能</span>
          </button>
        </div>
        <div className="rail-footer">
          <button className={dialogView === "settings" ? "active" : ""} title="Settings" aria-label="Settings" onClick={() => setDialogView("settings")}>
            <Settings size={19} />
            <span className="rail-label">设置</span>
          </button>
        </div>
      </nav>
      <aside className="sidebar">
        <div className="section-heading">
          <span className="section-title">Projects</span>
          <div>
            <button
              className="icon-button compact"
              title="Open project folder"
              aria-label="Open project folder"
              onClick={() => void chooseProject()}
            >
              <FolderOpen size={15} />
            </button>
          </div>
        </div>
        <label className="thread-search">
          <Search size={13} />
          <input
            ref={threadSearchRef}
            value={threadSearch}
            onChange={(event) => setThreadSearch(event.target.value)}
            placeholder="Search projects and tasks"
            aria-label="Search projects and tasks"
          />
          {threadSearch && <button title="Clear search" onClick={() => setThreadSearch("")}><X size={12} /></button>}
        </label>
        <div className="project-thread-list">
          {projectGroups.length > 0 ? projectGroups.map((group) => {
            const collapsed = [...collapsedProjectPaths].some((path) => isSameProjectPath(path, group.path)) && !threadSearch.trim();
            const contentId = `project-threads-${encodeURIComponent(group.key)}`;
            return (
              <section className={`project-group ${isSameProjectPath(group.path, projectPath) ? "selected" : ""}`} key={group.key}>
                <div className="project-group-header">
                  <button
                    className="project-group-main"
                    aria-label={`${collapsed ? "Expand" : "Collapse"} project ${group.name} tasks ${group.path}`}
                    aria-controls={contentId}
                    aria-expanded={!collapsed}
                    title={group.path}
                    onClick={() => toggleProjectGroup(group.path)}
                  >
                    {collapsed ? <ChevronRight className="project-group-chevron" size={14} /> : <ChevronDown className="project-group-chevron" size={14} />}
                    <span>
                      <strong>{group.name}</strong>
                    </span>
                  </button>
                  <div className="project-group-actions">
                    <button
                      className="project-action project-remove-toggle"
                      aria-label={`Permanently delete project ${group.name}`}
                      title={`Permanently delete ${group.name} conversations`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void removeProject(group.path);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                    <button
                      className="project-action project-new-task"
                      aria-label={`New task in project ${group.name}`}
                      title={`New task in ${group.name}`}
                      onClick={() => startNewTaskInProject(group.path)}
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                </div>
                {!collapsed && (
                  <div className="project-group-threads" id={contentId}>
                    {group.threads.length > 0 ? group.threads.map((thread) => (
                      <div className={`thread-row-wrap ${thread.id === threadId ? "active" : ""}`} key={thread.id}>
                        {renamingThreadId === thread.id ? (
                          <div className="thread-rename">
                            <input aria-label={`Rename ${thread.title}`} value={renameValue} maxLength={200} autoFocus onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submitRename(thread.id); if (event.key === "Escape") setRenamingThreadId(null); }} />
                            <button title="Save name" disabled={!renameValue.trim()} onClick={() => void submitRename(thread.id)}><Check size={12} /></button>
                            <button title="Cancel rename" onClick={() => setRenamingThreadId(null)}><X size={12} /></button>
                          </div>
                        ) : (
                          <button className="thread-row" title={`Model: ${thread.model}`} onClick={() => void openThread(thread.id)}>
                            <span className={`thread-state ${thread.status}`} />
                            <span><strong>{thread.title}</strong></span>
                          </button>
                        )}
                        {renamingThreadId !== thread.id && (
                          <button className="thread-actions-toggle" title={`Thread actions for ${thread.title}`} aria-label={`Thread actions for ${thread.title}`} aria-haspopup="menu" aria-expanded={threadActionsId === thread.id} onMouseDown={(event) => event.preventDefault()} onClick={(event) => toggleThreadActions(event, thread.id)}><MoreHorizontal size={14} /></button>
                        )}
                        {threadActionsId === thread.id && threadMenuPosition && (
                          <div className="thread-actions-menu" role="menu" style={threadMenuPosition}>
                            <button role="menuitem" onClick={() => beginRename(thread)}><Pencil size={13} /> Rename task</button>
                            <button role="menuitem" onClick={() => void archiveSelectedThread(thread.id)}><Archive size={13} /> Archive task</button>
                            <button role="menuitem" className="danger" onMouseDown={(event) => event.preventDefault()} onClick={() => void permanentlyDeleteThread(thread.id)}><Trash2 size={13} /> Delete task permanently</button>
                          </div>
                        )}
                      </div>
                    )) : <div className="project-group-empty">No tasks</div>}
                  </div>
                )}
              </section>
            );
          }) : <div className="sidebar-empty">{threadSearch ? "No matching projects or tasks" : "Open a project folder to begin"}</div>}
        </div>

      </aside>

      {primaryView === "terminal" ? (
        <TerminalWorkspace cwd={projectPath} onChooseProject={chooseProject} />
      ) : (
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
              <select ref={modelSelectRef} value={selectedModel} onChange={(event) => changeSelectedModel(event.target.value)} disabled={!models.length} aria-label="Model for next turn">
                {!models.length && <option value="">Loading models</option>}
                {modelGroups.map((group) => (
                  <optgroup key={group.key} label={group.source}>
                    {group.models.map((model) => <option key={model.id} value={model.model}>{model.sourceModelName}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
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
          {isOpeningSelectedThread && messages.length > 0 && (
            <div className="conversation-refresh" role="progressbar" aria-label="Refreshing conversation" />
          )}
          {messages.length === 0 && isOpeningSelectedThread ? (
            <div className="conversation-loading" role="status" aria-label="Loading conversation">
              <span className="conversation-loading-line wide" />
              <span className="conversation-loading-line medium" />
              <span className="conversation-loading-line short" />
              <span className="conversation-loading-line assistant" />
            </div>
          ) : messages.length === 0 ? (
            <div className="empty-thread">
              <div className="empty-icon"><Bot size={28} /></div>
              <h1>{threadId ? "No messages yet" : projectPath ? "Start a new task" : "Select a project"}</h1>
              <p>{projectPath ? activeModel?.displayName || "Agent ready" : "Connect a local repository to begin"}</p>
            </div>
          ) : (
            <div className="message-list">
              {messages.map((message) => (
                <ChatMessageRow key={message.id} message={message} onOpenImage={setPreviewImage} />
              ))}
            </div>
          )}
        </section>

        <div className="composer-wrap">
          <div
            className={`composer-box ${composerDragActive ? "drag-active" : ""}`}
            onDragEnter={composerDragEnter}
            onDragLeave={composerDragLeave}
            onDragOver={composerDragOver}
            onDrop={(event) => void dropComposerFiles(event)}
          >
            {composerDragActive && <div className="composer-drop-overlay" aria-hidden="true"><Upload size={25} /></div>}
            {attachments.length > 0 && (
              <div className="attachment-list">
                {attachments.map((attachment) => (
                  <div className={`attachment-chip ${attachment.kind}`} key={attachment.path} title={attachment.path}>
                    {attachment.kind === "image" ? <ImageIcon size={14} /> : <File size={14} />}
                    <span><strong>{attachment.name}</strong><small>{formatFileSize(attachment.size)}</small></span>
                    <button title={`Remove ${attachment.name}`} onClick={() => {
                      markBootstrapComposerTouched();
                      setAttachments((current) => current.filter((entry) => entry.path !== attachment.path));
                    }}><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={composerRef}
              autoFocus
              value={composer}
              onChange={(event) => {
                markBootstrapComposerTouched();
                setComposer(event.target.value);
              }}
              onPaste={(event) => void pasteComposerImages(event)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter"
                  && !event.shiftKey
                  && !running
                  && !isOpeningSelectedThread
                  && agentStatus.state === "connected"
                ) {
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
                {reasoningEfforts.length > 0 && (
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
                )}
                {failedPrompt && !running && (
                  <button className="retry-turn" title="Retry last turn" onClick={() => void sendTurn(failedPrompt)}>
                    <RotateCcw size={14} /> Retry
                  </button>
                )}
              </div>
              {running ? (
                <button className="send-button stop" title="Stop" onClick={interruptTurn}><CircleStop size={17} /></button>
              ) : (
                <button
                  className="send-button"
                  title={agentStatus.state === "connecting"
                    ? "Starting agent"
                    : agentStatus.state === "error"
                      ? "Agent unavailable"
                      : isOpeningSelectedThread ? "Opening task" : "Send"}
                  onClick={() => void sendTurn()}
                  disabled={(!composer.trim() && attachments.length === 0) || isOpeningSelectedThread || agentStatus.state !== "connected"}
                >{agentStatus.state === "connecting"
                    ? <RefreshCw className="spinning" size={17} />
                    : <Send size={17} />}</button>
              )}
            </div>
          </div>
        </div>
      </main>
      )}

      {rightPanelOpen && (
        <aside className="activity-panel">
          <ActivityView
            activities={activities}
            approvals={approvals}
            resolvingApprovalId={resolvingApprovalId}
            onResolve={resolveApproval}
            userInputs={userInputs}
            resolvingUserInputId={resolvingUserInputId}
            onResolveUserInput={resolveUserInput}
          />
        </aside>
      )}
      {dialogView === "settings" && (
        <AppModal title="Settings" icon={<Settings size={18} />} className="settings-modal" onClose={() => setDialogView(null)}>
          <SettingsView
            themeMode={themeMode}
            themePreset={themePreset}
            status={credentialStatus}
            updateStatus={updateStatus}
            mobileAccessStatus={mobileAccessStatus}
            persistenceStatus={persistenceStatus}
            syncStatus={syncStatus}
            onConfigure={configureLlmProvider}
            onRemove={removeLlmProvider}
            onUpdateAction={runUpdateAction}
            onRotateAccessKey={rotateMobileAccessKey}
            onThemeModeChange={setThemeMode}
            onThemePresetChange={setThemePreset}
          />
        </AppModal>
      )}
      {dialogView === "skills" && (
        <AppModal title="Skills" icon={<Puzzle size={18} />} className="skills-modal" onClose={() => setDialogView(null)}>
          <SkillsView />
        </AppModal>
      )}
      {dialogView === "transfer" && (
        <AppModal title="Import / Export" icon={<ArrowUpDown size={18} />} className="transfer-modal" onClose={() => setDialogView(null)}>
          <div className="transfer-choices">
            <button disabled={importing} onClick={() => void restoreConversationBackup()}>
              <span>{importing ? <RefreshCw className="spinning" size={20} /> : <Upload size={20} />}</span>
              <strong>Import</strong>
              <small>Restore conversations from a backup file</small>
            </button>
            <button disabled={importing} onClick={() => void openExportDialog()}>
              <span><Download size={20} /></span>
              <strong>Export</strong>
              <small>Select projects and conversations to back up</small>
            </button>
          </div>
          {importStatus && <p className="transfer-status" role="status">{importStatus}</p>}
        </AppModal>
      )}
      {dialogView === "export" && (
        <AppModal title="Export conversations" icon={<Download size={18} />} className="export-modal" onClose={() => setDialogView(null)}>
          <div className="export-dialog-body">
            <div className="export-summary">
              <span>{exportItems.length} conversations</span>
              <strong>{selectedExportThreadIds.size} selected</strong>
            </div>
            <div className="export-tree" aria-busy={exportLoading}>
              {exportLoading && <div className="transfer-empty"><RefreshCw className="spinning" size={18} /></div>}
              {!exportLoading && exportProjectGroups.length === 0 && <div className="transfer-empty">No conversations available</div>}
              {!exportLoading && exportProjectGroups.map((group) => {
                const selectedCount = group.conversations.filter((conversation) => selectedExportThreadIds.has(conversation.threadId)).length;
                return (
                  <section className="export-project" key={group.key}>
                    <label className="export-project-row" title={group.path}>
                      <SelectionCheckbox
                        checked={selectedCount === group.conversations.length}
                        indeterminate={selectedCount > 0 && selectedCount < group.conversations.length}
                        onChange={() => toggleExportProject(group)}
                        ariaLabel={`Select all conversations in ${group.name}`}
                      />
                      <span><strong>{group.name}</strong><small>{group.conversations.length}</small></span>
                    </label>
                    <div className="export-conversations">
                      {group.conversations.map((conversation) => (
                        <label className="export-conversation-row" key={conversation.threadId}>
                          <input
                            type="checkbox"
                            checked={selectedExportThreadIds.has(conversation.threadId)}
                            onChange={() => toggleExportConversation(conversation.threadId)}
                          />
                          <span title={conversation.title}>{conversation.title}</span>
                          {conversation.archived && <small>Archived</small>}
                        </label>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
            {exportStatus && <p className="transfer-status" role="status">{exportStatus}</p>}
            <div className="modal-actions">
              <button className="secondary" onClick={() => setDialogView(null)}>Cancel</button>
              <button className="primary" disabled={exporting || selectedExportThreadIds.size === 0} onClick={() => void exportSelectedConversations()}>
                {exporting ? <RefreshCw className="spinning" size={15} /> : <Download size={15} />}
                {selectedExportThreadIds.size > 0 ? `Export ${selectedExportThreadIds.size}` : "Export"}
              </button>
            </div>
          </div>
        </AppModal>
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

function AppModal({
  title,
  icon,
  className,
  onClose,
  children,
}: {
  title: string;
  icon: ReactNode;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = `app-modal-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div className="app-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={`app-modal ${className || ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="app-modal-header">
          <div>{icon}<h2 id={titleId}>{title}</h2></div>
          <button className="icon-button compact" title={`Close ${title}`} aria-label={`Close ${title}`} onClick={onClose}><X size={16} /></button>
        </header>
        <div className="app-modal-body">{children}</div>
      </section>
    </div>
  );
}

function SelectionCheckbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={inputRef} type="checkbox" checked={checked} aria-label={ariaLabel} onChange={onChange} />;
}

const ChatMessageRow = memo(function ChatMessageRow({
  message,
  onOpenImage,
}: {
  message: ChatMessage;
  onOpenImage: (source: string) => void;
}) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-body">
        {message.streaming && <div className="message-author"><span className="streaming-label">Streaming</span></div>}
        <div className="message-content">
          {!!message.content && <div>{message.content}</div>}
          {!!(message.images?.length || message.files?.some(isImageFile)) && (
            <div className="message-images">
              {message.images?.map((image) => (
                <MessageImage key={image.path} image={image} onOpen={onOpenImage} />
              ))}
              {message.files?.filter(isImageFile).map((file) => (
                <MessageImage
                  key={file.id}
                  image={{ path: file.path!, name: file.name, generated: file.source === "generated" }}
                  onOpen={onOpenImage}
                />
              ))}
            </div>
          )}
          {!!message.files?.some((file) => !isImageFile(file)) && (
            <div className="message-files">
              {message.files.filter((file) => !isImageFile(file)).map((file) => (
                <MessageFile key={file.id} file={file} />
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
});

function MessageImage({
  image,
  onOpen,
}: {
  image: NonNullable<ChatMessage["images"]>[number];
  onOpen: (source: string) => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    let active = true;
    setSource(null);
    setPreviewSize(null);
    void window.rhzycode.readLocalImage(image.path)
      .then((value) => { if (active) setSource(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [image.path]);
  if (!source) return null;
  return (
    <div
      className={`message-image-wrap${image.generated ? " generated" : ""}${previewSize ? " ready" : ""}`}
      style={{
        width: previewSize?.width ?? 1,
        aspectRatio: previewSize ? `${previewSize.width} / ${previewSize.height}` : "1 / 1",
      }}
    >
      <button
        className="message-image"
        aria-label={`Open ${image.name}`}
        title={`Open ${image.name}`}
        onClick={() => onOpen(source)}
        onContextMenu={(event) => {
          event.preventDefault();
          void window.rhzycode.showImageContextMenu(image.path, image.name).catch(() => undefined);
        }}
      >
        <img
          src={source}
          alt={image.name}
          onLoad={(event) => setPreviewSize(fitImagePreviewSize(
            event.currentTarget.naturalWidth,
            event.currentTarget.naturalHeight,
          ))}
        />
      </button>
    </div>
  );
}

function MessageFile({ file }: {
  file: NonNullable<ChatMessage["files"]>[number];
}) {
  const open = () => file.path && window.rhzycode.openLocalFile(file.path).catch(() => undefined);
  const reveal = () => file.path && window.rhzycode.revealLocalFile(file.path).catch(() => undefined);
  const save = () => file.path && window.rhzycode.saveLocalFile(file.path, file.name).catch(() => undefined);
  return (
    <div className="message-file" title={file.path || file.name}>
      <button className="message-file-main" aria-label={`Open ${file.name}`} title={`Open ${file.name}`} disabled={!file.path} onClick={open}>
        <span className="message-file-icon"><File size={18} /></span>
        <span className="message-file-copy">
          <strong>{file.name}</strong>
          <small>{formatFileSize(file.size)}{file.source === "generated" ? " - Generated" : ""}</small>
        </span>
      </button>
      {file.path && (
        <button
          className="message-file-reveal"
          aria-label={file.source === "generated" ? `Save ${file.name}` : `Show ${file.name} in folder`}
          title={file.source === "generated" ? `Save ${file.name}` : `Show ${file.name} in folder`}
          onClick={file.source === "generated" ? save : reveal}
        >
          {file.source === "generated" ? <Download size={15} /> : <FolderOpen size={15} />}
        </button>
      )}
    </div>
  );
}

function isImageFile(
  file: NonNullable<ChatMessage["files"]>[number],
): boolean {
  return Boolean(file.path) && file.mimeType?.startsWith("image/") === true;
}

function userMessageFromNotification(id: string, item: Record<string, unknown>): ChatMessage {
  const contentItems = Array.isArray(item.content) ? item.content : [];
  const content = stripUserAttachmentMarkup(contentItems.flatMap((rawItem) => {
    const entry = (rawItem || {}) as Record<string, unknown>;
    return entry.type === "text" || entry.type === "input_text" ? [String(entry.text || "")] : [];
  }).filter(Boolean).join("\n"));
  const files = Array.isArray(item.files) ? item.files.flatMap((rawFile) => {
    const file = (rawFile || {}) as Record<string, unknown>;
    if (!file.id || !file.name || !file.path) return [];
    return [{
      id: String(file.id),
      name: String(file.name),
      path: String(file.path),
      size: Number(file.size || 0),
      mimeType: file.mimeType ? String(file.mimeType) : undefined,
      source: file.source === "generated" ? "generated" as const : "upload" as const,
    }];
  }) : [];
  const images = files.some(isImageFile) ? [] : contentItems.flatMap((rawItem) => {
    const entry = (rawItem || {}) as Record<string, unknown>;
    if (entry.type !== "image" && entry.type !== "localImage" && entry.type !== "input_image") return [];
    const imagePath = String(entry.path || entry.image_url || "");
    if (!imagePath || imagePath.startsWith("data:")) return [];
    return [{ path: imagePath, name: imagePath.split(/[\\/]/).at(-1) || "image" }];
  });
  return {
    id,
    role: "user",
    content,
    ...(images.length ? { images } : {}),
    ...(files.length ? { files } : {}),
  };
}

function stripUserAttachmentMarkup(value: string): string {
  const clean = value
    .replace(/<image\b[^>]*\bpath=(?:"[^"]*"|'[^']*')[^>]*>\s*<\/image>/gi, "")
    .replace(/<image\b[^>]*\bpath=(?:"[^"]*"|'[^']*')[^>]*>/gi, "")
    .replace(/<\/image>/gi, "")
    .trim();
  return clean.split("\n\nAttached files (use these absolute paths):\n", 1)[0] || clean;
}

function TerminalWorkspace({
  cwd,
  onChooseProject,
}: {
  cwd: string;
  onChooseProject: () => Promise<string | null>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const statusRef = useRef<TerminalStatus | null>(null);
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const terminal = new XtermTerminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 12,
      letterSpacing: 0,
      lineHeight: 1.2,
      scrollback: 5_000,
      theme: {
        background: "#0b111d",
        foreground: "#e5e8f2",
        cursor: "#a9b2c7",
        selectionBackground: "#655bd066",
        black: "#171e2e",
        red: "#e37b70",
        green: "#83bc91",
        yellow: "#d8b66b",
        blue: "#80a9cf",
        magenta: "#b89bd1",
        cyan: "#77b9b5",
        white: "#e5e8f2",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const fitTerminal = () => {
      try {
        fit.fit();
        const current = statusRef.current;
        if (current?.running) {
          void window.rhzycode.resizeTerminal(current.processId, terminal.cols, terminal.rows);
        }
      } catch {
        return;
      }
    };
    const resizeObserver = new ResizeObserver(fitTerminal);
    resizeObserver.observe(containerRef.current);
    requestAnimationFrame(fitTerminal);

    const dataDisposable = terminal.onData((data) => {
      const current = statusRef.current;
      if (current?.running) {
        void window.rhzycode.writeTerminal(current.processId, data).catch((error: unknown) => {
          terminal.writeln(`\r\n[write failed: ${getErrorMessage(error)}]`);
        });
      }
    });
    const unsubscribeStatus = window.rhzycode.onTerminalStatus((value) => {
      const previous = statusRef.current;
      statusRef.current = value;
      setStatus(value);
      if (previous?.running && value && !value.running) {
        terminal.writeln(`\r\n[process exited${value.exitCode == null ? "" : `: ${value.exitCode}`}]`);
      }
    });
    const unsubscribeOutput = window.rhzycode.onTerminalOutput((value) => {
      if (!statusRef.current || value.processId === statusRef.current.processId) {
        terminal.write(value.delta);
      }
    });
    void window.rhzycode.getTerminalStatus().then((value) => {
      statusRef.current = value;
      setStatus(value);
      if (value?.output) terminal.write(value.output);
    });

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unsubscribeStatus();
      unsubscribeOutput();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  async function start() {
    const selectedCwd = cwd || await onChooseProject();
    if (!selectedCwd || !terminalRef.current) return;
    setStarting(true);
    try {
      terminalRef.current.reset();
      fitRef.current?.fit();
      const next = await window.rhzycode.startTerminal({
        cwd: selectedCwd,
        cols: terminalRef.current.cols,
        rows: terminalRef.current.rows,
      });
      statusRef.current = next;
      setStatus(next);
      terminalRef.current.focus();
    } catch (error) {
      terminalRef.current.writeln(`[start failed: ${getErrorMessage(error)}]`);
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    if (!status?.running) return;
    try {
      await window.rhzycode.stopTerminal(status.processId);
    } catch (error) {
      terminalRef.current?.writeln(`\r\n[stop failed: ${getErrorMessage(error)}]`);
    }
  }

  return (
    <main className="terminal-workspace">
      <header className="workspace-header terminal-header">
        <div className="workspace-title">
          <TerminalSquare size={16} />
          <span>Terminal</span>
          <span className="branch-name">{status?.cwd || cwd || "No project"}</span>
        </div>
        <div className="terminal-actions">
          {status?.running ? (
            <button className="icon-button" title="Stop terminal" aria-label="Stop terminal" onClick={() => void stop()}><Square size={15} /></button>
          ) : status ? (
            <button className="icon-button" title="Start terminal" aria-label="Start terminal" disabled={starting} onClick={() => void start()}>
              {starting ? <RefreshCw className="spinning" size={15} /> : <Play size={15} />}
            </button>
          ) : null}
        </div>
      </header>
      <section className="terminal-surface">
        <div className="terminal-container" ref={containerRef} role="application" aria-label="Terminal session" />
        {!status && !starting && (
          <button className="terminal-start" onClick={() => void start()}>
            <Play size={16} /> {cwd ? "Start terminal" : "Select project"}
          </button>
        )}
        {status?.error && <div className="terminal-error" role="alert">{status.error}</div>}
      </section>
    </main>
  );
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

function SkillsView() {
  const [status, setStatus] = useState<SkillsStatus>(emptySkills);
  const [loading, setLoading] = useState(true);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [pendingSource, setPendingSource] = useState<SkillImportSource | "install" | null>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadSkills(forceReload = false) {
    setLoading(true);
    setError(null);
    try {
      setStatus(await window.rhzycode.getSkills(forceReload));
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSkills();
  }, []);

  async function installSkill() {
    setPendingSource("install");
    setNotice(null);
    setError(null);
    try {
      const result = await window.rhzycode.chooseAndInstallSkill();
      if (!result) return;
      setStatus(result.status);
      setNotice(`Installed ${result.installedName}.`);
    } catch (installError) {
      setError(getErrorMessage(installError));
    } finally {
      setPendingSource(null);
    }
  }

  async function importSkills(source: SkillImportSource) {
    setPendingSource(source);
    setNotice(null);
    setError(null);
    try {
      const result = await window.rhzycode.importSkills(source);
      setStatus(result.status);
      setNotice(
        `Imported ${result.importedCount}; skipped ${result.skippedCount}`
        + (result.failedCount > 0 ? `; failed ${result.failedCount}.` : "."),
      );
    } catch (importError) {
      setError(getErrorMessage(importError));
    } finally {
      setPendingSource(null);
    }
  }

  async function toggleSkill(skillPath: string, enabled: boolean) {
    setPendingPath(skillPath);
    setNotice(null);
    setError(null);
    try {
      setStatus(await window.rhzycode.setSkillEnabled(skillPath, enabled));
    } catch (toggleError) {
      setError(getErrorMessage(toggleError));
    } finally {
      setPendingPath(null);
    }
  }

  async function removeSkill(skillPath: string, displayName: string) {
    if (!window.confirm(`Delete ${displayName}?`)) return;
    setPendingPath(skillPath);
    setNotice(null);
    setError(null);
    try {
      setStatus(await window.rhzycode.removeSkill(skillPath));
      setNotice(`Deleted ${displayName}.`);
    } catch (removeError) {
      setError(getErrorMessage(removeError));
    } finally {
      setPendingPath(null);
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visibleSkills = status.skills.filter((skill) => !normalizedQuery || [
    skill.name,
    skill.displayName,
    skill.description,
    skill.shortDescription || "",
    skill.scope,
  ].some((value) => value.toLowerCase().includes(normalizedQuery)));
  const busy = loading || pendingSource !== null || pendingPath !== null;

  return (
    <div className="skills-view">
      <div className="skills-actions">
        <button className="skills-install" disabled={busy} onClick={() => void installSkill()}>
          {pendingSource === "install" ? <RefreshCw className="spinning" size={14} /> : <FolderOpen size={14} />}
          Install
        </button>
        {(["codex", "claude"] as const).map((source) => {
          const sourceStatus = status.sources[source];
          return (
            <button
              key={source}
              disabled={busy || !sourceStatus.available || sourceStatus.count === 0}
              onClick={() => void importSkills(source)}
              title={`Import user skills from ${source === "codex" ? "Codex" : "Claude"}`}
            >
              {pendingSource === source ? <RefreshCw className="spinning" size={13} /> : <Download size={13} />}
              {source === "codex" ? "Codex" : "Claude"} <span>{sourceStatus.count}</span>
            </button>
          );
        })}
      </div>
      <div className="skills-filter">
        <Search size={14} />
        <input aria-label="Search skills" placeholder="Search skills" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button disabled={busy} title="Refresh skills" aria-label="Refresh skills" onClick={() => void loadSkills(true)}>
          <RefreshCw className={loading ? "spinning" : ""} size={14} />
        </button>
      </div>
      <div className="skills-summary">
        <span>{visibleSkills.length} of {status.skills.length}</span>
        <span>{status.skills.filter((skill) => skill.enabled).length} enabled</span>
      </div>
      {notice && <p className="skills-notice">{notice}</p>}
      {error && <p className="gateway-error">{error}</p>}
      {status.errors.map((skillError) => (
        <p className="gateway-error" key={`${skillError.path}-${skillError.message}`} title={skillError.path}>{skillError.message}</p>
      ))}
      <div className="skill-list" aria-busy={loading}>
        {!loading && visibleSkills.length === 0 && (
          <div className="skills-empty"><Puzzle size={22} /><span>{query.trim() ? "No matching skills" : "No skills installed"}</span></div>
        )}
        {visibleSkills.map((skill) => {
          const pending = pendingPath === skill.path;
          const description = skill.shortDescription || skill.description;
          return (
            <div className={`skill-row ${skill.enabled ? "" : "disabled"}`} key={skill.path}>
              <div className="skill-row-heading">
                <div className="skill-title">
                  <strong title={skill.displayName}>{skill.displayName}</strong>
                  <span>{skill.scope}</span>
                </div>
                <div className="skill-row-actions">
                  <button
                    className={`skill-toggle ${skill.enabled ? "enabled" : ""}`}
                    role="switch"
                    aria-checked={skill.enabled}
                    aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.displayName}`}
                    title={`${skill.enabled ? "Disable" : "Enable"} skill`}
                    disabled={busy}
                    onClick={() => void toggleSkill(skill.path, !skill.enabled)}
                  ><span /></button>
                  {skill.canRemove && (
                    <button className="skill-remove" disabled={busy} title="Delete skill" aria-label={`Delete ${skill.displayName}`} onClick={() => void removeSkill(skill.path, skill.displayName)}>
                      {pending ? <RefreshCw className="spinning" size={13} /> : <Trash2 size={13} />}
                    </button>
                  )}
                </div>
              </div>
              <p>{description}</p>
              <small title={skill.path}>{skill.name}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SettingsView({
  themeMode,
  themePreset,
  status,
  updateStatus,
  mobileAccessStatus,
  persistenceStatus,
  syncStatus,
  onConfigure,
  onRemove,
  onUpdateAction,
  onRotateAccessKey,
  onThemeModeChange,
  onThemePresetChange,
}: {
  themeMode: ThemeMode;
  themePreset: ThemePreset;
  status: CredentialStatus;
  updateStatus: UpdateStatus;
  mobileAccessStatus: MobileAccessStatus;
  persistenceStatus: PersistenceStatus;
  syncStatus: SyncStatus;
  onConfigure: (input: LlmProviderConfigurationInput) => Promise<void>;
  onRemove: (providerId: string) => Promise<void>;
  onUpdateAction: (action: "check" | "download" | "install") => Promise<void>;
  onRotateAccessKey: () => Promise<void>;
  onThemeModeChange: (mode: ThemeMode) => void;
  onThemePresetChange: (preset: ThemePreset) => void;
}) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [providerEditor, setProviderEditor] = useState<LlmProviderConfigurationInput | null>(null);
  const [providerEditorError, setProviderEditorError] = useState<string | null>(null);
  const [savingProviderConfig, setSavingProviderConfig] = useState(false);
  async function copyValue(field: string, value: string) {
    try {
      await window.rhzycode.copyText(value);
      setCopiedField(field);
      window.setTimeout(() => setCopiedField((current) => current === field ? null : current), 1400);
    } catch {
      setCopiedField(null);
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
      <section className="settings-section appearance-settings">
        <div className="settings-heading">
          {themeMode === "dark" ? <Moon size={18} /> : <Sun size={18} />}
          <div><strong>Appearance</strong><small>{themeMode === "dark" ? "Night mode" : "Day mode"}</small></div>
        </div>
        <div className="appearance-row">
          <div><strong>Display mode</strong><small>Choose the interface brightness</small></div>
          <div className="theme-segmented" role="radiogroup" aria-label="Display mode">
            <button className={themeMode === "light" ? "active" : ""} role="radio" aria-checked={themeMode === "light"} onClick={() => onThemeModeChange("light")}><Sun size={14} /> Day</button>
            <button className={themeMode === "dark" ? "active" : ""} role="radio" aria-checked={themeMode === "dark"} onClick={() => onThemeModeChange("dark")}><Moon size={14} /> Night</button>
          </div>
        </div>
        <div className="appearance-row">
          <div><strong>Style preset</strong><small>Switch the visual language</small></div>
          <div className="theme-segmented preset-segmented" role="radiogroup" aria-label="Style preset">
            {THEME_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={themePreset === preset.id ? "active" : ""}
                role="radio"
                aria-checked={themePreset === preset.id}
                onClick={() => onThemePresetChange(preset.id)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-heading"><KeyRound size={18} /><div><strong>Provider credentials</strong><small>System secure storage</small></div></div>
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
              {status.providers.some((provider) => provider.providerId === providerEditor.providerId) ? (
                <div className="provider-editor-readonly"><span>ID</span><code>{providerEditor.providerId}</code></div>
              ) : (
                <label><span>ID</span><input value={providerEditor.providerId} onChange={(event) => setProviderEditor({ ...providerEditor, providerId: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} /></label>
              )}
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
                <div className="credential-actions">
                  <button className="clear" disabled={savingProviderConfig} onClick={() => editProvider(provider)}><Pencil size={13} /> Edit</button>
                  <button className="clear danger" disabled={savingProviderConfig} onClick={() => void removeProvider(provider.providerId)}><Trash2 size={13} /> Delete</button>
                </div>
              </div>
            );
          })}
          {status.providers.length === 0 && <div className="activity-empty">No providers configured</div>}
        </div>
      </section>
      <section className="settings-section mobile-access-settings">
        <div className="settings-heading"><Smartphone size={18} /><div><strong>Mobile access</strong><small>{syncStatus.state === "running" && mobileAccessStatus.accessKey ? "Ready" : "Unavailable"}</small></div></div>
        <div className="mobile-connection-fields">
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
        <div className="settings-heading"><Download size={18} /><div><strong>Application updates</strong><small>{updateStatus.currentVersion ? `Current version ${updateStatus.currentVersion} | ` : ""}{updateStateLabel(updateStatus)}</small></div></div>
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
