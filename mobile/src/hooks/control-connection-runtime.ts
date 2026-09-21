import type { ControlSnapshot } from "@rhzycode/protocol";
import {
  getSnapshotWithRetry,
  heartbeatPingFrame,
  heartbeatPongId,
  incomingSequenceAction,
  reconnectDelay,
  webSocketConnectTimeoutMs,
  webSocketHeartbeatIntervalMs,
  webSocketHeartbeatTimeoutMs,
} from "../api/control-connection-model";
import { ControlClientError, type ControlClient } from "../api/control-client";
import {
  applyAgentEvent,
  emptyControlSnapshot,
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

export type ConnectionStateUpdater =
  | Partial<ControlPlaneConnectionState>
  | ((current: ControlPlaneConnectionState) => ControlPlaneConnectionState);

/**
 * Per-session connection machine. Owns the full connect/sync/reconnect
 * lifecycle for one desktop (accessKey): snapshot fetch, realtime socket,
 * heartbeats, gap continuation and full-resync escalation. Kept free of
 * React so the state transitions are unit-testable without a renderer.
 */
export interface RuntimeConnection {
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
  dispose: () => void;
}

export interface ControlPlaneRuntimeInput {
  client: ControlClient;
  /** Current app foreground state ("active" | "background" | "inactive"). */
  readAppState: () => string;
  onState: (value: ConnectionStateUpdater) => void;
  onCredentialsRejected: () => void;
}

/**
 * A bounded gap is healed by re-opening the socket at `after=lastSequence`
 * (the relay replays the missing events). Three consecutive continuations
 * without progress mean the replay buffer cannot cover — escalate to a full
 * snapshot instead of looping.
 */
const maxGapContinuationAttempts = 3;

export function createConnectionState(status: ConnectionStatus): ControlPlaneConnectionState {
  return {
    snapshot: emptyControlSnapshot,
    status,
    notice: null,
    refreshing: false,
    approvalOperations: {},
  };
}

export function describeControlError(error: unknown): string {
  if (error instanceof ControlClientError) return error.message;
  return "控制服务发生未知错误。";
}

export function createControlPlaneRuntime(input: ControlPlaneRuntimeInput): RuntimeConnection {
  const { client, readAppState, onState, onCredentialsRejected } = input;

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
    dispose: () => {},
  };

  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let socketConnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  let pendingHeartbeatId: string | null = null;
  let heartbeatSequence = 0;
  let reconnectAttempt = 0;
  let paused = readAppState() !== "active";
  let connectionGeneration = 0;

  const clearSocketConnectTimer = () => {
    if (!socketConnectTimer) return;
    clearTimeout(socketConnectTimer);
    socketConnectTimer = null;
  };

  const update = (value: ConnectionStateUpdater) => {
    onState(value);
  };

  const scheduleReconnect = () => {
    if (stopped || paused || reconnectTimer || runtime.connecting) return;
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
    if (stopped || paused) return;
    const generation = connectionGeneration;
    try {
      const next = await loadSnapshot();
      if (stopped || paused || generation !== connectionGeneration) return;
      acceptSnapshotCursor(next);
      update((current) => ({
        ...current,
        snapshot: mergeControlSnapshot(current.snapshot, next),
        notice: null,
        ...(runtime.socketOpen ? { status: "online" as const } : {}),
      }));
    } catch (error) {
      if (stopped || paused || generation !== connectionGeneration) return;
      if (isUnauthorized(error)) {
        stopped = true;
        update({ status: "needs_configuration", notice: describeControlError(error) });
        onCredentialsRejected();
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
    if (stopped || runtime.socket !== socket || !runtime.socketOpen) return;
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
      if (readAppState() !== "active" || pendingHeartbeatId !== id || runtime.socket !== socket) return;
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

  let continuationAttempts = 0;

  /**
   * Close a socket and schedule the FULL recovery path (snapshot + new
   * socket) with backoff. Used when the relay replay buffer cannot cover
   * our cursor, when the stream changed, or when continuation retries
   * keep failing.
   */
  const startFullResync = (socket: WebSocket) => {
    continuationAttempts = 0;
    runtime.connecting = false;
    runtime.socket = null;
    try {
      socket.close();
    } catch {
      // The reconnect below replaces sockets that cannot be closed.
    }
    scheduleReconnect();
  };

  /**
   * Open the realtime socket at the current `lastSequence` cursor. The
   * relay replays every event after it before streaming, so re-opening
   * the socket (without a fresh snapshot) is a complete recovery for a
   * bounded gap — the server's first `control.sync` frame tells us when
   * the replay buffer no longer covers the cursor and we fall back to a
   * full resync.
   *
   * Re-entrancy: callers that hold the `connecting` flag (i.e. finished a
   * full synchronize) must release it before calling this function; the
   * socket handshake re-acquires it.
   */
  const openRealtimeSocket = () => {
    if (stopped || paused || runtime.connecting || runtime.socketOpen) return;
    const generation = connectionGeneration;
    runtime.connecting = true;
    const descriptor = client.eventSocket(runtime.lastSequence);
    const socket = new WebSocket(descriptor.url, descriptor.protocols);
    runtime.socket = socket;
    socketConnectTimer = setTimeout(() => {
      if (stopped || runtime.socket !== socket || runtime.socketOpen) return;
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
      if (stopped || paused || generation !== connectionGeneration) {
        socket.close();
        return;
      }
      reconnectAttempt = 0;
      runtime.connecting = false;
      runtime.socketOpen = true;
      update({ status: "online", notice: null });
      sendHeartbeat(socket);
      // No extra full snapshot here: the pre-socket snapshot plus the
      // replay from after=lastSequence already cover the race, and the
      // control.sync frame / gap handler fall back to a full resync when
      // the replay buffer cannot cover the cursor.
    };
    socket.onmessage = (message) => {
      if (stopped || runtime.socket !== socket) return;
      if (acceptHeartbeat(String(message.data))) return;
      try {
        const frame = client.parseSocketFrame(String(message.data));
        if (frame.type === "control.sync") {
          const streamChanged = Boolean(runtime.streamId && runtime.streamId !== frame.streamId);
          const replayUnavailable = runtime.lastSequence < frame.earliestReplaySequence - 1
            && runtime.lastSequence < frame.lastSequence;
          if (streamChanged || replayUnavailable) {
            // Replay buffer cannot cover our cursor: a full snapshot is
            // the only complete recovery.
            update({ notice: "实时数据版本已变化，正在重新同步。" });
            startFullResync(socket);
            return;
          }
          runtime.streamId = frame.streamId;
          return;
        }
        const event = frame;
        const sequenceAction = incomingSequenceAction(runtime.lastSequence, event.sequence);
        if (sequenceAction === "duplicate") return;
        if (sequenceAction === "gap") {
          // Continuation first: re-open the socket at lastSequence and
          // let the relay replay the missing events. Only escalate to a
          // full snapshot when the next control.sync frame proves the
          // replay buffer cannot cover (or continuation keeps failing).
          if (continuationAttempts >= maxGapContinuationAttempts) {
            update({ notice: "检测到实时数据缺口，正在重新同步。" });
            startFullResync(socket);
            return;
          }
          continuationAttempts += 1;
          update({ notice: "检测到实时数据缺口，正在续拉。" });
          runtime.connecting = false;
          // The replacement socket below supersedes the open one: clear the
          // open flag so openRealtimeSocket's re-entrancy guard passes.
          runtime.socketOpen = false;
          runtime.socket = null;
          try {
            socket.close();
          } catch {
            // The replacement socket below supersedes it.
          }
          openRealtimeSocket();
          return;
        }
        continuationAttempts = 0;
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
      if (stopped) return;
      runtime.connecting = false;
      runtime.socketOpen = false;
      runtime.socket = null;
      scheduleReconnect();
    };
  };

  const synchronize = async () => {
    if (stopped || paused || runtime.connecting) return;
    const generation = connectionGeneration;
    runtime.connecting = true;
    update({ status: "connecting", notice: null });
    try {
      const next = await loadSnapshot();
      if (stopped || paused || generation !== connectionGeneration) return;
      acceptSnapshotCursor(next);
      update((current) => ({
        ...current,
        snapshot: mergeControlSnapshot(current.snapshot, next),
        notice: null,
      }));
    } catch (error) {
      if (stopped || paused || generation !== connectionGeneration) return;
      if (isUnauthorized(error)) {
        runtime.connecting = false;
        stopped = true;
        update({ status: "needs_configuration", notice: describeControlError(error) });
        onCredentialsRejected();
        return;
      }
      runtime.connecting = false;
      update({ notice: describeControlError(error) });
      scheduleReconnect();
      return;
    }

    // Hand the "connecting" flag over to openRealtimeSocket: it re-acquires
    // it as soon as the socket handshake starts. Releasing it here is what
    // lets the re-entrancy guard above pass — otherwise the socket would
    // never be created and the connection would stay stuck in
    // "connecting" (with every later scheduleReconnect/synchronize
    // blocked on the same flag).
    runtime.connecting = false;
    openRealtimeSocket();
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
    if (stopped || paused) return;
    paused = true;
    closeRealtimeConnection();
    update({ status: "offline", notice: null });
  };
  runtime.resume = () => {
    if (stopped) return;
    paused = false;
    reconnectAttempt = 0;
    closeRealtimeConnection();
    void synchronize();
  };

  runtime.dispose = () => {
    stopped = true;
    closeRealtimeConnection();
    runtime.pause = null;
    runtime.resume = null;
    runtime.reconnect = null;
    runtime.resync = null;
  };

  void synchronize();

  return runtime;
}

function isUnauthorized(error: unknown): error is ControlClientError {
  return error instanceof ControlClientError && error.code === "unauthorized";
}

function omitKey<T>(value: Record<string, T>, key: string): Record<string, T> {
  const next = { ...value };
  delete next[key];
  return next;
}
