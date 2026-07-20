import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, ControlSnapshot } from "@rhzycode/protocol";
import { applyAgentEvent, emptyControlSnapshot } from "../src/state/control-reducer";

const now = "2026-07-15T10:00:00.000Z";

const host = {
  id: "host-1",
  name: "Workstation",
  platform: "windows" as const,
  status: "online" as const,
  lastSeenAt: now,
  activeTaskCount: 1,
};
const thread = {
  id: "thread-1",
  hostId: host.id,
  title: "Run checks",
  projectPath: "D:\\work",
  model: "test/model",
  status: "running" as const,
  updatedAt: now,
};
const timeline = {
  id: "timeline-1",
  threadId: thread.id,
  kind: "command" as const,
  status: "running" as const,
  title: "Check",
  content: "npm test",
  createdAt: now,
};
const approval = {
  id: "approval-1",
  threadId: thread.id,
  kind: "command" as const,
  title: "Approve tests",
  detail: "npm test",
  createdAt: now,
};
const userInput = {
  id: "input-1",
  threadId: thread.id,
  questions: [{
    id: "question-1",
    header: "Choice",
    question: "Continue?",
    isOther: false,
    isSecret: false,
    options: null,
  }],
  autoResolutionMs: null,
  createdAt: now,
};

test("merges all eight AgentEvent variants", () => {
  const events: AgentEvent[] = [
    { type: "host.status", sequence: 1, host },
    { type: "thread.updated", sequence: 2, thread },
    { type: "timeline.upserted", sequence: 3, item: timeline },
    { type: "approval.requested", sequence: 4, approval },
    { type: "user_input.requested", sequence: 5, request: userInput },
    { type: "approval.resolved", sequence: 6, approvalId: approval.id, decision: "approved" },
    { type: "user_input.resolved", sequence: 7, requestId: userInput.id },
    { type: "thread.removed", sequence: 8, threadId: thread.id },
  ];
  const result = events.reduce<ControlSnapshot>(applyAgentEvent, emptyControlSnapshot);

  assert.deepEqual(result.hosts, [host]);
  assert.deepEqual(result.timeline, [timeline]);
  assert.deepEqual(result.threads, []);
  assert.deepEqual(result.approvals, []);
  assert.deepEqual(result.userInputs, []);
  assert.equal(result.lastSequence, 8);
});

test("upserts duplicate ids and never moves the sequence backwards", () => {
  const initial = applyAgentEvent(emptyControlSnapshot, { type: "host.status", sequence: 10, host });
  const updated = applyAgentEvent(initial, {
    type: "host.status",
    sequence: 3,
    host: { ...host, name: "Renamed workstation", activeTaskCount: 2 },
  });

  assert.equal(updated.hosts.length, 1);
  assert.equal(updated.hosts[0]?.name, "Renamed workstation");
  assert.equal(updated.lastSequence, 10);
});

test("removing missing state is idempotent", () => {
  const threadResult = applyAgentEvent(emptyControlSnapshot, {
    type: "thread.removed",
    sequence: 1,
    threadId: "missing",
  });
  const approvalResult = applyAgentEvent(threadResult, {
    type: "approval.resolved",
    sequence: 2,
    approvalId: "missing",
    decision: "declined",
  });
  const inputResult = applyAgentEvent(approvalResult, {
    type: "user_input.resolved",
    sequence: 3,
    requestId: "missing",
  });

  assert.deepEqual(inputResult.threads, []);
  assert.deepEqual(inputResult.approvals, []);
  assert.deepEqual(inputResult.userInputs, []);
  assert.equal(inputResult.lastSequence, 3);
});
