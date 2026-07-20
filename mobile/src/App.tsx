import type { ProjectDirectory, RemoteModelOption, RemoteTurnAttachment, ThreadSummary, UserInputAnswers } from "@rhzycode/protocol";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
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
  type ThreadStartInput,
} from "./api/control-client";
import {
  buildControlUrl,
  defaultControlHost as builtInControlHost,
  defaultControlPort as builtInControlPort,
  normalizeAccessKey,
  normalizeControlHost,
  normalizeControlPort,
} from "./auth/control-access";
import { AppDrawer, type DrawerPage } from "./components/AppDrawer";
import { ChatScreen, type PendingMessage } from "./components/ChatScreen";
import { ModelPickerSheet } from "./components/ModelPickerSheet";
import { ProjectPickerSheet, ThreadActionsSheet } from "./components/TaskSheets";
import { describeControlError, useControlPlane } from "./hooks/use-control-plane";
import { createNativeSecureSessionStore } from "./storage/native-secure-session";
import type { MobileSession, MobileSessionState, SecureSessionStore } from "./storage/secure-session";
import { colors } from "./ui/theme";
import {
  defaultUpdateManifestUrl,
  fetchMobileUpdate,
  initialMobileUpdateStatus,
  type MobileUpdateStatus,
} from "./update/mobile-update";

const defaultControlHost = process.env.EXPO_PUBLIC_CONTROL_HOST || builtInControlHost;
const newConnectionHost = defaultControlHost === builtInControlHost ? "" : defaultControlHost;
const configuredControlPort = Number(process.env.EXPO_PUBLIC_CONTROL_PORT || builtInControlPort);
const defaultControlPort = Number.isInteger(configuredControlPort) ? configuredControlPort : builtInControlPort;
const currentAppVersion = Constants.expoConfig?.version || "0.0.0";
const updateManifestUrl = process.env.EXPO_PUBLIC_UPDATE_URL
  || String(Constants.expoConfig?.extra?.updateManifestUrl || defaultUpdateManifestUrl);

function isImageAttachment(name: string, mimeType?: string): boolean {
  if (mimeType?.toLowerCase().startsWith("image/")) return true;
  return /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(name);
}

interface ThreadActionTarget {
  thread: ThreadSummary;
  archived: boolean;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const [sessionStore] = useState<SecureSessionStore>(() => createNativeSecureSessionStore());
  const [sessionState, setSessionState] = useState<MobileSessionState>({
    connections: [],
    activeConnectionId: null,
  });
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [drawerPage, setDrawerPage] = useState<DrawerPage>("threads");
  const [drawerSearch, setDrawerSearch] = useState("");
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
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
  const [models, setModels] = useState<RemoteModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [archivedThreads, setArchivedThreads] = useState<ThreadSummary[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [threadAction, setThreadAction] = useState<ThreadActionTarget | null>(null);
  const [threadActionBusy, setThreadActionBusy] = useState(false);
  const [threadActionError, setThreadActionError] = useState<string | null>(null);
  const [draftHost, setDraftHost] = useState(newConnectionHost);
  const [draftPort, setDraftPort] = useState(String(defaultControlPort));
  const [draftKey, setDraftKey] = useState("");
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const [mobileUpdateStatus, setMobileUpdateStatus] = useState<MobileUpdateStatus>(initialMobileUpdateStatus);
  const announcedUpdateVersion = useRef<string | null>(null);
  const modelsLoadingRef = useRef(false);
  const modelSelectionContext = useRef("");
  const session = useMemo(
    () => sessionState.connections.find((connection) => connection.id === sessionState.activeConnectionId) || null,
    [sessionState],
  );

  const openUpdateDownload = useCallback(async (apkUrl: string) => {
    await Linking.openURL(apkUrl);
  }, []);

  const checkForAppUpdate = useCallback(async (announce: boolean) => {
    if (Platform.OS !== "android") return;
    setMobileUpdateStatus((current) => ({ state: "checking", latest: current.latest, error: null }));
    try {
      const status = await fetchMobileUpdate(currentAppVersion, { manifestUrl: updateManifestUrl });
      setMobileUpdateStatus(status);
      if (announce && status.state === "available" && announcedUpdateVersion.current !== status.latest.version) {
        announcedUpdateVersion.current = status.latest.version;
        Alert.alert(
          "发现新版本",
          `RHZYCODE ${status.latest.version} 已可下载。`,
          [
            { text: "稍后", style: "cancel" },
            { text: "下载更新", onPress: () => void openUpdateDownload(status.latest.apkUrl) },
          ],
        );
      }
    } catch (error) {
      setMobileUpdateStatus((current) => ({
        state: "error",
        latest: current.latest,
        error: error instanceof Error ? error.message : "无法检查更新。",
      }));
    }
  }, [openUpdateDownload]);

  useEffect(() => {
    if (Platform.OS !== "android") return undefined;
    const initialCheck = setTimeout(() => void checkForAppUpdate(true), 3_000);
    return () => clearTimeout(initialCheck);
  }, [checkForAppUpdate]);

  const loadSession = useCallback(async () => {
    setBooting(true);
    setBootError(null);
    try {
      const loaded = await sessionStore.load(defaultControlHost, defaultControlPort);
      const invalidConnectionIds: string[] = [];
      const connections = loaded.connections.map((connection) => {
        try {
          const normalized = {
            ...connection,
            host: normalizeControlHost(connection.host),
            port: normalizeControlPort(connection.port),
          };
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
      setDraftHost(active?.host || newConnectionHost);
      setDraftPort(String(active?.port || defaultControlPort));
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
        const connection = sessionState.connections.find((item) => item.id === connectionId);
        setConnectionError("保存的 KEY 已失效，请输入桌面端生成的新 KEY。");
        setConnectionMessage(null);
        setEditingConnectionId(connectionId);
        setDraftHost(connection?.host || newConnectionHost);
        setDraftPort(String(connection?.port || defaultControlPort));
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
      ? new ControlClient(session.host, session.port, session.accessKey)
      : null,
    [session?.accessKey, session?.host, session?.port],
  );
  const canWrite = Boolean(session?.accessKey);
  const canApprove = Boolean(session?.accessKey);

  useEffect(() => {
    setSelectedThreadId(null);
    setSelectedProjectPath(null);
    setProjectDirectories([]);
    setModels([]);
    setSelectedModel("");
    setModelPickerVisible(false);
    setModelsError(null);
    modelSelectionContext.current = "";
    setArchivedThreads([]);
    setPendingMessages([]);
    setDraft("");
    setThreadAction(null);
  }, [session?.id]);

  const loadProjects = useCallback(async () => {
    if (!taskClient) return;
    try {
      const result = await taskClient.listProjects();
      setProjectDirectories(result.projects);
    } catch (error) {
      if (isUnauthorized(error) && session) rejectCredentials(session.id);
    }
  }, [rejectCredentials, session, taskClient]);

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
    if (control.status !== "online") return undefined;
    void loadProjects();
    void loadModels();
    const interval = setInterval(() => void loadProjects(), 15_000);
    return () => clearInterval(interval);
  }, [control.status, loadModels, loadProjects]);

  useEffect(() => {
    if (selectedThreadId || !control.snapshot.threads.length) return;
    const preferred = [...control.snapshot.threads].sort((left, right) => {
      const activeDifference = Number(isActive(right)) - Number(isActive(left));
      return activeDifference || right.updatedAt.localeCompare(left.updatedAt);
    })[0];
    if (preferred) setSelectedThreadId(preferred.id);
    if (preferred) setSelectedProjectPath(preferred.projectPath);
  }, [control.snapshot.threads, selectedThreadId]);

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
    setPendingMessages((current) => current.filter((message) => !control.snapshot.timeline.some((item) => (
      item.threadId === message.threadId
      && item.kind === "user"
      && item.content.trim() === message.content.trim()
    ))));
  }, [control.snapshot.timeline, pendingMessages.length]);

  const selectedThread = useMemo(
    () => control.snapshot.threads.find((thread) => thread.id === selectedThreadId)
      || archivedThreads.find((thread) => thread.id === selectedThreadId)
      || null,
    [archivedThreads, control.snapshot.threads, selectedThreadId],
  );
  const selectedIsArchived = Boolean(archivedThreads.some((thread) => thread.id === selectedThreadId));
  const recentProjects = useMemo(
    () => uniqueProjects(control.snapshot.threads, projectDirectories.map((project) => project.path)),
    [control.snapshot.threads, projectDirectories],
  );
  const selectedModelOption = useMemo(
    () => models.find((model) => model.model === selectedModel) || null,
    [models, selectedModel],
  );

  const openProjectDirectory = useCallback(async (projectPath: string, create = false): Promise<string | null> => {
    if (!taskClient) return null;
    setNewThreadError(null);
    try {
      const result = await taskClient.openProject(projectPath, create);
      setProjectDirectories((current) => [
        result.project,
        ...current.filter((project) => project.path !== result.project.path),
      ]);
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
    }
  }, [rejectCredentials, session, taskClient]);

  const createThread = useCallback(async (input: ThreadStartInput) => {
    if (!taskClient || newThreadBusy) return;
    setNewThreadBusy(true);
    setNewThreadError(null);
    try {
      const request = selectedModel ? { ...input, model: selectedModel } : input;
      const result = await taskClient.startThread(request);
      setSelectedThreadId(result.threadId);
      setSelectedProjectPath(request.projectPath);
      setDraft("");
      setProjectPickerVisible(false);
      await control.refresh();
    } catch (error) {
      if (error instanceof ControlClientError && error.code === "not_found") {
        setNewThreadError("电脑上不存在该工程目录，请重新选择目录。");
        setProjectPickerVisible(true);
      } else if (error instanceof ControlClientError && error.code === "invalid_request") {
        setNewThreadError("请选择电脑上的绝对工程目录路径。");
        setProjectPickerVisible(true);
      } else {
        Alert.alert("无法创建对话", describeControlError(error));
      }
    } finally {
      setNewThreadBusy(false);
    }
  }, [control, newThreadBusy, selectedModel, taskClient]);

  const openNewThread = useCallback(() => {
    setDrawerVisible(false);
    setNewThreadError(null);
    if (!session?.accessKey) {
      setEditingConnectionId(session?.id || null);
      setDraftHost(session?.host || newConnectionHost);
      setDraftPort(String(session?.port || defaultControlPort));
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
    const projectPath = selectedProjectPath || selectedThread?.projectPath || recentProjects[0];
    if (!projectPath) {
      void loadProjects();
      setProjectPickerVisible(true);
      return;
    }
    void createThread({
      projectPath,
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
    });
  }, [canWrite, createThread, loadProjects, recentProjects, selectedProjectPath, selectedThread?.projectPath, session]);

  const openProjectPicker = useCallback(() => {
    setNewThreadError(null);
    setDrawerVisible(false);
    void loadProjects();
    setProjectPickerVisible(true);
  }, [loadProjects]);

  const sendMessage = useCallback(async () => {
    const content = draft.trim();
    if (!taskClient || !selectedThreadId || (!content && !attachments.length) || sending || selectedIsArchived) return;
    const submittedAttachments = attachments;
    const submittedText = content || "Review the attached files.";
    const id = Crypto.randomUUID();
    const pending: PendingMessage = {
      id,
      threadId: selectedThreadId,
      content: submittedText,
      createdAt: new Date().toISOString(),
      state: "sending",
    };
    setPendingMessages((current) => [...current, pending]);
    setDraft("");
    setAttachments([]);
    setSending(true);
    try {
      await taskClient.startTurn(selectedThreadId, {
        text: submittedText,
        attachments: submittedAttachments,
        ...(selectedModel ? { model: selectedModel } : {}),
      });
      await control.refresh();
    } catch (error) {
      setPendingMessages((current) => current.map((message) => (
        message.id === id ? { ...message, state: "failed" } : message
      )));
      setDraft((current) => current || content);
      setAttachments((current) => current.length ? current : submittedAttachments);
      if (isUnauthorized(error) && session) rejectCredentials(session.id);
    } finally {
      setSending(false);
    }
  }, [attachments, control, draft, rejectCredentials, selectedIsArchived, selectedModel, selectedThreadId, sending, session, taskClient]);

  const chooseAttachments = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
      if (result.canceled) return;
      const available = Math.max(0, 20 - attachments.length);
      const selected = result.assets.slice(0, available);
      const knownSize = attachments.reduce((sum, attachment) => sum + attachment.size, 0)
        + selected.reduce((sum, asset) => sum + (asset.size || 0), 0);
      if (knownSize > 25 * 1024 * 1024) throw new Error("Attachments can contain at most 25 MB per message.");
      const loaded: RemoteTurnAttachment[] = [];
      for (const asset of selected) {
        const file = new File(asset.uri);
        const size = asset.size || file.size;
        if (!size) throw new Error(`${asset.name} is empty.`);
        loaded.push({
          name: asset.name,
          kind: isImageAttachment(asset.name, asset.mimeType) ? "image" : "file",
          size,
          dataBase64: asset.base64 || await file.base64(),
        });
      }
      const totalSize = attachments.reduce((sum, attachment) => sum + attachment.size, 0)
        + loaded.reduce((sum, attachment) => sum + attachment.size, 0);
      if (totalSize > 25 * 1024 * 1024) throw new Error("Attachments can contain at most 25 MB per message.");
      setAttachments((current) => [...current, ...loaded]);
    } catch (error) {
      Alert.alert("Unable to attach files", error instanceof Error ? error.message : "File selection failed.");
    }
  }, [attachments]);

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
    setSelectedProjectPath(thread.projectPath);
    setDraft("");
    setDrawerVisible(false);
  }, []);

  const openThreadActions = useCallback((thread: ThreadSummary, archived: boolean) => {
    setThreadAction({ thread, archived });
    setThreadActionError(null);
    setDrawerVisible(false);
  }, []);

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
      if (action !== "rename" && selectedThreadId === threadAction.thread.id) setSelectedThreadId(null);
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
    let host: string;
    let port: number;
    let accessKey: string;
    const editingConnection = sessionState.connections.find((connection) => connection.id === editingConnectionId);
    try {
      host = normalizeControlHost(draftHost);
      port = normalizeControlPort(draftPort);
      accessKey = normalizeAccessKey(draftKey || editingConnection?.accessKey || "");
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "连接配置无效。");
      return;
    }
    setConnectionBusy(true);
    setConnectionError(null);
    setConnectionMessage(null);
    try {
      await verifyControlAccess({ host, port, accessKey });
      const next = await sessionStore.saveConnection({ id: editingConnectionId || undefined, host, port, accessKey });
      setSessionState(next);
      setDraftHost(host);
      setDraftPort(String(port));
      setDraftKey("");
      setEditingConnectionId(next.activeConnectionId);
      setConnectionMessage("电脑地址和 KEY 已安全保存，后台连接已启动。");
      setDrawerPage("threads");
      setDrawerVisible(false);
    } catch (error) {
      setConnectionError(connectionErrorMessage(error));
    } finally {
      setConnectionBusy(false);
    }
  }, [draftHost, draftKey, draftPort, editingConnectionId, sessionState.connections, sessionStore]);

  const addConnection = useCallback(() => {
    setEditingConnectionId(null);
    setDraftHost(newConnectionHost);
    setDraftPort(String(defaultControlPort));
    setDraftKey("");
    setConnectionError(null);
    setConnectionMessage(null);
    setDrawerPage("connection");
  }, []);

  const editActiveConnection = useCallback(() => {
    setEditingConnectionId(session?.id || null);
    setDraftHost(session?.host || newConnectionHost);
    setDraftPort(String(session?.port || defaultControlPort));
    setDraftKey("");
    setConnectionError(null);
    setConnectionMessage(null);
    setDrawerPage("connection");
  }, [session]);

  const selectConnection = useCallback((connectionId: string) => {
    const target = sessionState.connections.find((connection) => connection.id === connectionId);
    if (!target) return;
    if (connectionId === sessionState.activeConnectionId) {
      if (target.accessKey) setDrawerPage("threads");
      else {
        setEditingConnectionId(target.id);
        setDraftHost(target.host);
        setDraftPort(String(target.port));
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
        setDraftHost(target.host);
        setDraftPort(String(target.port));
        setDraftKey("");
        setDrawerPage("connection");
      }
    }).catch(() => setConnectionError("无法切换电脑，请重试。"));
  }, [sessionState.activeConnectionId, sessionState.connections, sessionStore]);

  const forgetCredentials = useCallback(() => {
    if (!session) return;
    Alert.alert(
      "移除此电脑？",
      `将从手机中移除 ${session.host}:${session.port} 及其保存的 KEY，不会影响其他电脑。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "移除",
          style: "destructive",
          onPress: () => {
            void sessionStore.removeConnection(session.id).then((next) => {
              setSessionState(next);
              setSelectedThreadId(null);
              setConnectionMessage(null);
              setDraftKey("");
              if (next.activeConnectionId) {
                setDrawerPage("computers");
              } else {
                setEditingConnectionId(null);
                setDraftHost(newConnectionHost);
                setDraftPort(String(defaultControlPort));
                setDrawerPage("connection");
              }
            }).catch(() => setConnectionError("无法移除此电脑，请重试。"));
          },
        },
      ],
    );
  }, [session, sessionStore]);

  if (booting) return <BootScreen message="正在恢复安全会话…" />;
  if (bootError) {
    return <BootScreen error message={bootError || "无法启动移动端。"} onRetry={() => void loadSession()} />;
  }

  return (
    <SafeAreaFrame>
      <StatusBar style="dark" />
      <ChatScreen
        attachments={attachments}
        approvalOperations={control.approvalOperations}
        approvals={control.snapshot.approvals}
        canApprove={canApprove}
        canWrite={canWrite && !selectedIsArchived}
        connectionNotice={control.notice}
        connectionStatus={control.status}
        draft={draft}
        inputBusyId={inputBusyId}
        interrupting={interrupting}
        onApproval={(id, decision) => void control.resolveApproval(id, decision)}
        onAttach={() => void chooseAttachments()}
        onDraftChange={setDraft}
        onInterrupt={() => void interruptTurn()}
        onNewThread={openNewThread}
        onNoticePress={() => {
          if (control.status === "needs_configuration") {
            setEditingConnectionId(session?.id || null);
            setDraftHost(session?.host || newConnectionHost);
            setDraftPort(String(session?.port || defaultControlPort));
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
        onRefresh={() => void control.refresh()}
        onSend={() => void sendMessage()}
        onRemoveAttachment={(index) => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
        onSubmitInput={(id, answers) => void submitUserInput(id, answers)}
        pendingMessages={pendingMessages}
        modelPickerEnabled={Boolean(taskClient && control.status === "online")}
        refreshing={control.refreshing}
        selectedModelLabel={selectedModelOption?.displayName || null}
        selectedThreadId={selectedThreadId}
        sending={sending}
        thread={selectedThread}
        timeline={control.snapshot.timeline}
        userInputs={control.snapshot.userInputs}
      />

      <AppDrawer
        appVersion={currentAppVersion}
        archivedLoading={archivedLoading}
        archivedThreads={archivedThreads}
        activeConnectionId={sessionState.activeConnectionId}
        canManageThreads={canWrite}
        connections={sessionState.connections}
        connectionStates={control.connectionStates}
        connectionStatus={control.status}
        draftHost={draftHost}
        draftPort={draftPort}
        onClose={() => setDrawerVisible(false)}
        accessKey={draftKey}
        connectionBusy={connectionBusy}
        connectionError={connectionError}
        connectionMessage={connectionMessage}
        editingConnectionHasKey={Boolean(
          sessionState.connections.find((connection) => connection.id === editingConnectionId)?.accessKey,
        )}
        onForget={forgetCredentials}
        onAddConnection={addConnection}
        onEditActiveConnection={editActiveConnection}
        onSelectConnection={selectConnection}
        onCheckForUpdate={() => void checkForAppUpdate(false)}
        onDownloadUpdate={() => {
          if (mobileUpdateStatus.state === "available") {
            void openUpdateDownload(mobileUpdateStatus.latest.apkUrl);
          }
        }}
        onOpenProjects={openProjectPicker}
        onPageChange={changeDrawerPage}
        onKeyChange={setDraftKey}
        onSaveConnection={() => void saveConnection()}
        onRefreshArchived={() => void loadArchived()}
        onSearchChange={setDrawerSearch}
        onSelectProject={setSelectedProjectPath}
        onSelectThread={selectThread}
        onThreadActions={openThreadActions}
        onHostChange={setDraftHost}
        onPortChange={setDraftPort}
        page={drawerPage}
        projectPaths={projectDirectories.map((project) => project.path)}
        search={drawerSearch}
        selectedThreadId={selectedThreadId}
        selectedProjectPath={selectedProjectPath}
        session={session}
        threads={control.snapshot.threads}
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
        }}
        selectedModel={selectedModel}
        visible={modelPickerVisible}
      />

      <ProjectPickerSheet
        busy={newThreadBusy}
        error={newThreadError}
        onClose={() => !newThreadBusy && setProjectPickerVisible(false)}
        onSelect={(projectPath) => {
          setSelectedProjectPath(projectPath);
          setProjectPickerVisible(false);
        }}
        onSubmitPath={openProjectDirectory}
        projects={recentProjects}
        selectedProject={selectedProjectPath}
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

function BootScreen({ message, error = false, onRetry }: { message: string; error?: boolean; onRetry?: () => void }) {
  return (
    <View style={styles.boot}>
      <StatusBar style="dark" />
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

function uniqueProjects(threads: ThreadSummary[], additionalPaths: string[] = []): string[] {
  return [...new Set(
    [
      ...additionalPaths,
      ...[...threads]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((thread) => thread.projectPath),
    ].map((projectPath) => projectPath.trim()).filter(Boolean),
  )].slice(0, 50);
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
    if (error.code === "offline" || error.code === "timeout") return "无法连接服务，请检查地址、端口和网络。";
    return error.message;
  }
  return error instanceof Error ? error.message : "连接验证失败，请重试。";
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.canvas },
  boot: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 30, backgroundColor: colors.canvas },
  bootText: { color: colors.inkMuted, fontSize: 13, lineHeight: 18, marginTop: 12, textAlign: "center", letterSpacing: 0 },
  bootError: { color: colors.danger, fontSize: 13, lineHeight: 19, textAlign: "center", letterSpacing: 0 },
  retryButton: { height: 38, marginTop: 16, paddingHorizontal: 18, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink },
  retryPressed: { opacity: 0.8 },
  retryText: { color: colors.inverse, fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0 },
});
