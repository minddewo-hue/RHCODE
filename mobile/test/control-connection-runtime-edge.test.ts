import assert from "node:assert/strict";
import test from "node:test";
import type { ControlSnapshot } from "@rhzycode/protocol";
import { ControlClient } from "../src/api/control-client";
import {
  createConnectionState,
  createControlPlaneRuntime,
  type ControlPlaneConnectionState,
  type RuntimeConnection,
} from "../src/hooks/control-connection-runtime";

const accessKey = `rhzy_${"b".repeat(43)}`;

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

function installWebSocket(): void {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

async function waitFor(condition: () => boolean, timeoutMs = 6000, message?: string): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(message || "waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  runtime: RuntimeConnection;
  state: ControlPlaneConnectionState;
}

function createImmediateHarness(): Harness {
  const client = new ControlClient(accessKey, {
    fetchImpl: (async (url: string) => {
      if (typeof url === "string" && url.endsWith("/v1/snapshot")) {
        return {
          ok: true,
          status: 200,
          json: async () => makeSnapshot(),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: "not_found" }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  let state = createConnectionState("connecting");
  const runtime = createControlPlaneRuntime({
    client,
    readAppState: () => "active",
    onState: (value) => {
      state = typeof value === "function" ? value(state) : { ...state, ...value };
    },
    onCredentialsRejected: () => undefined,
  });
  return { runtime, get state() { return state; } };
}

test("rapid resume while a snapshot is in flight opens exactly one socket (no double-open)", async () => {
  FakeWebSocket.reset();
  installWebSocket();

  // Snapshot responses stay pending until we release them, so the first
  // synchronize() is guaranteed to still be "connecting" when resume fires.
  const pendingJson: Array<(snapshot: ControlSnapshot) => void> = [];
  const client = new ControlClient(accessKey, {
    fetchImpl: (async (url: string) => {
      if (typeof url === "string" && url.endsWith("/v1/snapshot")) {
        const json: () => Promise<ControlSnapshot> = () =>
          new Promise<ControlSnapshot>((resolve) => {
            pendingJson.push(resolve);
          });
        return { ok: true, status: 200, json } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: "not_found" }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  let state = createConnectionState("connecting");
  const runtime = createControlPlaneRuntime({
    client,
    readAppState: () => "active",
    onState: (value) => {
      state = typeof value === "function" ? value(state) : { ...state, ...value };
    },
    onCredentialsRejected: () => undefined,
  });
  try {
    // Initial synchronize() has issued its snapshot request.
    await waitFor(() => pendingJson.length >= 1, 3000, "initial snapshot request missing");
    // Foreground/background flapping while the snapshot is still in flight:
    // each resume() tears the runtime down and starts a fresh synchronize().
    runtime.resume?.();
    runtime.resume?.();
    runtime.resume?.();
    await waitFor(() => pendingJson.length >= 4, 3000, "resume snapshot requests missing");
    assert.equal(state.status, "connecting", "rapid resumes must not open a socket early");

    // Release every in-flight snapshot; only the latest generation may win.
    for (const release of [...pendingJson]) release(makeSnapshot());
    await waitFor(() => FakeWebSocket.instances.length >= 1, 3000, "socket not created after rapid resumes");
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    assert.equal(FakeWebSocket.instances.length, 1, "exactly one realtime socket may exist");
    assert.ok(socket.url.includes("/v1/events?after=100"), `cursor missing in ${socket.url}`);
    assert.equal(state.status, "online");
    assert.equal(runtime.socketOpen, true);
    assert.equal(runtime.connecting, false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(FakeWebSocket.instances.length, 1, "no late duplicate socket may appear");
  } finally {
    runtime.dispose();
  }
});

function countPendingTimers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

test("dispose (component unmount) leaves no pending timers and ignores late socket events", async () => {
  FakeWebSocket.reset();
  installWebSocket();
  // Baseline taken before the runtime exists: only test-runner-owned timers.
  const baselineTimers = countPendingTimers();
  const harness = createImmediateHarness();
  try {
    await waitFor(() => FakeWebSocket.instances.length >= 1, 3000);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    assert.equal(harness.state.status, "online");
    // While online the runtime owns heartbeat timers (the 15s connect
    // timeout was already cleared by onopen).
    const timersOnline = countPendingTimers();
    assert.ok(timersOnline > baselineTimers, "online state should own pending heartbeat timers");
    harness.runtime.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const timersAfter = countPendingTimers();
    assert.ok(timersAfter < timersOnline, "dispose must cancel the heartbeat timers");
    assert.ok(timersAfter <= baselineTimers, "dispose must not leave any new timers behind");

    // Late events on a disposed runtime must be inert: no reconnect, no state change.
    const stateAtDispose = harness.state;
    socket.onmessage?.({ data: JSON.stringify(makeHostEvent(101)) });
    socket.onclose?.();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(FakeWebSocket.instances.length, 1, "no socket may be created after dispose");
    assert.equal(harness.state, stateAtDispose, "state must not change after dispose");
  } finally {
    harness.runtime.dispose();
  }
});
