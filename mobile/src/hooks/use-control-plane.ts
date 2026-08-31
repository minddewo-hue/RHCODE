import type { ControlSnapshot, RemoteThreadOpenResult } from "@rhzycode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  appConnectionAction,
  getSnapshotWithRetry,
  heartbeatPingFrame,
  heartbeatPongId,
  incomingSequenceAction,
  reconnectDelay,
  webSocketConnectTimeoutMs,
  webSocketHeartbeatIntervalMs,
  webSocketHeartbeatTimeoutMs,
} from "../api/control-connection-model";
import { ControlClient, ControlClientError } from "../api/control-client";
import type { MobileSession } from "../storage/secure-session";
import {
  applyAgentEvent,
  emptyControlSnapshot,
  hydrateThreadSnapshot,
  mergeControlSnapshot,
} from "../state/control-reducer";

export type ConnectionStatus = "connecting" | "online" | "offline" | "needs_configuration";

export interface ApprovalOperation {
  busy: boolean;
  message?: string;
  tone?: "error" | "info";
}

export interface ControlPlaneConnectionState {
  snapshot: ControlSnapshot;
  status: ConnectionStatus;
  notice: string | null;
  refreshing: boolean;
  approvalOperations: Record<string, ApprovalOperation>;
}

interface UseControlPlaneOptions {
  sessions: MobileSession[];
  activeConnectionId: string | null;
  onCredentialsRejected: (connectionId: string) => void;
}

interface RuntimeConnection {
  client: ControlClient;
  lastSequence: number;
  streamId: string | null;
  snapshotPromise: Promise<ControlSnapshot> | null;
  socket: WebSocket | null;
  socketOpen: boolean;
  connecting: boolean;
  pause: (() => void) | null;
  resume: (() => void) | null;
  reconnect: (() => void) | null;
  resync: (() => void) | null;
}

export function useControlPlane({
  sessions,
  activeConnectionId,
  onCredentialsRejected,
}: UseControlPlaneOptions) {
  const [connectionStates, setConnectionStates] = useState<Record<string, ControlPlaneConnectionState>>({});
  const [connectionKick, setConnectionKick] = useState(0);
  const runtimeConnections = useRef(new Map<string, RuntimeConnection>());
  const appState = useRef(AppState.currentState);
  const approvalBusy = useRef(new Map<string, Set<string>>());
  const configuredSessions = useRef<Record<string, string>>({});
  const credentialsRejected = useRef(onCredentialsRejected);
  credentialsRejected.current = onCredentialsRejected;

  const sessionSignature = JSON.stringify(sessions.map(({ id, accessKey }) => [id, accessKey]));
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeConnectionId) || null,
    [activeConnectionId, sessionSignature],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const action = appConnectionAction(appState.current, next);
      appState.current = next;
      for (const runtime of runtimeConnections.current.values()) {
        if (action === "pause") runtime.pause?.();
        if (action === "resume") runtime.resume?.();
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const nextConfiguredSessions = Object.fromEntries(sessions.map((session) => [
      session.id,
      session.accessKey,
    ]));
    setConnectionStates((current) => Object.fromEntries(sessions.map((session) => {
      const previous = configuredSessions.current[session.id] === nextConfiguredSessions[session.id]
        ? current[session.id]
        : undefined;
      if (previous) {
        return [session.id, {
          ...previous,
          status: session.accessKey ? previous.status : "needs_configuration",
        }];
      }
      return [session.id, createConnectionState(session.accessKey ? "connecting" : "needs_configuration")];
    })));
    configuredSessions.current = nextConfiguredSessions;

    runtimeConnections.current.clear();
    approvalBusy.current.clear();

    let disposed = false;
    const cleanups: Array<() => void> = [];

    for (const session of sessions) {
      if (!session.accessKey) continue;
      const client = new ControlClient(session.accessKey);
      const runtime: RuntimeConnection = {
        client,
        lastSequence: 0,
        streamId: null,
        snapshotPromise: null,
        socket: null,
        socketOpen: false,
        connecting: false,
        pause: null,
        resume: null,
        reconnect: null,
        resync: null,
      };
      runtimeConnections.current.set(session.id, runtime);
      approvalBusy.current.set(session.id, new Set());

      let stopped = false;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let socketConnectTimer: ReturnType<typeof setTimeout> | null = null;
      let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
      let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
      let pendingHeartbeatId: string | null = null;
      let heartbeatSequence = 0;
      let reconnectAttempt = 0;
      let paused = appState.current !== "active";
      let connectionGeneration = 0;

      const clearSocketConnectTimer = () => {
        if (!socketConnectTimer) return;
        clearTimeout(socketConnectTimer);
        socketConnectTimer = null;
      };

      const update = (value: Partial<ControlPlaneConnectionState> | ((current: ControlPlaneConnectionState) => ControlPlaneConnectionState)) => {
        setConnectionStates((current) => {
          const previous = current[session.id] || createConnectionState("connecting");
          const next = typeof value === "function" ? value(previous) : { ...previous, ...value };
          return { ...current, [session.id]: next };
        });
      };

      const scheduleReconnect = () => {
        if (disposed || stopped || paused || reconnectTimer || runtime.connecting) return;
        runtime.socketOpen = false;
        update({ status: "offline" });
        const delay = reconnectDelay(reconnectAttempt++);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void synchronize();
        }, delay);
      };
      runtime.reconnect = scheduleReconnect;

      const loadSnapshot = (): Promise<ControlSnapshot> => {
        if (runtime.snapshotPromise) return runtime.snapshotPromise;
        const request = getSnapshotWithRetry(client);
        runtime.snapshotPromise = request;
        void request.finally(() => {
          if (runtime.snapshotPromise === request) runtime.snapshotPromise = null;
        }).catch(() => undefined);
        return request;
      };

      const acceptSnapshotCursor = (snapshot: ControlSnapshot) => {
        const streamChanged = Boolean(
          snapshot.streamId && runtime.streamId && snapshot.streamId !== runtime.streamId,
        );
        runtime.lastSequence = streamChanged
          ? snapshot.lastSequence
          : Math.max(runtime.lastSequence, snapshot.lastSequence);
        runtime.streamId = snapshot.streamId || runtime.streamId;
      };

      const resyncSnapshot = async () => {
        if (disposed || stopped || paused) return;
        const generation = connectionGeneration;
        try {
          const next = await loadSnapshot();
          if (disposed || stopped || paused || generation !== connectionGeneration) return;
          acceptSnapshotCursor(next);
          update((current) => ({
            ...current,
            snapshot: mergeControlSnapshot(current.snapshot, next),
            notice: null,
            ...(runtime.socketOpen ? { status: "online" as const } : {}),
          }));
        } catch (error) {
          if (disposed || stopped || paused || generation !== connectionGeneration) return;
          if (isUnauthorized(error)) {
            stopped = true;
            update({ status: "needs_configuration", notice: describeControlError(error) });
            credentialsRejected.current(session.id);
            return;
          }
          // Keep the existing timeline visible; reconnect handles hard failures.
          update({ notice: describeControlError(error) });
          if (!runtime.socketOpen) scheduleReconnect();
        }
      };
      runtime.resync = () => { void resyncSnapshot(); };

      const clearHeartbeatTimers = () => {
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
        heartbeatTimer = null;
        heartbeatTimeout = null;
        pendingHeartbeatId = null;
      };

      function scheduleHeartbeat(socket: WebSocket) {
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        heartbeatTimer = setTimeout(() => sendHeartbeat(socket), webSocketHeartbeatIntervalMs);
      }

      function sendHeartbeat(socket: WebSocket) {
        if (disposed || stopped || runtime.socket !== socket || !runtime.socketOpen) return;
        if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
        const id = `heartbeat-${Date.now().toString(36)}-${(++heartbeatSequence).toString(36)}`;
        pendingHeartbeatId = id;
        try {
          socket.send(heartbeatPingFrame(id));
        } catch {
          socket.close();
          return;
        }
        heartbeatTimeout = setTimeout(() => {
          heartbeatTimeout = null;
          if (appState.current !== "active" || pendingHeartbeatId !== id || runtime.socket !== socket) return;
          update({ notice: "连接心跳超时，正在重连。" });
          socket.close();
        }, webSocketHeartbeatTimeoutMs);
        scheduleHeartbeat(socket);
      }

      function acceptHeartbeat(value: unknown): boolean {
        const id = heartbeatPongId(value);
        if (!id) return false;
        if (id === pendingHeartbeatId) {
          pendingHeartbeatId = null;
          if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
          heartbeatTimeout = null;
        }
        return true;
      }

      const synchronize = async () => {
        if (disposed || stopped || paused || runtime.connecting) return;
        const generation = connectionGeneration;
        runtime.connecting = true;
        update({ status: "connecting", notice: null });
        try {
          const next = await loadSnapshot();
          if (disposed || stopped || paused || generation !== connectionGeneration) return;
          acceptSnapshotCursor(next);
          update((current) => ({
            ...current,
            snapshot: mergeControlSnapshot(current.snapshot, next),
            notice: null,
          }));
        } catch (error) {
          if (disposed || stopped || paused || generation !== connectionGeneration) return;
          if (isUnauthorized(error)) {
            runtime.connecting = false;
            stopped = true;
            update({ status: "needs_configuration", notice: describeControlError(error) });
            credentialsRejected.current(session.id);
            return;
          }
          runtime.connecting = false;
          update({ notice: describeControlError(error) });
          scheduleReconnect();
          return;
        }

        const descriptor = client.eventSocket(runtime.lastSequence);
        const socket = new WebSocket(descriptor.url, descriptor.protocols);
        runtime.socket = socket;
        socketConnectTimer = setTimeout(() => {
          if (disposed || stopped || runtime.socket !== socket || runtime.socketOpen) return;
          socketConnectTimer = null;
          runtime.connecting = false;
          runtime.socket = null;
          update({ notice: "实时连接超时，正在重试。" });
          try {
            socket.close();
          } catch {
            // The reconnect below replaces sockets that cannot be closed while connecting.
          }
          scheduleReconnect();
        }, webSocketConnectTimeoutMs);
        socket.onopen = () => {
          if (runtime.socket !== socket) {
            socket.close();
            return;
          }
          clearSocketConnectTimer();
          if (disposed || stopped || paused) {
            socket.close();
            return;
          }
          reconnectAttempt = 0;
          runtime.connecting = false;
          runtime.socketOpen = true;
          update({ status: "online", notice: null });
          sendHeartbeat(socket);
          // Cover the race between the pre-socket snapshot and the first event frame
          // so completed assistant replies are not stuck missing on flaky links.
          void resyncSnapshot();
        };
        socket.onmessage = (message) => {
          if (disposed || stopped || runtime.socket !== socket) return;
          if (acceptHeartbeat(String(message.data))) return;
          try {
            const frame = client.parseSocketFrame(String(message.data));
            if (frame.type === "control.sync") {
              const streamChanged = Boolean(runtime.streamId && runtime.streamId !== frame.streamId);
              const replayUnavailable = runtime.lastSequence < frame.earliestReplaySequence - 1
                && runtime.lastSequence < frame.lastSequence;
              if (streamChanged || replayUnavailable) {
                update({ notice: "实时数据版本已变化，正在重新同步。" });
                socket.close();
                return;
              }
              runtime.streamId = frame.streamId;
              return;
            }
            const event = frame;
            const sequenceAction = incomingSequenceAction(runtime.lastSequence, event.sequence);
            if (sequenceAction === "duplicate") return;
            if (sequenceAction === "gap") {
              update({ notice: "检测到实时数据缺口，正在重新同步。" });
              socket.close();
              return;
            }
            runtime.lastSequence = event.sequence;
            update((current) => ({
              ...current,
              snapshot: applyAgentEvent(current.snapshot, event),
              approvalOperations: event.type === "approval.resolved"
                ? omitKey(current.approvalOperations, event.approvalId)
                : current.approvalOperations,
            }));
          } catch (error) {
            update({ notice: describeControlError(error) });
            socket.close();
          }
        };
        socket.onerror = () => socket.close();
        socket.onclose = () => {
          if (runtime.socket !== socket) return;
          clearSocketConnectTimer();
          clearHeartbeatTimers();
          if (disposed || stopped) return;
          runtime.connecting = false;
          runtime.socketOpen = false;
          runtime.socket = null;
          scheduleReconnect();
        };
      };

      const closeRealtimeConnection = () => {
        connectionGeneration += 1;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        clearSocketConnectTimer();
        clearHeartbeatTimers();
        runtime.connecting = false;
        runtime.socketOpen = false;
        runtime.snapshotPromise = null;
        const socket = runtime.socket;
        runtime.socket = null;
        try {
          socket?.close();
        } catch {
          // A connecting React Native socket can already be detached by the OS.
        }
      };

      runtime.pause = () => {
        if (disposed || stopped || paused) return;
        paused = true;
        closeRealtimeConnection();
        update({ status: "offline", notice: null });
      };
      runtime.resume = () => {
        if (disposed || stopped) return;
        paused = false;
        reconnectAttempt = 0;
        closeRealtimeConnection();
        void synchronize();
      };

      void synchronize();
      cleanups.push(() => {
        stopped = true;
        closeRealtimeConnection();
        runtime.pause = null;
        runtime.resume = null;
        runtime.reconnect = null;
        runtime.resync = null;
      });
    }

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      runtimeConnections.current.clear();
      approvalBusy.current.clear();
    };
  }, [connectionKick, sessionSignature]);

  const activeState = activeConnectionId
    ? connectionStates[activeConnectionId] || createConnectionState(activeSession?.accessKey ? "connecting" : "needs_configuration")
    : createConnectionState("needs_configuration");

  const refresh = useCallback(async () => {
    if (!activeSession?.accessKey) return;
    const runtime = runtimeConnections.current.get(activeSession.id);
    const client = runtime?.client || new ControlClient(activeSession.accessKey);
    updateConnectionState(setConnectionStates, activeSession.id, {
      refreshing: true,
      ...(!runtime?.socketOpen ? { status: "connecting" as const, notice: null } : {}),
    });
    try {
      const request = runtime?.snapshotPromise || getSnapshotWithRetry(client);
      if (runtime && !runtime.snapshotPromise) {
        runtime.snapshotPromise = request;
        void request.finally(() => {
          if (runtime.snapshotPromise === request) runtime.snapshotPromise = null;
        }).catch(() => undefined);
      }
      const next = await request;
      if (runtime) {
        const streamChanged = Boolean(next.streamId && runtime.streamId && next.streamId !== runtime.streamId);
        runtime.lastSequence = streamChanged
          ? next.lastSequence
          : Math.max(runtime.lastSequence, next.lastSequence);
        runtime.streamId = next.streamId || runtime.streamId;
      }
      updateConnectionState(setConnectionStates, activeSession.id, (current) => ({
        ...current,
        snapshot: mergeControlSnapshot(current.snapshot, next),
        notice: null,
      }));
      if (!runtime?.socketOpen) setConnectionKick((value) => value + 1);
    } catch (error) {
      if (isUnauthorized(error)) {
        updateConnectionState(setConnectionStates, activeSession.id, { status: "needs_configuration" });
        credentialsRejected.current(activeSession.id);
      } else {
        updateConnectionState(setConnectionStates, activeSession.id, { status: "offline" });
      }
      updateConnectionState(setConnectionStates, activeSession.id, { notice: describeControlError(error) });
    } finally {
      updateConnectionState(setConnectionStates, activeSession.id, { refreshing: false });
    }
  }, [activeSession]);

  const resolveApproval = useCallback(async (
    approvalId: string,
    decision: "approved" | "declined",
  ) => {
    if (!activeSession?.accessKey) return;
    const busy = approvalBusy.current.get(activeSession.id) || new Set<string>();
    if (busy.has(approvalId)) return;
    approvalBusy.current.set(activeSession.id, busy);
    busy.add(approvalId);
    updateConnectionState(setConnectionStates, activeSession.id, (current) => ({
      ...current,
      approvalOperations: { ...current.approvalOperations, [approvalId]: { busy: true } },
    }));
    const runtime = runtimeConnections.current.get(activeSession.id);
    const client = runtime?.client || new ControlClient(activeSession.accessKey);
    try {
      const event = await client.resolveApproval(approvalId, decision);
      updateConnectionState(setConnectionStates, activeSession.id, (current) => ({
        ...current,
        snapshot: {
          ...current.snapshot,
          approvals: current.snapshot.approvals.filter((approval) => approval.id !== event.approvalId),
        },
        approvalOperations: omitKey(current.approvalOperations, approvalId),
      }));
      runtime?.resync?.();
    } catch (error) {
      if (error instanceof ControlClientError && error.code === "not_found") {
        updateConnectionState(setConnectionStates, activeSession.id, (current) => ({
          ...current,
          approvalOperations: {
            ...current.approvalOperations,
            [approvalId]: { busy: false, message: "此审批已由其他客户端处理，正在同步。", tone: "info" },
          },
        }));
        await refresh();
        return;
      }
      if (isUnauthorized(error)) {
        updateConnectionState(setConnectionStates, activeSession.id, { status: "needs_configuration" });
        credentialsRejected.current(activeSession.id);
      }
      updateConnectionState(setConnectionStates, activeSession.id, (current) => ({
        ...current,
        approvalOperations: {
          ...current.approvalOperations,
          [approvalId]: { busy: false, message: describeControlError(error), tone: "error" },
        },
      }));
    } finally {
      busy.delete(approvalId);
    }
  }, [activeSession, refresh]);

  const hydrateThread = useCallback((result: RemoteThreadOpenResult) => {
    if (!activeSession) return;
    updateConnectionState(setConnectionStates, activeSession.id, (current) => ({
      ...current,
      snapshot: hydrateThreadSnapshot(current.snapshot, result),
    }));
  }, [activeSession]);

  return {
    ...activeState,
    connectionStates,
    refresh,
    hydrateThread,
    resolveApproval,
  };
}

export function describeControlError(error: unknown): string {
  if (error instanceof ControlClientError) return error.message;
  return "控制服务发生未知错误。";
}

function createConnectionState(status: ConnectionStatus): ControlPlaneConnectionState {
  return {
    snapshot: emptyControlSnapshot,
    status,
    notice: null,
    refreshing: false,
    approvalOperations: {},
  };
}

function updateConnectionState(
  setter: React.Dispatch<React.SetStateAction<Record<string, ControlPlaneConnectionState>>>,
  connectionId: string,
  value: Partial<ControlPlaneConnectionState> | ((current: ControlPlaneConnectionState) => ControlPlaneConnectionState),
) {
  setter((current) => {
    const previous = current[connectionId] || createConnectionState("connecting");
    const next = typeof value === "function" ? value(previous) : { ...previous, ...value };
    return { ...current, [connectionId]: next };
  });
}

function isUnauthorized(error: unknown): error is ControlClientError {
  return error instanceof ControlClientError && error.code === "unauthorized";
}

function omitKey<T>(value: Record<string, T>, key: string): Record<string, T> {
  const next = { ...value };
  delete next[key];
  return next;
}
