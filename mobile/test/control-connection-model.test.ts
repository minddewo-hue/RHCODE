import assert from "node:assert/strict";
import test from "node:test";
import type { ControlSnapshot } from "@rhzycode/protocol";
import { ControlClientError } from "../src/api/control-client";
import {
  getSnapshotWithRetry,
  heartbeatPingFrame,
  heartbeatPongId,
  reconnectDelay,
  runControlCommandWithRetry,
  snapshotRequestTimeoutMs,
} from "../src/api/control-connection-model";

const snapshot: ControlSnapshot = {
  hosts: [],
  threads: [],
  timeline: [],
  approvals: [],
  userInputs: [],
  lastSequence: 0,
};

test("retries transient snapshot failures while a VPN route is settling", async () => {
  let calls = 0;
  const waits: number[] = [];
  const timeouts: number[] = [];
  const result = await getSnapshotWithRetry({
    async getSnapshot(timeoutMs) {
      timeouts.push(timeoutMs ?? -1);
      calls += 1;
      if (calls < 3) throw new ControlClientError("invalid_response", "Transient response");
      return snapshot;
    },
  }, {
    retryDelay: (attempt) => (attempt + 1) * 100,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.equal(result, snapshot);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [100, 200]);
  assert.deepEqual(timeouts, [snapshotRequestTimeoutMs, snapshotRequestTimeoutMs, snapshotRequestTimeoutMs]);
});

test("does not retry rejected credentials", async () => {
  let calls = 0;
  await assert.rejects(() => getSnapshotWithRetry({
    async getSnapshot() {
      calls += 1;
      throw new ControlClientError("unauthorized", "Rejected");
    },
  }, { sleep: async () => undefined }), (error: unknown) => (
    error instanceof ControlClientError && error.code === "unauthorized"
  ));
  assert.equal(calls, 1);
});

test("caps background reconnects at a short foreground interval", () => {
  assert.equal(reconnectDelay(0, () => 0.5), 1_000);
  assert.equal(reconnectDelay(20, () => 0.5), 10_000);
});

test("encodes heartbeat pings and accepts only matching pong frames", () => {
  assert.deepEqual(JSON.parse(heartbeatPingFrame("heartbeat-1")), {
    type: "control.ping",
    id: "heartbeat-1",
  });
  assert.equal(heartbeatPongId('{"type":"control.pong","id":"heartbeat-1"}'), "heartbeat-1");
  assert.equal(heartbeatPongId('{"type":"thread.updated","id":"heartbeat-1"}'), null);
  assert.equal(heartbeatPongId("not-json"), null);
});

test("retries a burst of offline and timeout failures before succeeding", async () => {
  const errors = [
    new ControlClientError("offline", "down"),
    new ControlClientError("timeout", "slow"),
    new ControlClientError("server", "502"),
    new ControlClientError("invalid_response", "partial"),
  ];
  let calls = 0;
  const waits: number[] = [];
  const result = await getSnapshotWithRetry({
    async getSnapshot() {
      const error = errors[calls];
      calls += 1;
      if (error) throw error;
      return snapshot;
    },
  }, {
    attempts: 5,
    retryDelay: (attempt) => (attempt + 1) * 50,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.equal(result, snapshot);
  assert.equal(calls, 5);
  assert.deepEqual(waits, [50, 100, 150, 200]);
});

test("stops after repeated offline failures exhaust reconnect-style attempts", async () => {
  let calls = 0;
  await assert.rejects(() => getSnapshotWithRetry({
    async getSnapshot() {
      calls += 1;
      throw new ControlClientError("offline", "still down");
    },
  }, {
    attempts: 4,
    retryDelay: () => 1,
    sleep: async () => undefined,
  }), (error: unknown) => (
    error instanceof ControlClientError && error.code === "offline"
  ));
  assert.equal(calls, 4);
});

test("grows reconnect backoff across many drops and stays capped", () => {
  const delays = Array.from({ length: 8 }, (_, attempt) => reconnectDelay(attempt, () => 0.5));
  assert.equal(delays[0], 1_000);
  assert.equal(delays[1], 2_000);
  assert.equal(delays[2], 4_000);
  assert.equal(delays[3], 8_000);
  assert.ok(delays.slice(4).every((delay) => delay === 10_000));
  for (let index = 1; index < delays.length; index += 1) {
    assert.ok(delays[index]! >= delays[index - 1]!);
  }
});

test("retries transient commands without changing the caller-owned request", async () => {
  let calls = 0;
  const waits: number[] = [];
  const request = { idempotencyKey: "message-1:turn" };
  const result = await runControlCommandWithRetry(async () => {
    calls += 1;
    assert.equal(request.idempotencyKey, "message-1:turn");
    if (calls < 3) throw new ControlClientError(calls === 1 ? "offline" : "timeout", "retry");
    return "accepted";
  }, {
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.equal(result, "accepted");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [800, 1_600]);
});

test("does not retry command conflicts", async () => {
  let calls = 0;
  await assert.rejects(() => runControlCommandWithRetry(async () => {
    calls += 1;
    throw new ControlClientError("conflict", "already running");
  }, { sleep: async () => undefined }), (error: unknown) => (
    error instanceof ControlClientError && error.code === "conflict"
  ));
  assert.equal(calls, 1);
});

