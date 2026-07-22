import type { ControlSnapshot, RemoteThreadOpenResult } from "@rhzycode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { ControlClient, ControlClientError } from "../api/control-client";
import type { MobileSession } from "../storage/secure-session";
import { applyAgentEvent, emptyControlSnapshot, hydrateThreadSnapshot } from "../state/control-reducer";

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
  socket: WebSocket | null;
  socketOpen: boolean;
}

export function useControlPlane({
  sessions,
  activeConnectionId,
  onCredentialsRejected,
}: UseControlPlaneOptions) {
  const [connectionStates, setConnectionStates] = useState<Record<string, ControlPlaneConnectionState>>({});
  const [appActive, setAppActive] = useState(AppState.currentState !== "background");
  const [connectionKick, setConnectionKick] = useState(0);
  const runtimeConnections = useRef(new Map<string, RuntimeConnection>());
  const approvalBusy = useRef(new Map<string, Set<string>>());
  const configuredSessions = useRef<Record<string, string>>({});
  const credentialsRejected = useRef(onCredentialsRejected);
  credentialsRejected.current = onCredentialsRejected;

  const sessionSignature = JSON.stringify(sessions.map(({ id, host, port, accessKey }) => [id, host, port, accessKey]));
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeConnectionId) || null,
    [activeConnectionId, sessionSignature],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => setAppActive(next === "active"));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const nextConfiguredSessions = Object.fromEntries(sessions.map((session) => [
      session.id,
      `${session.host}\n${session.port}\n${session.accessKey}`,
    ]));
    setConnectionStates((current) => Object.fromEntries(sessions.map((session) => {
      const previous = configuredSessions.current[session.id] === nextConfiguredSessions[session.id]
        ? current[session.id]
        : undefined;
      if (previous) {
        return [session.id, {
          ...previous,
          status: session.accessKey
            ? appActive ? previous.status : "offline"
            : "needs_configuration",
        }];
      }
      return [session.id, createConnectionState(session.accessKey ? "connecting" : "needs_configuration")];
    })));
    configuredSessions.current = nextConfiguredSessions;

    runtimeConnections.current.clear();
    approvalBusy.current.clear();
    if (!appActive) return undefined;

    let disposed = false;
    const cleanups: Array<() => void> = [];

    for (const session of sessions) {
      if (!session.accessKey) continue;
      const client = new ControlClient(session.host, session.port, session.accessKey);
      const runtime: RuntimeConnection = {
        client,
        lastSequence: 0,
        socket: null,
        socketOpen: false,
      };
      runtimeConnections.current.set(session.id, runtime);
      approvalBusy.current.set(session.id, new Set());

      let stopped = false;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let reconnectAttempt = 0;

      const update = (value: Partial<ControlPlaneConnectionState> | ((current: ControlPlaneConnectionState) => ControlPlaneConnectionState)) => {
        setConnectionStates((current) => {
          const previous = current[session.id] || createConnectionState("connecting");
          const next = typeof value === "function" ? value(previous) : { ...previous, ...value };
          return { ...current, [session.id]: next };
        });
      };

      const scheduleReconnect = () => {
        if (disposed || stopped || reconnectTimer) return;
        runtime.socketOpen = false;
        update({ status: "offline" });
        const delay = reconnectDelay(reconnectAttempt++);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void synchronize();
        }, delay);
      };

      const synchronize = async () => {
        if (disposed || stopped) return;
        update({ status: "connecting" });
        try {
          const next = await client.getSnapshot();
          if (disposed || stopped) return;
          runtime.lastSequence = next.lastSequence;
          update({ snapshot: next, notice: null });
        } catch (error) {
          if (disposed || stopped) return;
          if (isUnauthorized(error)) {
            stopped = true;
            update({ status: "needs_configuration", notice: describeControlError(error) });
            credentialsRejected.current(session.id);
            return;
          }
          update({ notice: describeControlError(error) });
          scheduleReconnect();
          return;
        }

        const descriptor = client.eventSocket(runtime.lastSequence);
        const socket = new WebSocket(descriptor.url, descriptor.protocols);
        runtime.socket = socket;
        socket.onopen = () => {
          if (disposed || stopped) return;
          reconnectAttempt = 0;
          runtime.socketOpen = true;
          update({ status: "online", notice: null });
        };
        socket.onmessage = (message) => {
          if (disposed || stopped) return;
          try {
            const event = client.parseEvent(String(message.data));
            runtime.lastSequence = Math.max(runtime.lastSequence, event.sequence);
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
          if (disposed || stopped) return;
          runtime.socketOpen = false;
          runtime.socket = null;
          scheduleReconnect();
        };
      };

      void synchronize();
      cleanups.push(() => {
        stopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        runtime.socket?.close();
      });
    }

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      runtimeConnections.current.clear();
      approvalBusy.current.clear();
    };
  }, [appActive, connectionKick, sessionSignature]);

  const activeState = activeConnectionId
    ? connectionStates[activeConnectionId] || createConnectionState(activeSession?.accessKey ? "connecting" : "needs_configuration")
    : createConnectionState("needs_configuration");

  const refresh = useCallback(async () => {
    if (!activeSession?.accessKey) return;
    const runtime = runtimeConnections.current.get(activeSession.id);
    const client = runtime?.client || new ControlClient(activeSession.host, activeSession.port, activeSession.accessKey);
    updateConnectionState(setConnectionStates, activeSession.id, { refreshing: true });
    try {
      const next = await client.getSnapshot();
      if (runtime) runtime.lastSequence = next.lastSequence;
      updateConnectionState(setConnectionStates, activeSession.id, { snapshot: next, notice: null });
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
    const client = runtime?.client || new ControlClient(activeSession.host, activeSession.port, activeSession.accessKey);
    try {
      const event = await client.resolveApproval(approvalId, decision);
      if (runtime) runtime.lastSequence = Math.max(runtime.lastSequence, event.sequence);
      updateConnectionState(setConnectionStates, activeSession.id, (current) => ({
        ...current,
        snapshot: applyAgentEvent(current.snapshot, event),
        approvalOperations: omitKey(current.approvalOperations, approvalId),
      }));
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

export function reconnectDelay(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + random() * 0.4));
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
