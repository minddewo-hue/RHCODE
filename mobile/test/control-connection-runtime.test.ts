import assert from "node:assert/strict";
import test from "node:test";
import type { ControlSnapshot } from "@rhzycode/protocol";
import { ControlClient } from "../src/api/control-client";
import {
  createControlPlaneRuntime,
  type ControlPlaneConnectionState,
  type RuntimeConnection,
} from "../src/hooks/control-connection-runtime";
import { createConnectionState } from "../src/hooks/control-connection-runtime";

const accessKey = `rhzy_${"a".repeat(43)}`;

function makeSnapshot(overrides: Partial<ControlSnapshot> = {}): ControlSnapshot {
  return {
    hosts: [],
    projects: [],
    threads: [],
    timeline: [],
    approvals: [],
    userInputs: [],
    lastSequence: 100,
    streamId: "stream-0001",
    ...overrides,
  };
}

function makeHostEvent(sequence: number) {
  return {
    type: "host.status",
    sequence,
    host: {
      id: "local-desktop",
      name: "DESKTOP",
      platform: "windows",
      status: "online",
      lastSeenAt: "2026-09-21T01:00:00.000Z",
      activeTaskCount: 0,
    },
  };
}

/** Minimal stand-in for the React Native global WebSocket. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  readyState: number = 0;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string, readonly protocols: string[] = []) {
    FakeWebSocket.instances.push(this);
  }
  open(): void {
    if (this.readyState === 0) {
      this.readyState = 1;
      this.onopen?.();
    }
  }
  receive(frame: unknown): void {
    if (this.readyState !== 1) throw new Error("FakeWebSocket is not open");
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}

interface Harness {
  runtime: RuntimeConnection;
  state: ControlPlaneConnectionState;
  credentialsRejected: number;
  fetchCount: number;
  appState: string;
}

function createHarness(makeSnapshotForCall: () => ControlSnapshot, options: { appState?: string } = {}): Harness {
  const { client } = createSnapshotClient(makeSnapshotForCall);
  let state = createConnectionState("connecting");
  let credentialsRejected = 0;
  const runtime = createControlPlaneRuntime({
    client,
    readAppState: () => options.appState || "active",
    onState: (value) => {
      state = typeof value === "function" ? value(state) : { ...state, ...value };
    },
    onCredentialsRejected: () => {
      credentialsRejected += 1;
    },
  });
  return {
    runtime,
    get state() { return state; },
    get credentialsRejected() { return credentialsRejected; },
    get fetchCount() { return fetchCount; },
    get appState() { return options.appState || "active"; },
  };
}

let fetchCount = 0;

function createSnapshotClient(nextSnapshot: () => ControlSnapshot): { client: ControlClient } {
  const client = new ControlClient(accessKey, {
    fetchImpl: (async (url: string, init?: unknown) => {
      fetchCount += 1;
      void init;
      if (typeof url === "string" && url.endsWith("/v1/snapshot")) {
        return {
          ok: true,
          status: 200,
          json: async () => nextSnapshot(),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: "not_found" }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  return { client };
}

async function waitFor(condition: () => boolean, timeoutMs = 6000, message?: string): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(message || "waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function installWebSocket(): void {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

test("cold start opens the realtime socket after the snapshot and reaches online", async () => {
  FakeWebSocket.reset();
  fetchCount = 0;
  installWebSocket();
  const harness = createHarness(() => makeSnapshot());
  try {
    // Regression (2026-09-21): synchronize() released the snapshot but left
    // runtime.connecting=true, so openRealtimeSocket() bailed on its own
    // re-entrancy guard and the socket was never created — the app stayed
    // stuck in "connecting" forever.
    await waitFor(() => FakeWebSocket.instances.length >= 1, 3000, "realtime socket was not created after snapshot");
    const socket = FakeWebSocket.instances[0]!;
    assert.ok(socket.url.includes("/v1/events?after=100"), `cursor missing in ${socket.url}`);
    assert.ok(socket.protocols[1] === `rhzycode.auth.${accessKey}`, "access key subprotocol missing");
    assert.equal(harness.state.status, "connecting");
    socket.open();
    assert.equal(harness.state.status, "online");
    assert.equal(harness.runtime.socketOpen, true);
    assert.equal(harness.fetchCount, 1);
  } finally {
    harness.runtime.dispose();
  }
});

test("a bounded gap is healed by re-opening the socket without a fresh snapshot", async () => {
  FakeWebSocket.reset();
  fetchCount = 0;
  installWebSocket();
  const harness = createHarness(() => makeSnapshot());
  try {
    await waitFor(() => FakeWebSocket.instances.length >= 1, 3000);
    const first = FakeWebSocket.instances[0]!;
    first.open();
    assert.equal(harness.state.status, "online");

    first.receive({ type: "control.sync", streamId: "stream-0001", lastSequence: 105, earliestReplaySequence: 50 });
    first.receive(makeHostEvent(101));
    assert.equal(harness.runtime.lastSequence, 101);

    first.receive(makeHostEvent(104));
    assert.equal(first.readyState, 3, "old socket must be closed for continuation");
    await waitFor(() => FakeWebSocket.instances.length >= 2, 3000, "continuation socket was not created");
    assert.equal(harness.fetchCount, 1, "continuation must not fetch a fresh snapshot");

    const second = FakeWebSocket.instances[1]!;
    assert.ok(second.url.includes("after=101"), `continuation cursor missing in ${second.url}`);
    second.open();
    second.receive(makeHostEvent(102));
    second.receive(makeHostEvent(103));
    second.receive(makeHostEvent(104));
    assert.equal(harness.runtime.lastSequence, 104);
    assert.equal(harness.state.status, "online");
  } finally {
    harness.runtime.dispose();
  }
});

test("a cursor beyond the replay buffer escalates to a full resync and returns online", async () => {
  FakeWebSocket.reset();
  fetchCount = 0;
  installWebSocket();
  const harness = createHarness(() => (fetchCount === 1 ? makeSnapshot() : makeSnapshot({ lastSequence: 300 })));
  try {
    await waitFor(() => FakeWebSocket.instances.length >= 1, 3000);
    const first = FakeWebSocket.instances[0]!;
    first.open();
    assert.equal(harness.state.status, "online");

    first.receive({ type: "control.sync", streamId: "stream-0001", lastSequence: 300, earliestReplaySequence: 200 });
    await waitFor(() => harness.state.status === "offline", 3000, "full resync must pass through offline");
    await waitFor(() => FakeWebSocket.instances.length >= 2, 5000, "full-resync socket was not created");
    assert.equal(harness.fetchCount, 2, "full resync must fetch a fresh snapshot");
    assert.equal(harness.runtime.lastSequence, 300, "cursor must advance to the new snapshot");

    const resync = FakeWebSocket.instances[1]!;
    assert.ok(resync.url.includes("after=300"), `resync cursor missing in ${resync.url}`);
    resync.open();
    assert.equal(harness.state.status, "online");
  } finally {
    harness.runtime.dispose();
  }
});

test("a dropped socket reconnects through a fresh snapshot and returns online", async () => {
  FakeWebSocket.reset();
  fetchCount = 0;
  installWebSocket();
  const harness = createHarness(() => makeSnapshot());
  try {
    await waitFor(() => FakeWebSocket.instances.length >= 1, 3000);
    const first = FakeWebSocket.instances[0]!;
    first.open();
    assert.equal(harness.state.status, "online");

    first.close();
    await waitFor(() => harness.state.status === "offline", 3000, "drop must surface as offline");
    await waitFor(() => FakeWebSocket.instances.length >= 2, 6000, "reconnect socket was not created");
    assert.equal(harness.fetchCount, 2, "reconnect must fetch a fresh snapshot");
    const second = FakeWebSocket.instances[1]!;
    second.open();
    assert.equal(harness.state.status, "online");
  } finally {
    harness.runtime.dispose();
  }
});

test("an unauthorized snapshot marks the session needs_configuration and stops retrying", async () => {
  FakeWebSocket.reset();
  installWebSocket();
  let fetches = 0;
  const client = new ControlClient(accessKey, {
    fetchImpl: (async () => {
      fetches += 1;
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: "invalid_key" }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  let state = createConnectionState("connecting");
  let rejected = 0;
  const runtime = createControlPlaneRuntime({
    client,
    readAppState: () => "active",
    onState: (value) => {
      state = typeof value === "function" ? value(state) : { ...state, ...value };
    },
    onCredentialsRejected: () => {
      rejected += 1;
    },
  });
  try {
    await waitFor(() => state.status === "needs_configuration", 3000, "401 must surface as needs_configuration");
    assert.equal(rejected, 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(fetches, 1, "401 must not be retried");
    assert.equal(FakeWebSocket.instances.length, 0, "no realtime socket may open on 401");
  } finally {
    runtime.dispose();
  }
});
