import {
  codexComposerCommandPrompt,
  parseCodexComposerCommand,
  type ConversationFile,
  type ParsedCodexComposerCommand,
  type ProjectDirectory,
  type RemoteApprovalPolicy,
  type RemoteDirectoryBrowseResult,
  type RemoteModelOption,
  type RemoteReasoningEffort,
  type RemoteSandboxMode,
  type RemoteTurnAttachment,
  type ThreadSummary,
  type UserInputAnswers,
} from "@rhzycode/protocol";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { Asset, requestPermissionsAsync } from "expo-media-library";
import * as Sharing from "expo-sharing";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ControlClient,
  ControlClientError,
  verifyControlAccess,
} from "./api/control-client";
import { isRetryableConnectionError, runControlCommandWithRetry } from "./api/control-connection-model";
import {
  normalizeAccessKey,
} from "./auth/control-access";
import { AppDrawer, type DrawerPage } from "./components/AppDrawer";
import { ChatScreen, type PendingMessage } from "./components/ChatScreen";
import {
  findRetryablePendingMessage,
  isSparseThreadHistory,
  isThreadHistoryLoading,
  needsThreadHistoryCatchUp,
  openThreadHistoryRetryDelayMs,
  openThreadHistorySoftRetryDelayMs,
  reconcilePendingMessages,
  shouldCatchUpActiveThread,
  shouldContinueThreadHistorySoftRetry,
  shouldKeepSelectedThread,
  shouldOpenThreadHistory,
  shouldReloadCompletedThreadHistory,
  shouldResetOpenedThreadHistory,
  shouldRetryOpenThreadHistory,
} from "./components/chat-screen-model";
import { remoteModelReasoningEfforts } from "./components/model-picker-model";
import { ModelPickerSheet } from "./components/ModelPickerSheet";
import { ProjectPickerSheet, ThreadActionsSheet } from "./components/TaskSheets";
import { describeControlError, useControlPlane } from "./hooks/use-control-plane";
import { createNativeSecureSessionStore } from "./storage/native-secure-session";
import type { MobileSession, MobileSessionState, SecureSessionStore } from "./storage/secure-session";
import { isRegisteredProject, isSameProjectPath, registeredProjectPaths, resolveNewThreadProjectPath } from "./state/project-list";
import { colors, createThemedStyles, loadThemeMode, saveThemeMode, setActiveThemeMode, type ThemeMode } from "./ui/theme";
import { defaultUpdateManifestUrl } from "./platform/update/mobile-update";
import { useMobileUpdate } from "./platform/update/use-mobile-update";

const currentAppVersion = Constants.nativeAppVersion || Constants.expoConfig?.version || "0.0.0";
const currentBuildNumber = String(
  Constants.nativeBuildVersion
    || Constants.expoConfig?.android?.versionCode
    || Constants.expoConfig?.ios?.buildNumber
    || "0",
);
const updateManifestUrl = String(Constants.expoConfig?.extra?.updateManifestUrl || defaultUpdateManifestUrl);

function isImageAttachment(name: string, mimeType?: string): boolean {
  if (mimeType?.toLowerCase().startsWith("image/")) return true;
  return /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(name);
}

function imageMimeType(name: string): string {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "svg") return "image/svg+xml";
  return `image/${extension || "png"}`;
}

interface ThreadActionTarget {
  thread: ThreadSummary;
  archived: boolean;
}

type AttachmentSource = "camera" | "library" | "file";

interface PickedAttachment {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
  dataBase64?: string | null;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
  const [sessionStore] = useState<SecureSessionStore>(() => createNativeSecureSessionStore());
  const [sessionState, setSessionState] = useState<MobileSessionState>({
    connections: [],
    activeConnectionId: null,
  });
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [navigationReady, setNavigationReady] = useState(false);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [drawerPage, setDrawerPage] = useState<DrawerPage>("threads");
  const [drawerSearch, setDrawerSearch] = useState("");
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null);
  const [collapsedProjectPaths, setCollapsedProjectPaths] = useState<string[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [openingThreadId, setOpeningThreadId] = useState<string | null>(null);
  const [newThreadDraft, setNewThreadDraft] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<RemoteTurnAttachment[]>([]);
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [inputBusyId, setInputBusyId] = useState<string | null>(null);
  const [projectPickerVisible, setProjectPickerVisible] = useState(false);
  const [newThreadBusy, setNewThreadBusy] = useState(false);
  const [newThreadError, setNewThreadError] = useState<string | null>(null);
  const [projectDirectories, setProjectDirectories] = useState<ProjectDirectory[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [models, setModels] = useState<RemoteModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [approvalPolicy, setApprovalPolicy] = useState<RemoteApprovalPolicy>("never");
  const [sandboxMode, setSandboxMode] = useState<RemoteSandboxMode>("danger-full-access");
  const [reasoningEffort, setReasoningEffort] = useState<RemoteReasoningEffort>("high");
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [archivedThreads, setArchivedThreads] = useState<ThreadSummary[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [threadAction, setThreadAction] = useState<ThreadActionTarget | null>(null);
  const [threadActionBusy, setThreadActionBusy] = useState(false);
  const [threadActionError, setThreadActionError] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const {
    status: mobileUpdateStatus,
    check: checkForAppUpdate,
    install: installMobileUpdate,
  } = useMobileUpdate({
    currentVersion: currentAppVersion,
    currentBuildNumber,
    manifestUrl: updateManifestUrl,
  });
  const modelsLoadingRef = useRef(false);
  const modelSelectionContext = useRef("");
  const navigationSessionIdRef = useRef<string | null>(null);
  const openedThreadHistoryRef = useRef<string | null>(null);
  const sparseHistoryAttemptsRef = useRef(new Map<string, number>());
  const threadsNeedingHistoryCatchUpRef = useRef(new Set<string>());
  const connectionStatusRef = useRef<string | null>(null);
  const turnCatchUpTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const sendInFlightRef = useRef(false);
  const session = useMemo(
    () => sessionState.connections.find((connection) => connection.id === sessionState.activeConnectionId) || null,
    [sessionState],
  );

  useEffect(() => {
    let active = true;
    void loadThemeMode().then((mode) => {
      if (!active) return;
      setActiveThemeMode(mode);
      setThemeMode(mode);
    });
    return () => { active = false; };
  }, []);

  const changeThemeMode = useCallback((mode: ThemeMode) => {
    setActiveThemeMode(mode);
    setThemeMode(mode);
    void saveThemeMode(mode);
  }, []);

  const loadSession = useCallback(async () => {
    setBooting(true);
    setBootError(null);
    try {
      const loaded = await sessionStore.load();
      const invalidConnectionIds: string[] = [];
      const connections = loaded.connections.map((connection) => {
        try {
          const normalized = { ...connection };
          if (normalized.accessKey) normalizeAccessKey(normalized.accessKey);
          return normalized;
        } catch {
          invalidConnectionIds.push(connection.id);
          return { ...connection, accessKey: "" };
        }
      });
      await Promise.all(invalidConnectionIds.map((id) => sessionStore.clearAccessKey(id)));
      const next = { ...loaded, connections };
      const active = connections.find((connection) => connection.id === loaded.activeConnectionId) || null;
      setSessionState(next);
      setEditingConnectionId(active?.id || null);
      if (invalidConnectionIds.length) setConnectionError("部分电脑的连接信息无效，请重新配置 KEY。");
      if (!active?.accessKey) {
        setDrawerPage("connection");
        setDrawerVisible(true);
      }
    } catch {
      setBootError("无法读取此手机的安全会话，请确认系统安全存储可用后重试。");
    } finally {
      setBooting(false);
    }
  }, [sessionStore]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const rejectCredentials = useCallback((connectionId: string) => {
    void sessionStore.clearAccessKey(connectionId).then(() => {
      setSessionState((current) => ({
        ...current,
        connections: current.connections.map((connection) => (
          connection.id === connectionId ? { ...connection, accessKey: "" } : connection
        )),
      }));
      if (connectionId === sessionState.activeConnectionId) {
        setConnectionError("保存的 KEY 已失效，请输入桌面端生成的新 KEY。");
        setConnectionMessage(null);
        setEditingConnectionId(connectionId);
        setDraftKey("");
        setDrawerPage("connection");
        setDrawerVisible(true);
      }
    }).catch(() => setConnectionError("无法更新失效的电脑连接，请重试。"));
  }, [sessionState.activeConnectionId, sessionState.connections, sessionStore]);

  const control = useControlPlane({
    sessions: sessionState.connections,
    activeConnectionId: sessionState.activeConnectionId,
    onCredentialsRejected: rejectCredentials,
  });
  const taskClient = useMemo(
    () => session?.accessKey
      ? new ControlClient(session.accessKey)
      : null,
    [session?.accessKey],
  );
  const canWrite = Boolean(session?.accessKey);
  const canApprove = Boolean(session?.accessKey);

  useEffect(() => {
    let active = true;
    navigationSessionIdRef.current = null;
    openedThreadHistoryRef.current = null;
    setSelectedThreadId(null);
    setOpeningThreadId(null);
    setNewThreadDraft(false);
    setSelectedProjectPath(null);
    setCollapsedProjectPaths([]);
    setNavigationReady(false);
    setProjectDirectories([]);
    setProjectsLoaded(false);
    setModels([]);
    setSelectedModel("");
    setModelPickerVisible(false);
    setModelsError(null);
    modelSelectionContext.current = "";
    setArchivedThreads([]);
    setPendingMessages([]);
    setDraft("");
    setThreadAction(null);
    if (session?.id) {
      void sessionStore.loadNavigation(session.id).then((navigation) => {
        if (!active) return;
        setSelectedProjectPath(navigation.projectPath);
        setSelectedThreadId(navigation.threadId);
        setNewThreadDraft(navigation.newThreadDraft);
        setCollapsedProjectPaths(navigation.collapsedProjectPaths);
        navigationSessionIdRef.current = session.id;
        setNavigationReady(true);
      }).catch(() => {
        if (active) {
          navigationSessionIdRef.current = session.id;
          setNavigationReady(true);
        }
      });
    } else {
      setNavigationReady(true);
    }
    return () => { active = false; };
  }, [session?.id, sessionStore]);

  useEffect(() => {
    if (!navigationReady || !session?.id || navigationSessionIdRef.current !== session.id) return;
    void sessionStore.saveNavigation(session.id, {
      projectPath: selectedProjectPath,
      threadId: selectedThreadId,
      newThreadDraft,
      collapsedProjectPaths,
    });
  }, [collapsedProjectPaths, navigationReady, newThreadDraft, selectedProjectPath, selectedThreadId, session?.id, sessionStore]);

  const loadProjects = useCallback(async () => {
    if (!taskClient) return;
    try {
      const result = await taskClient.listProjects();
      setProjectDirectories(result.projects);
      setProjectsLoaded(true);
    } catch (error) {
      if (isUnauthorized(error) && session) rejectCredentials(session.id);
    }
  }, [rejectCredentials, session, taskClient]);

  useEffect(() => {
    if (!control.snapshot.projects) return;
    setProjectDirectories(control.snapshot.projects);
    setProjectsLoaded(true);
  }, [control.snapshot.projects]);

  const refreshWorkspace = useCallback(async () => {
    await Promise.all([
      control.refresh(),
      loadProjects(),
    ]);
  }, [control.refresh, loadProjects]);

  const loadModels = useCallback(async () => {
    if (!taskClient || modelsLoadingRef.current) return;
    modelsLoadingRef.current = true;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const result = await taskClient.listModels();
      setModels(result.models);
      setSelectedModel((current) => {
        if (result.models.some((model) => model.model === current)) return current;
        return result.models.find((model) => model.isDefault)?.model
          || result.models[0]?.model
          || "";
      });
    } catch (error) {
      setModelsError(describeControlError(error));
      if (isUnauthorized(error) && session) rejectCredentials(session.id);
    } finally {
      modelsLoadingRef.current = false;
      setModelsLoading(false);
    }
  }, [rejectCredentials, session, taskClient]);

  useEffect(() => {
    if (control.status !== "online") return;
    void refreshWorkspace();
    void loadModels();
  }, [control.status, loadModels, refreshWorkspace]);

  useEffect(() => {
    if (!drawerVisible || drawerPage !== "threads" || control.status !== "online") return;
    void refreshWorkspace();
  }, [control.status, drawerPage, drawerVisible, refreshWorkspace]);

  useEffect(() => {
    if (!navigationReady || newThreadDraft || !control.snapshot.threads.length) return;
    if (shouldKeepSelectedThread(selectedThreadId, control.snapshot.threads, pendingMessages)) return;
    if (selectedThreadId && control.status !== "online") return;
    const ordered = [...control.snapshot.threads].sort((left, right) => {
      const activeDifference = Number(isActive(right)) - Number(isActive(left));
      return activeDifference || right.updatedAt.localeCompare(left.updatedAt);
    });
    const preferred = ordered.find((thread) => selectedProjectPath && isSameProjectPath(thread.projectPath, selectedProjectPath)) || ordered[0];
    if (preferred) setSelectedThreadId(preferred.id);
    if (preferred) setSelectedProjectPath(preferred.projectPath);
    if (preferred) setNewThreadDraft(false);
  }, [control.snapshot.threads, control.status, navigationReady, newThreadDraft, pendingMessages, selectedProjectPath, selectedThreadId]);

  const modelCatalogKey = useMemo(() => models.map((model) => model.model).join("\n"), [models]);

  useEffect(() => {
    if (!models.length) return;
    const context = `${session?.id || ""}:${selectedThreadId || "new"}`;
    const contextChanged = modelSelectionContext.current !== context;
    modelSelectionContext.current = context;
    const threadModel = control.snapshot.threads.find((thread) => thread.id === selectedThreadId)?.model;
    setSelectedModel((current) => {
      if (!contextChanged && models.some((model) => model.model === current)) return current;
      return models.find((model) => model.model === threadModel)?.model
        || models.find((model) => model.isDefault)?.model
        || models[0]?.model
        || "";
    });
  }, [modelCatalogKey, selectedThreadId, session?.id]);

  useEffect(() => {
    if (!pendingMessages.length) return;
    setPendingMessages((current) => reconcilePendingMessages(current, control.snapshot.timeline));
  }, [control.snapshot.timeline, pendingMessages]);

  const selectedThread = useMemo(
    () => control.snapshot.threads.find((thread) => thread.id === selectedThreadId)
      || archivedThreads.find((thread) => thread.id === selectedThreadId)
      || null,
    [archivedThreads, control.snapshot.threads, selectedThreadId],
  );
  const selectedIsArchived = Boolean(archivedThreads.some((thread) => thread.id === selectedThreadId));
  const recentProjects = useMemo(
    () => registeredProjectPaths(projectDirectories.map((project) => project.path)),
    [projectDirectories],
  );

  useEffect(() => {
    if (!selectedThreadId) {
      openedThreadHistoryRef.current = null;
      sparseHistoryAttemptsRef.current.clear();
    }
    const needsCompletedTurnCatchUp = shouldReloadCompletedThreadHistory({
      selectedThreadId,
      threadStatus: selectedThread?.status,
      online: control.status === "online",
      needsCatchUp: Boolean(selectedThreadId && threadsNeedingHistoryCatchUpRef.current.has(selectedThreadId)),
    });
    const shouldOpenHistory = shouldOpenThreadHistory({
      selectedThreadId,
      selectedIsArchived,
      online: control.status === "online",
      alreadyOpenedThreadId: needsCompletedTurnCatchUp ? null : openedThreadHistoryRef.current,
    });
    if (!taskClient || !selectedThreadId || !shouldOpenHistory) {
      setOpeningThreadId(null);
      return undefined;
    }
    let cancelled = false;
    const threadId = selectedThreadId;
    setOpeningThreadId(threadId);

    const loadHistory = async () => {
      let attempt = sparseHistoryAttemptsRef.current.get(threadId) || 0;
      let sawSparse = false;
      let needsSoftCatchUp = false;
      const clearOpeningIndicator = () => {
        if (!cancelled) {
          setOpeningThreadId((current) => (current === threadId ? null : current));
        }
      };

      // Immediate retries: cover both sparse payloads and flaky transport.
      while (!cancelled) {
        try {
          const result = await runControlCommandWithRetry(
            () => taskClient.openThread(threadId),
            { attempts: 2 },
          );
          if (cancelled) return;
          control.hydrateThread(result);
          // Show whatever we got while catch-up continues in the background.
          clearOpeningIndicator();
          const sparse = isSparseThreadHistory(result.timeline, threadId);
          sawSparse = sparse;
          if (shouldRetryOpenThreadHistory({
            online: true,
            attempt,
            sparse,
          })) {
            attempt += 1;
            sparseHistoryAttemptsRef.current.set(threadId, attempt);
            await new Promise((resolve) => setTimeout(resolve, openThreadHistoryRetryDelayMs(attempt)));
            continue;
          }
          sparseHistoryAttemptsRef.current.delete(threadId);
          if (!sparse) {
            openedThreadHistoryRef.current = threadId;
            threadsNeedingHistoryCatchUpRef.current.delete(threadId);
            return;
          }
          // Still sparse after the immediate budget: do not lock the cache yet.
          needsSoftCatchUp = needsThreadHistoryCatchUp({ sparse });
          break;
        } catch (error) {
          if (cancelled) return;
          if (isUnauthorized(error) && session) {
            rejectCredentials(session.id);
            return;
          }
          if (shouldRetryOpenThreadHistory({
            online: true,
            attempt,
            error,
            isRetryableError: isRetryableConnectionError,
          })) {
            attempt += 1;
            sparseHistoryAttemptsRef.current.set(threadId, attempt);
            await new Promise((resolve) => setTimeout(resolve, openThreadHistoryRetryDelayMs(attempt)));
            continue;
          }
          needsSoftCatchUp = needsThreadHistoryCatchUp({
            error,
            isRetryableError: isRetryableConnectionError,
          });
          if (needsSoftCatchUp) break;
          Alert.alert("无法加载对话", describeControlError(error));
          return;
        }
      }

      // Soft catch-up also covers repeated transport failures while the socket
      // still reports online, so a lost openThread response cannot strand history.
      let softAttempt = 0;
      while (!cancelled && shouldContinueThreadHistorySoftRetry({
        online: true,
        needsCatchUp: needsSoftCatchUp,
        softAttempt,
      })) {
        softAttempt += 1;
        await new Promise((resolve) => setTimeout(resolve, openThreadHistorySoftRetryDelayMs(softAttempt)));
        if (cancelled) return;
        try {
          const result = await runControlCommandWithRetry(
            () => taskClient.openThread(threadId),
            { attempts: 2 },
          );
          if (cancelled) return;
          control.hydrateThread(result);
          const sparse = isSparseThreadHistory(result.timeline, threadId);
          sawSparse = sparse;
          needsSoftCatchUp = needsThreadHistoryCatchUp({ sparse });
          if (!sparse) {
            sparseHistoryAttemptsRef.current.delete(threadId);
            openedThreadHistoryRef.current = threadId;
            threadsNeedingHistoryCatchUpRef.current.delete(threadId);
            return;
          }
        } catch (error) {
          if (cancelled) return;
          if (isUnauthorized(error) && session) {
            rejectCredentials(session.id);
            return;
          }
          needsSoftCatchUp = needsThreadHistoryCatchUp({
            error,
            isRetryableError: isRetryableConnectionError,
          });
          if (!needsSoftCatchUp) {
            Alert.alert("无法加载对话", describeControlError(error));
            return;
          }
        }
      }

      // Exhausted soft retries while still sparse: lock to avoid thrashing until reconnect.
      if (!cancelled && sawSparse) {
        openedThreadHistoryRef.current = threadId;
      }
    };

    void loadHistory().finally(() => {
      if (!cancelled) setOpeningThreadId((current) => current === threadId ? null : current);
    });
    return () => {
      cancelled = true;
    };
  }, [control.hydrateThread, control.status, rejectCredentials, selectedIsArchived, selectedThread?.status, selectedThreadId, session, taskClient]);

  useEffect(() => {
    const previous = connectionStatusRef.current;
    connectionStatusRef.current = control.status;
    if (shouldResetOpenedThreadHistory(previous, control.status)) {
      openedThreadHistoryRef.current = null;
      sparseHistoryAttemptsRef.current.clear();
    }
  }, [control.status]);

  useEffect(() => () => {
    for (const timer of turnCatchUpTimersRef.current) clearTimeout(timer);
    turnCatchUpTimersRef.current = [];
  }, []);

  useEffect(() => {
    if (!selectedThreadId || !shouldCatchUpActiveThread({
      online: control.status === "online",
      threadStatus: selectedThread?.status,
    })) return undefined;
    // Snapshot catch-up covers AI stream frames lost while the socket flaps on weak networks.
    const timer = setInterval(() => {
      void control.refresh();
    }, 3_500);
    return () => clearInterval(timer);
  }, [control.refresh, control.status, selectedThread?.status, selectedThreadId]);

  useEffect(() => {
    if (!projectsLoaded || !selectedProjectPath || isRegisteredProject(selectedProjectPath, recentProjects)) return;
    setSelectedProjectPath(null);
    setNewThreadDraft(false);
  }, [projectsLoaded, recentProjects, selectedProjectPath]);

  useEffect(() => {
    if (!projectsLoaded) return;
    setCollapsedProjectPaths((current) => {
      const next = current.filter((path) => isRegisteredProject(path, recentProjects));
      return next.length === current.length ? current : next;
    });
  }, [collapsedProjectPaths, projectsLoaded, recentProjects]);
  const selectedModelOption = useMemo(
    () => models.find((model) => model.model === selectedModel) || null,
    [models, selectedModel],
  );
  const reasoningEfforts = useMemo(
    () => remoteModelReasoningEfforts(selectedModelOption),
    [selectedModelOption],
  );

  useEffect(() => {
    setReasoningEffort((current) => reasoningEfforts.includes(current) ? current : reasoningEfforts[0] || "high");
  }, [reasoningEfforts]);

  const openProjectDirectory = useCallback(async (projectPath: string, create = false): Promise<string | null> => {
    if (!taskClient || newThreadBusy) return null;
    setNewThreadBusy(true);
    setNewThreadError(null);
    try {
      const result = await taskClient.openProject(projectPath, create);
      setProjectDirectories((current) => current.some((project) => isSameProjectPath(project.path, result.project.path))
        ? current.map((project) => isSameProjectPath(project.path, result.project.path) ? result.project : project)
        : [...current, result.project]);
      setSelectedProjectPath(result.project.path);
      setProjectPickerVisible(false);
      setDrawerVisible(false);
      return result.project.path;
    } catch (error) {
      if (error instanceof ControlClientError && error.code === "invalid_request") {
        setNewThreadError("请输入电脑上的绝对目录路径。");
      } else if (error instanceof ControlClientError && error.code === "conflict") {
        setNewThreadError("该路径是文件，不能作为工程目录打开。");
      } else if (error instanceof ControlClientError && error.code === "not_found") {
        setNewThreadError(create ? "无法在电脑上创建该目录。" : "电脑上不存在该工程目录。");
      } else {
        setNewThreadError(describeControlError(error));
      }
      if (isUnauthorized(error) && session) rejectCredentials(session.id);
      return null;
    } finally {
      setNewThreadBusy(false);
    }
  }, [newThreadBusy, rejectCredentials, session, taskClient]);

  const browseComputerDirectories = useCallback(async (projectPath?: string): Promise<RemoteDirectoryBrowseResult | null> => {
    if (!taskClient) return null;
    setNewThreadError(null);
    try {
      return await taskClient.browseDirectories(projectPath);
    } catch (error) {
      setNewThreadError(describeControlError(error));
      if (isUnauthorized(error) && session) rejectCredentials(session.id);
      return null;
    }
  }, [rejectCredentials, session, taskClient]);

  const createThreadDraft = useCallback((projectPath: string) => {
    setSelectedThreadId(null);
    setSelectedProjectPath(projectPath);
    setNewThreadDraft(true);
    setDraft("");
    setAttachments([]);
    setProjectPickerVisible(false);
  }, []);

  const openNewThread = useCallback((requestedProjectPath?: string) => {
    setDrawerVisible(false);
    setNewThreadError(null);
    if (!session?.accessKey) {
      setEditingConnectionId(session?.id || null);
      setDraftKey("");
      setDrawerPage("connection");
      setDrawerVisible(true);
      return;
    }
    if (!canWrite) {
      setDrawerPage("settings");
      setDrawerVisible(true);
      return;
    }
    const projectPath = resolveNewThreadProjectPath(
      requestedProjectPath,
      selectedProjectPath,
      selectedThread?.projectPath,
      recentProjects,
    );
    if (!projectPath) {
      setSelectedThreadId(null);
      setNewThreadDraft(true);
      setDraft("");
      setAttachments([]);
      setProjectPickerVisible(true);
      return;
    }
    createThreadDraft(projectPath);
  }, [canWrite, createThreadDraft, recentProjects, selectedProjectPath, selectedThread?.projectPath, session]);

  const openProjectPicker = useCallback(() => {
    setNewThreadError(null);
    setDrawerVisible(false);
    setProjectPickerVisible(true);
  }, []);

  const executeComposerCommand = useCallback(async (
    command: ParsedCodexComposerCommand,
  ): Promise<string | null> => {
    const prompt = codexComposerCommandPrompt(command);
    if (prompt) return prompt;
    if (!command.known) {
      Alert.alert("未知命令", `Codex 不支持 /${command.name}。`);
      return null;
    }
    if (attachments.length) {
      Alert.alert("无法执行命令", "请先移除附件。 ");
      return null;
    }

    if (command.name === "new" || command.name === "clear") {
      setDraft("");
      openNewThread();
      return null;
    }
    if (command.name === "resume") {
      setDraft("");
      const target = command.args
        ? control.snapshot.threads.find((thread) => thread.id === command.args)
          || control.snapshot.threads.find((thread) =>
            thread.title.toLocaleLowerCase() === command.args.toLocaleLowerCase())
        : null;
      if (target) {
        setSelectedThreadId(target.id);
        setSelectedProjectPath(target.projectPath);
        setNewThreadDraft(false);
        setDrawerVisible(false);
      } else {
        setDrawerSearch(command.args);
        setDrawerPage("threads");
        setDrawerVisible(true);
      }
      return null;
    }
    if (command.name === "model") {
      setDraft("");
      if (command.args) {
        const target = models.find((model) => model.model === command.args)
          || models.find((model) => model.displayName.toLocaleLowerCase().includes(command.args.toLocaleLowerCase()));
        if (target) setSelectedModel(target.model);
        else Alert.alert("未找到模型", command.args);
      } else {
        setModelPickerVisible(true);
      }
      return null;
    }
    if (command.name === "compact") {
      if (!selectedThreadId || !taskClient) {
        Alert.alert("无法压缩", "请先打开一个对话。");
        return null;
      }
      setDraft("");
      setSending(true);
      try {
        await taskClient.compactThread(selectedThreadId);
        await control.refresh();
      } catch (error) {
        Alert.alert("对话压缩失败", describeControlError(error));
      } finally {
        setSending(false);
      }
      return null;
    }
    if (command.name === "status" || command.name === "permissions") {
      setDraft("");
      Alert.alert("Codex 状态", [
        `模型: ${selectedModel || "default"}`,
        `沙箱: ${sandboxMode}`,
        `审批: ${approvalPolicy}`,
        `项目: ${selectedProjectPath || "none"}`,
        `对话: ${selectedThreadId || "new"}`,
      ].join("\n"));
      return null;
    }
    if (command.name === "help") {
      setDraft("");
      Alert.alert("Codex 命令", "/new  /clear  /resume  /model  /compact  /status  /permissions  /review  /diff  /init");
      return null;
    }

    Alert.alert("暂不支持", `已识别 /${command.name}，但手机版暂未提供此操作。`);
    return null;
  }, [approvalPolicy, attachments.length, control, models, openNewThread, sandboxMode, selectedModel, selectedProjectPath, selectedThreadId, taskClient]);

  const sendMessage = useCallback(async () => {
    let content = draft.trim();
    const command = parseCodexComposerCommand(content);
    if (command) {
      const commandPrompt = await executeComposerCommand(command);
      if (!commandPrompt) return;
      content = commandPrompt;
    }
    if (
      !taskClient
      || (!selectedThreadId && (!newThreadDraft || !selectedProjectPath))
      || (!content && !attachments.length)
      || sending
      || sendInFlightRef.current
      || selectedIsArchived
    ) return;
    const submittedAttachments = attachments;
    const submittedText = content || "Review the attached files.";
    const retryPending = selectedThreadId ? findRetryablePendingMessage(pendingMessages, {
      threadId: selectedThreadId,
      content: submittedText,
      attachments: submittedAttachments,
    }) : null;
    const id = retryPending?.id || Crypto.randomUUID();
    let targetThreadId = selectedThreadId;
    let pendingAdded = false;
    sendInFlightRef.current = true;
    setSending(true);
    try {
      if (!targetThreadId) {
        const result = await runControlCommandWithRetry(() => taskClient.startThread({
          projectPath: selectedProjectPath!,
          ...(selectedModel ? { model: selectedModel } : {}),
          approvalPolicy,
          sandboxMode,
        }, 45_000, `${id}:thread`));
        targetThreadId = result.threadId;
        setSelectedThreadId(targetThreadId);
        setNewThreadDraft(false);
      }

      const pending: PendingMessage = {
        id,
        threadId: targetThreadId,
        content: submittedText,
        createdAt: retryPending?.createdAt || new Date().toISOString(),
        state: "sending",
        attachments: submittedAttachments.map((attachment) => ({
          name: attachment.name,
          kind: attachment.kind,
          size: attachment.size,
          ...(attachment.kind === "image"
            ? { uri: `data:${imageMimeType(attachment.name)};base64,${attachment.dataBase64}` }
            : {}),
        })),
      };
      pendingAdded = true;
      setPendingMessages((current) => current.some((message) => message.id === id)
        ? current.map((message) => message.id === id ? pending : message)
        : [...current, pending]);
      setDraft("");
      setAttachments([]);
      const turnInput = {
        text: submittedText,
        clientMessageId: id,
        attachments: submittedAttachments,
        ...(selectedModel ? { model: selectedModel } : {}),
        approvalPolicy,
        sandboxMode,
        ...(reasoningEfforts.length ? { reasoningEffort } : {}),
      };
      if (!targetThreadId) throw new Error("无法确定消息所属的对话。");
      const turnThreadId = targetThreadId;
      await runControlCommandWithRetry(() => taskClient.startTurn(
        turnThreadId,
        turnInput,
        45_000,
        `${id}:turn`,
      ));
      threadsNeedingHistoryCatchUpRef.current.add(turnThreadId);
      setPendingMessages((current) => current.map((message) => (
        message.id === id ? { ...message, state: "sent" } : message
      )));
      // Prefer live events over a blocking snapshot refresh on weak networks,
      // then schedule short catch-up polls in case stream frames were dropped.
      void control.refresh();
      for (const timer of turnCatchUpTimersRef.current) clearTimeout(timer);
      turnCatchUpTimersRef.current = [2_000, 6_000, 14_000].map((delay) => setTimeout(() => {
        void control.refresh();
      }, delay));
    } catch (error) {
      if (pendingAdded) {
        if (targetThreadId) threadsNeedingHistoryCatchUpRef.current.add(targetThreadId);
        setPendingMessages((current) => current.map((message) => (
          message.id === id ? { ...message, state: "failed" } : message
        )));
      } else {
        Alert.alert("无法创建对话", describeControlError(error));
      }
      setDraft((current) => current || content);
      setAttachments((current) => current.length ? current : submittedAttachments);
      if (isUnauthorized(error) && session) rejectCredentials(session.id);
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }, [approvalPolicy, attachments, control, draft, executeComposerCommand, newThreadDraft, pendingMessages, reasoningEffort, reasoningEfforts, rejectCredentials, sandboxMode, selectedIsArchived, selectedModel, selectedProjectPath, selectedThreadId, sending, session, taskClient]);

  const addPickedAttachments = useCallback(async (picked: PickedAttachment[]) => {
    const available = Math.max(0, 20 - attachments.length);
    const selected = picked.slice(0, available);
    const knownSize = attachments.reduce((sum, attachment) => sum + attachment.size, 0)
      + selected.reduce((sum, asset) => sum + (asset.size || 0), 0);
    if (knownSize > 25 * 1024 * 1024) throw new Error("每条消息的附件总大小不能超过 25 MB。");

    const loaded: RemoteTurnAttachment[] = [];
    for (const asset of selected) {
      const file = new File(asset.uri);
      const size = asset.size || file.size;
      if (!size) throw new Error(`${asset.name} 是空文件。`);
      loaded.push({
        name: asset.name,
        kind: isImageAttachment(asset.name, asset.mimeType || undefined) ? "image" : "file",
        size,
        dataBase64: asset.dataBase64 || await file.base64(),
      });
    }

    const totalSize = attachments.reduce((sum, attachment) => sum + attachment.size, 0)
      + loaded.reduce((sum, attachment) => sum + attachment.size, 0);
    if (totalSize > 25 * 1024 * 1024) throw new Error("每条消息的附件总大小不能超过 25 MB。");
    setAttachments((current) => [...current, ...loaded]);
  }, [attachments]);

  const chooseAttachments = useCallback(async (source: AttachmentSource) => {
    try {
      if (source === "file") {
        const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
        if (result.canceled) return;
        await addPickedAttachments(result.assets.map((asset) => ({
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType,
          size: asset.size,
          dataBase64: asset.base64,
        })));
        return;
      }

      if (source === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          Alert.alert("需要相机权限", "允许使用相机后才能拍照添加附件。");
          return;
        }
      }

      const result = source === "camera"
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 })
        : await ImagePicker.launchImageLibraryAsync({
          allowsMultipleSelection: true,
          mediaTypes: ["images"],
          quality: 1,
          selectionLimit: Math.max(1, 20 - attachments.length),
        });
      if (result.canceled) return;
      const capturedAt = Date.now();
      await addPickedAttachments(result.assets.map((asset, index) => ({
        uri: asset.uri,
        name: asset.fileName || `photo-${capturedAt}-${index + 1}.jpg`,
        mimeType: asset.mimeType || "image/jpeg",
        size: asset.fileSize,
        dataBase64: asset.base64,
      })));
    } catch (error) {
      Alert.alert("无法添加附件", error instanceof Error ? error.message : "附件选择失败。");
    }
  }, [addPickedAttachments, attachments.length]);

  const openConversationFile = useCallback(async (file: ConversationFile) => {
    if (!taskClient) return;
    try {
      const request = taskClient.managedFileRequest(file.id);
      const directory = new Directory(Paths.document, "RHZYCODE");
      directory.create({ idempotent: true, intermediates: true });
      const destination = new File(directory, safeDownloadName(file.id, file.name));
      const downloaded = await File.downloadFileAsync(request.url, destination, {
        headers: request.headers,
        idempotent: true,
      });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(downloaded.uri, {
          dialogTitle: file.name,
          ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        });
      } else {
        Alert.alert("文件已保存", downloaded.uri);
      }
    } catch (error) {
      Alert.alert("无法下载文件", error instanceof Error ? error.message : "文件下载失败。");
    }
  }, [taskClient]);

  const fetchGeneratedImage = useCallback(async (image: { id: string; name: string; managed?: boolean }) => {
    if (!taskClient) throw new Error("尚未连接桌面端。");
    const source = image.managed
      ? (() => {
          const request = taskClient.managedFileRequest(image.id);
          return { uri: request.url, headers: request.headers };
        })()
      : taskClient.generatedImageSource(image.id);
    const directory = new Directory(Paths.cache, "RHZYCODE", "generated-actions");
    directory.create({ idempotent: true, intermediates: true });
    const destination = new File(directory, safeDownloadName(image.id, image.name));
    return File.downloadFileAsync(source.uri, destination, {
      headers: source.headers,
      idempotent: true,
    });
  }, [taskClient]);

  const downloadGeneratedImage = useCallback(async (image: { id: string; name: string; managed?: boolean }) => {
    try {
      const permission = await requestPermissionsAsync(true, ["photo"]);
      if (!permission.granted) {
        Alert.alert("无法保存图片", "需要允许 RHZYCODE 将图片保存到系统相册。");
        return;
      }
      const downloaded = await fetchGeneratedImage(image);
      await Asset.create(downloaded.uri);
      Alert.alert("下载完成", "图片已保存到系统相册。");
    } catch (error) {
      Alert.alert("无法保存图片", error instanceof Error ? error.message : "图片保存失败。");
    }
  }, [fetchGeneratedImage]);

  const shareGeneratedImage = useCallback(async (image: { id: string; name: string; managed?: boolean }) => {
    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("无法分享图片", "当前设备不支持系统分享。");
        return;
      }
      const downloaded = await fetchGeneratedImage(image);
      await Sharing.shareAsync(downloaded.uri, {
        dialogTitle: image.name,
        mimeType: imageMimeType(image.name),
      });
    } catch (error) {
      Alert.alert("无法分享图片", error instanceof Error ? error.message : "图片分享失败。");
    }
  }, [fetchGeneratedImage]);

  const interruptTurn = useCallback(async () => {
    if (!taskClient || !selectedThreadId || interrupting) return;
    setInterrupting(true);
    try {
      await taskClient.interruptTurn(selectedThreadId);
      await control.refresh();
    } catch (error) {
      Alert.alert("无法停止任务", describeControlError(error));
      if (isUnauthorized(error) && session) rejectCredentials(session.id);
    } finally {
      setInterrupting(false);
    }
  }, [control, interrupting, rejectCredentials, selectedThreadId, session, taskClient]);

  const submitUserInput = useCallback(async (requestId: string, answers: UserInputAnswers) => {
    if (!taskClient || inputBusyId) return;
    setInputBusyId(requestId);
    try {
      await taskClient.submitUserInput(requestId, answers);
      await control.refresh();
    } catch (error) {
      Alert.alert("无法提交回答", describeControlError(error));
      if (isUnauthorized(error) && session) rejectCredentials(session.id);
    } finally {
      setInputBusyId(null);
    }
  }, [control, inputBusyId, rejectCredentials, session, taskClient]);

  const loadArchived = useCallback(async () => {
    if (!taskClient || !canWrite || archivedLoading) return;
    setArchivedLoading(true);
    try {
      const result = await taskClient.listArchivedThreads();
      setArchivedThreads(result.threads);
    } catch (error) {
      Alert.alert("无法读取归档", describeControlError(error));
    } finally {
      setArchivedLoading(false);
    }
  }, [archivedLoading, canWrite, taskClient]);

  const changeDrawerPage = useCallback((page: DrawerPage) => {
    setDrawerPage(page);
    setDrawerSearch("");
    if (page === "archived") void loadArchived();
  }, [loadArchived]);

  const selectThread = useCallback((thread: ThreadSummary) => {
    setSelectedThreadId(thread.id);
    setNewThreadDraft(false);
    setSelectedProjectPath(thread.projectPath);
    setDraft("");
    setDrawerVisible(false);
  }, []);

  const openThreadActions = useCallback((thread: ThreadSummary, archived: boolean) => {
    setThreadAction({ thread, archived });
    setThreadActionError(null);
    setDrawerVisible(false);
  }, []);

  const removeProject = useCallback(async (projectPath: string) => {
    if (!taskClient || control.status !== "online") return;
    try {
      const result = await taskClient.removeProject(projectPath);
      setProjectDirectories(result.projects);
      setCollapsedProjectPaths((current) => current.filter((path) => !isSameProjectPath(path, projectPath)));
      if (selectedProjectPath && isSameProjectPath(selectedProjectPath, projectPath)) {
        setSelectedProjectPath(null);
        setNewThreadDraft(false);
      }
    } catch (error) {
      Alert.alert("无法移除项目", describeControlError(error));
      if (isUnauthorized(error) && session) rejectCredentials(session.id);
    }
  }, [control.status, rejectCredentials, selectedProjectPath, session, taskClient]);

  const toggleProject = useCallback((projectPath: string) => {
    setCollapsedProjectPaths((current) => {
      const collapsed = current.some((path) => isSameProjectPath(path, projectPath));
      return collapsed
        ? current.filter((path) => !isSameProjectPath(path, projectPath))
        : [...current, projectPath].slice(-50);
    });
  }, []);

  const confirmRemoveProject = useCallback((projectPath: string) => {
    Alert.alert(
      "移除这个项目？",
      "只会从 RHZYCODE 项目列表中移除，不会删除电脑上的目录或历史对话。",
      [
        { text: "取消", style: "cancel" },
        { text: "移除", style: "destructive", onPress: () => void removeProject(projectPath) },
      ],
    );
  }, [removeProject]);

  const runThreadMutation = useCallback(async (
    action: "rename" | "archive" | "unarchive" | "delete",
    name?: string,
  ) => {
    if (!taskClient || !threadAction || threadActionBusy) return;
    setThreadActionBusy(true);
    setThreadActionError(null);
    try {
      if (action === "rename") await taskClient.renameThread(threadAction.thread.id, name || threadAction.thread.title);
      if (action === "archive") await taskClient.archiveThread(threadAction.thread.id);
      if (action === "unarchive") await taskClient.unarchiveThread(threadAction.thread.id);
      if (action === "delete") await taskClient.deleteThread(threadAction.thread.id);
      if (action !== "rename" && selectedThreadId === threadAction.thread.id) {
        openedThreadHistoryRef.current = null;
        setOpeningThreadId(null);
        setSelectedThreadId(null);
        setSelectedProjectPath(threadAction.thread.projectPath);
        setNewThreadDraft(true);
        setDraft("");
        setAttachments([]);
        setPendingMessages((current) => current.filter((message) => message.threadId !== threadAction.thread.id));
      }
      setArchivedThreads((current) => current.filter((thread) => thread.id !== threadAction.thread.id));
      setThreadAction(null);
      await control.refresh();
      if (drawerPage === "archived") await loadArchived();
    } catch (error) {
      setThreadActionError(describeControlError(error));
      if (isUnauthorized(error) && session) rejectCredentials(session.id);
    } finally {
      setThreadActionBusy(false);
    }
  }, [control, drawerPage, loadArchived, rejectCredentials, selectedThreadId, session, taskClient, threadAction, threadActionBusy]);

  const confirmDeleteThread = useCallback(() => {
    if (!threadAction) return;
    Alert.alert(
      "删除这个对话？",
      "此操作无法撤销。",
      [
        { text: "取消", style: "cancel" },
        { text: "删除", style: "destructive", onPress: () => void runThreadMutation("delete") },
      ],
    );
  }, [runThreadMutation, threadAction]);

  const saveConnection = useCallback(async () => {
    let accessKey: string;
    const editingConnection = sessionState.connections.find((connection) => connection.id === editingConnectionId);
    try {
      accessKey = normalizeAccessKey(draftKey || editingConnection?.accessKey || "");
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "连接配置无效。");
      return;
    }
    setConnectionBusy(true);
    setConnectionError(null);
    setConnectionMessage(null);
    try {
      await verifyControlAccess({ accessKey });
      const next = await sessionStore.saveConnection({ id: editingConnectionId || undefined, accessKey });
      setSessionState(next);
      setDraftKey("");
      setEditingConnectionId(next.activeConnectionId);
      setConnectionMessage("KEY 已安全保存，公网中转连接已启动。");
      setDrawerPage("threads");
      setDrawerVisible(false);
    } catch (error) {
      setConnectionError(connectionErrorMessage(error));
    } finally {
      setConnectionBusy(false);
    }
  }, [draftKey, editingConnectionId, sessionState.connections, sessionStore]);

  const addConnection = useCallback(() => {
    setEditingConnectionId(null);
    setDraftKey("");
    setConnectionError(null);
    setConnectionMessage(null);
    setDrawerPage("connection");
  }, []);

  const editConnection = useCallback((connectionId: string) => {
    if (!sessionState.connections.some((connection) => connection.id === connectionId)) return;
    setEditingConnectionId(connectionId);
    setDraftKey("");
    setConnectionError(null);
    setConnectionMessage(null);
    setDrawerPage("connection");
  }, [sessionState.connections]);

  const selectConnection = useCallback((connectionId: string) => {
    const target = sessionState.connections.find((connection) => connection.id === connectionId);
    if (!target) return;
    if (connectionId === sessionState.activeConnectionId) {
      if (target.accessKey) setDrawerPage("threads");
      else {
        setEditingConnectionId(target.id);
        setDraftKey("");
        setDrawerPage("connection");
      }
      return;
    }
    void sessionStore.setActiveConnection(connectionId).then(() => {
      setSessionState((current) => ({ ...current, activeConnectionId: connectionId }));
      if (target.accessKey) setDrawerPage("threads");
      else {
        setEditingConnectionId(target.id);
        setDraftKey("");
        setDrawerPage("connection");
      }
    }).catch(() => setConnectionError("无法切换电脑，请重试。"));
  }, [sessionState.activeConnectionId, sessionState.connections, sessionStore]);

  const removeEditingConnection = useCallback(() => {
    if (!editingConnectionId) return;
    const connectionId = editingConnectionId;
    const removingActiveConnection = connectionId === sessionState.activeConnectionId;
    Alert.alert(
      "移除此电脑？",
      "将从手机中移除此电脑及其保存的 KEY，不会影响其他电脑。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "移除",
          style: "destructive",
          onPress: () => {
            void sessionStore.removeConnection(connectionId).then((next) => {
              setSessionState(next);
              if (removingActiveConnection) setSelectedThreadId(null);
              setConnectionMessage(null);
              setConnectionError(null);
              setDraftKey("");
              setEditingConnectionId(null);
              setDrawerPage("computers");
            }).catch(() => setConnectionError("无法移除此电脑，请重试。"));
          },
        },
      ],
    );
  }, [editingConnectionId, sessionState.activeConnectionId, sessionStore]);

  if (booting) return <BootScreen message="正在恢复安全会话…" themeMode={themeMode} />;
  if (bootError) {
    return <BootScreen error message={bootError || "无法启动移动端。"} onRetry={() => void loadSession()} themeMode={themeMode} />;
  }

  return (
    <SafeAreaFrame>
      <StatusBar style={themeMode === "dark" ? "light" : "dark"} />
      <ChatScreen
        approvalPolicy={approvalPolicy}
        attachments={attachments}
        approvalOperations={control.approvalOperations}
        approvals={control.snapshot.approvals}
        canApprove={canApprove}
        canWrite={canWrite && !selectedIsArchived}
        connectionNotice={control.notice}
        connectionStatus={control.status}
        draft={draft}
        historyLoading={isThreadHistoryLoading(selectedThreadId, openingThreadId)}
        inputBusyId={inputBusyId}
        interrupting={interrupting}
        onApproval={(id, decision) => void control.resolveApproval(id, decision)}
        onApprovalPolicyChange={setApprovalPolicy}
        onAttach={(source) => void chooseAttachments(source)}
        onDraftChange={setDraft}
        onInterrupt={() => void interruptTurn()}
        onNoticePress={() => {
          if (control.status === "needs_configuration") {
            setEditingConnectionId(session?.id || null);
            setDraftKey("");
            setDrawerPage("connection");
            setDrawerVisible(true);
          } else void control.refresh();
        }}
        onOpenDrawer={() => {
          setDrawerPage("threads");
          setDrawerVisible(true);
        }}
        onOpenModelPicker={() => {
          setModelPickerVisible(true);
          if (!models.length || modelsError) void loadModels();
        }}
        onOpenFile={openConversationFile}
        onDownloadGeneratedImage={downloadGeneratedImage}
        onShareGeneratedImage={shareGeneratedImage}
        onRefresh={() => void control.refresh()}
        onSend={() => void sendMessage()}
        onRemoveAttachment={(index) => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
        onReasoningEffortChange={setReasoningEffort}
        onSandboxModeChange={setSandboxMode}
        onSubmitInput={(id, answers) => void submitUserInput(id, answers)}
        pendingMessages={pendingMessages}
        modelPickerEnabled={Boolean(taskClient && control.status === "online")}
        newThreadDraft={newThreadDraft && Boolean(selectedProjectPath)}
        refreshing={control.refreshing}
        resolveGeneratedImage={(imageId) => taskClient?.generatedImageSource(imageId) || null}
        resolveManagedImage={(fileId) => {
          if (!taskClient) return null;
          const request = taskClient.managedFileRequest(fileId);
          return { uri: request.url, headers: request.headers };
        }}
        reasoningEffort={reasoningEffort}
        reasoningEfforts={reasoningEfforts}
        sandboxMode={sandboxMode}
        selectedModelLabel={selectedModelOption?.displayName || null}
        selectedThreadId={selectedThreadId}
        sending={sending}
        thread={selectedThread}
        timeline={control.snapshot.timeline}
        userInputs={control.snapshot.userInputs}
      />

      <AppDrawer
        appVersion={currentAppVersion}
        collapsedProjectPaths={collapsedProjectPaths}
        archivedLoading={archivedLoading}
        archivedThreads={archivedThreads}
        activeConnectionId={sessionState.activeConnectionId}
        canManageThreads={canWrite}
        connections={sessionState.connections}
        connectionStates={control.connectionStates}
        connectionStatus={control.status}
        onClose={() => setDrawerVisible(false)}
        accessKey={draftKey}
        connectionBusy={connectionBusy}
        connectionError={connectionError}
        connectionMessage={connectionMessage}
        editingConnectionId={editingConnectionId}
        editingConnectionHasKey={Boolean(
          sessionState.connections.find((connection) => connection.id === editingConnectionId)?.accessKey,
        )}
        onRemoveConnection={removeEditingConnection}
        onAddConnection={addConnection}
        onEditConnection={editConnection}
        onSelectConnection={selectConnection}
        onCheckForUpdate={() => void checkForAppUpdate(false)}
        onDownloadUpdate={() => {
          if (mobileUpdateStatus.latest) {
            void installMobileUpdate(mobileUpdateStatus.latest);
          }
        }}
        onThemeModeChange={changeThemeMode}
        onOpenProjects={openProjectPicker}
        onNewThread={openNewThread}
        onPageChange={changeDrawerPage}
        onKeyChange={setDraftKey}
        onSaveConnection={() => void saveConnection()}
        onRefreshArchived={() => void loadArchived()}
        onSearchChange={setDrawerSearch}
        onRemoveProject={confirmRemoveProject}
        onSelectThread={selectThread}
        onThreadActions={openThreadActions}
        onToggleProject={toggleProject}
        page={drawerPage}
        projectPaths={projectDirectories.map((project) => project.path)}
        search={drawerSearch}
        selectedThreadId={selectedThreadId}
        selectedProjectPath={selectedProjectPath}
        threads={control.snapshot.threads}
        themeMode={themeMode}
        updateStatus={mobileUpdateStatus}
        visible={drawerVisible}
      />

      <ModelPickerSheet
        error={modelsError}
        loading={modelsLoading}
        models={models}
        onClose={() => setModelPickerVisible(false)}
        onRefresh={() => void loadModels()}
        onSelect={(model) => {
          setSelectedModel(model);
          setModelPickerVisible(false);
          if (taskClient && selectedThreadId) {
            void taskClient.setThreadModel(selectedThreadId, model)
              .then(() => control.refresh())
              .catch((error) => Alert.alert("无法保存模型选择", describeControlError(error)));
          }
        }}
        selectedModel={selectedModel}
        visible={modelPickerVisible}
      />

      <ProjectPickerSheet
        busy={newThreadBusy}
        error={newThreadError}
        onBrowseComputer={browseComputerDirectories}
        onClose={() => !newThreadBusy && setProjectPickerVisible(false)}
        onSelect={(projectPath) => void openProjectDirectory(projectPath)}
        onSubmitPath={openProjectDirectory}
        visible={projectPickerVisible}
      />

      <ThreadActionsSheet
        archived={Boolean(threadAction?.archived)}
        busy={threadActionBusy}
        error={threadActionError}
        onArchive={() => void runThreadMutation("archive")}
        onClose={() => !threadActionBusy && setThreadAction(null)}
        onDelete={confirmDeleteThread}
        onRename={(name) => void runThreadMutation("rename", name)}
        onUnarchive={() => void runThreadMutation("unarchive")}
        thread={threadAction?.thread || null}
        visible={Boolean(threadAction)}
      />
    </SafeAreaFrame>
  );
}

function SafeAreaFrame({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.safeArea, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {children}
    </View>
  );
}

function BootScreen({ message, error = false, onRetry, themeMode }: { message: string; error?: boolean; onRetry?: () => void; themeMode: ThemeMode }) {
  return (
    <View style={styles.boot}>
      <StatusBar style={themeMode === "dark" ? "light" : "dark"} />
      {error ? <Text style={styles.bootError}>{message}</Text> : (
        <>
          <ActivityIndicator color={colors.ink} size="small" />
          <Text style={styles.bootText}>{message}</Text>
        </>
      )}
      {onRetry && (
        <Pressable onPress={onRetry} style={({ pressed }) => [styles.retryButton, pressed && styles.retryPressed]}>
          <Text style={styles.retryText}>重试</Text>
        </Pressable>
      )}
    </View>
  );
}

function safeDownloadName(id: string, name: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48);
  const safeName = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 160) || "attachment";
  return `${safeId}-${safeName}`;
}

function isActive(thread: ThreadSummary): boolean {
  return ["running", "waiting_for_approval", "waiting_for_input"].includes(thread.status);
}

function isUnauthorized(error: unknown): error is ControlClientError {
  return error instanceof ControlClientError && error.code === "unauthorized";
}

function connectionErrorMessage(error: unknown): string {
  if (error instanceof ControlClientError) {
    if (error.code === "unauthorized") return "KEY 无效，请确认使用桌面端当前生成的 KEY。";
    if (error.code === "certificate") return "无法验证控制服务证书，请检查电脑端证书配置。";
    if (error.code === "offline" || error.code === "timeout") return "电脑当前离线，或无法连接公网中转服务。";
    return error.message;
  }
  return error instanceof Error ? error.message : "连接验证失败，请重试。";
}

const styles = createThemedStyles((colors) => ({
  safeArea: { flex: 1, backgroundColor: colors.canvas },
  boot: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 30, backgroundColor: colors.canvas },
  bootText: { color: colors.inkMuted, fontSize: 13, lineHeight: 18, marginTop: 12, textAlign: "center", letterSpacing: 0 },
  bootError: { color: colors.danger, fontSize: 13, lineHeight: 19, textAlign: "center", letterSpacing: 0 },
  retryButton: { height: 38, marginTop: 16, paddingHorizontal: 18, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.solid },
  retryPressed: { opacity: 0.8 },
  retryText: { color: colors.onSolid, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
}));
