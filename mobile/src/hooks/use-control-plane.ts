import type { RemoteThreadOpenResult } from "@rhzycode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  appConnectionAction,
  getSnapshotWithRetry,
} from "../api/control-connection-model";
import { ControlClient, ControlClientError } from "../api/control-client";
import type { MobileSession } from "../storage/secure-session";
import {
  hydrateThreadSnapshot,
  mergeControlSnapshot,
  mergeTimelineDelta,
} from "../state/control-reducer";
import type { RemoteTimelineDeltaResult } from "@rhzycode/protocol";
import {
  createConnectionState,
  createControlPlaneRuntime,
  describeControlError,
  type ConnectionStateUpdater,
  type ControlPlaneConnectionState,
  type RuntimeConnection,
} from "./control-connection-runtime";

export type {
  ApprovalOperation,
  ConnectionStatus,
  ConnectionStateUpdater,
  ControlPlaneConnectionState,
  RuntimeConnection,
} from "./control-connection-runtime";
export { createConnectionState, describeControlError } from "./control-connection-runtime";

interface UseControlPlaneOptions {
  sessions: MobileSession[];
  activeConnectionId: string | null;
  onCredentialsRejected: (connectionId: string) => void;
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

    const cleanups: Array<() => void> = [];

    for (const session of sessions) {
      if (!session.accessKey) continue;
      const client = new ControlClient(session.accessKey);
      const runtime = createControlPlaneRuntime({
        client,
        readAppState: () => AppState.currentState,
        onState: (value) => updateConnectionState(setConnectionStates, session.id, value),
        onCredentialsRejected: () => credentialsRejected.current(session.id),
      });
      runtimeConnections.current.set(session.id, runtime);
      approvalBusy.current.set(session.id, new Set());
      cleanups.push(() => runtime.dispose());
    }

    return () => {
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

  /** Merge an incremental timeline delta (GET /timeline?afterOrderKey=N). */
  const applyTimelineDelta = useCallback((result: RemoteTimelineDeltaResult) => {
    if (!activeSession) return;
    updateConnectionState(setConnectionStates, activeSession.id, (current) => ({
      ...current,
      snapshot: mergeTimelineDelta(current.snapshot, result),
    }));
  }, [activeSession]);

  return {
    ...activeState,
    connectionStates,
    refresh,
    hydrateThread,
    applyTimelineDelta,
    resolveApproval,
  };
}

function updateConnectionState(
  setter: React.Dispatch<React.SetStateAction<Record<string, ControlPlaneConnectionState>>>,
  connectionId: string,
  value: ConnectionStateUpdater,
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
