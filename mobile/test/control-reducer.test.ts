import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, ControlSnapshot } from "@rhzycode/protocol";
import {
  applyAgentEvent,
  emptyControlSnapshot,
  hydrateThreadSnapshot,
  mergeControlSnapshot,
} from "../src/state/control-reducer";

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

test("merges all nine AgentEvent variants", () => {
  const events: AgentEvent[] = [
    { type: "host.status", sequence: 1, host },
    { type: "thread.updated", sequence: 2, thread },
    { type: "timeline.upserted", sequence: 3, item: timeline },
    { type: "approval.requested", sequence: 4, approval },
    { type: "user_input.requested", sequence: 5, request: userInput },
    { type: "approval.resolved", sequence: 6, approvalId: approval.id, decision: "approved" },
    { type: "user_input.resolved", sequence: 7, requestId: userInput.id },
    { type: "projects.updated", sequence: 8, projects: [{ path: "D:\\work", name: "work" }] },
    { type: "thread.removed", sequence: 9, threadId: thread.id },
  ];
  const result = events.reduce<ControlSnapshot>(applyAgentEvent, emptyControlSnapshot);

  assert.deepEqual(result.hosts, [host]);
  assert.deepEqual(result.projects, [{ path: "D:\\work", name: "work" }]);
  assert.deepEqual(result.timeline, [timeline]);
  assert.deepEqual(result.threads, []);
  assert.deepEqual(result.approvals, []);
  assert.deepEqual(result.userInputs, []);
  assert.equal(result.lastSequence, 9);
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

test("hydrates complete thread history without dropping concurrent events", () => {
  const liveItem = {
    ...timeline,
    id: "timeline-live",
    kind: "assistant" as const,
    content: "Live response",
  };
  const current = {
    ...emptyControlSnapshot,
    timeline: [liveItem],
    lastSequence: 12,
  };
  const hydrated = hydrateThreadSnapshot(current, {
    thread: { ...thread, status: "completed" },
    timeline: [{ ...timeline, createdAt: "2026-07-15T09:59:00.000Z" }],
  });

  assert.deepEqual(hydrated.timeline.map((item) => item.id), ["timeline-1", "timeline-live"]);
  assert.equal(hydrated.threads[0]?.id, thread.id);
  assert.equal(hydrated.lastSequence, 12);
});

test("keeps opened thread history when a refresh returns only the live timeline", () => {
  const openedHistory = {
    ...timeline,
    id: "historical-message",
    kind: "assistant" as const,
    content: "Restored answer",
    status: "completed" as const,
  };
  const liveItem = {
    ...timeline,
    id: "live-message",
    kind: "assistant" as const,
    content: "Live answer",
  };
  const current = {
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [openedHistory],
  };
  const refreshed = mergeControlSnapshot(current, {
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [liveItem],
    lastSequence: 20,
  });

  assert.deepEqual(refreshed.timeline.map((item) => item.id), ["historical-message", "live-message"]);
  assert.equal(refreshed.lastSequence, 20);
});

test("drops retained history after its thread is removed", () => {
  const current = {
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [timeline],
  };

  assert.deepEqual(mergeControlSnapshot(current, emptyControlSnapshot).timeline, []);
});

test("preserves fresher streamed content when hydrate returns a stale item", () => {
  const liveItem = {
    ...timeline,
    id: "assistant-live",
    kind: "assistant" as const,
    status: "running" as const,
    content: "Hello from the live stream that grew further",
    createdAt: "2026-07-15T10:00:05.000Z",
  };
  const current = {
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [liveItem],
    lastSequence: 40,
  };
  const hydrated = hydrateThreadSnapshot(current, {
    thread,
    timeline: [{
      ...liveItem,
      status: "completed" as const,
      content: "Hello from the live stream",
      createdAt: "2026-07-15T10:00:01.000Z",
    }],
  });

  assert.equal(hydrated.timeline.length, 1);
  assert.equal(hydrated.timeline[0]?.content, liveItem.content);
  assert.equal(hydrated.timeline[0]?.status, "running");
  assert.equal(hydrated.timeline[0]?.createdAt, "2026-07-15T10:00:01.000Z");
});

test("merge keeps longer local stream content over a shorter snapshot payload", () => {
  const local = {
    ...timeline,
    id: "assistant-live",
    kind: "assistant" as const,
    status: "running" as const,
    content: "partial answer that continued while backgrounded",
  };
  const incoming = {
    ...local,
    content: "partial answer",
    status: "running" as const,
  };
  const merged = mergeControlSnapshot({
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [local],
  }, {
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [incoming],
    lastSequence: 22,
  });

  assert.equal(merged.timeline[0]?.content, local.content);
  assert.equal(merged.lastSequence, 22);
});
test("a terminal notice replaces an earlier retry notice even when it is shorter", () => {
  const retryNotice = {
    ...timeline,
    id: "error-turn-1",
    kind: "notice" as const,
    status: "running" as const,
    content: "Upstream first-byte timeout",
  };
  const merged = mergeControlSnapshot({
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [retryNotice],
    lastSequence: 21,
  }, {
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [{ ...retryNotice, status: "failed", content: "Retry budget exhausted" }],
    lastSequence: 22,
  });

  assert.equal(merged.timeline[0]?.content, "Retry budget exhausted");
  assert.equal(merged.timeline[0]?.status, "failed");
});

test("survives repeated reconnect cycles without regressing streamed content", () => {
  const assistantId = "assistant-live";
  const baseItem = {
    ...timeline,
    id: assistantId,
    kind: "assistant" as const,
    status: "running" as const,
    content: "A",
    createdAt: "2026-07-15T10:00:01.000Z",
  };

  // Live stream starts.
  let state: ControlSnapshot = applyAgentEvent({
    ...emptyControlSnapshot,
    threads: [thread],
    lastSequence: 10,
  }, {
    type: "timeline.upserted",
    sequence: 11,
    item: baseItem,
  });

  // More tokens arrive before the first drop.
  state = applyAgentEvent(state, {
    type: "timeline.upserted",
    sequence: 12,
    item: { ...baseItem, content: "Answer growing while online" },
  });
  assert.equal(state.timeline[0]?.content, "Answer growing while online");

  // Reconnect #1: stale shorter snapshot + older completed status.
  state = mergeControlSnapshot(state, {
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [{
      ...baseItem,
      content: "Answer growing",
      status: "completed",
      createdAt: "2026-07-15T10:00:00.000Z",
    }],
    lastSequence: 12,
  });
  assert.equal(state.timeline[0]?.content, "Answer growing while online");
  assert.equal(state.timeline[0]?.status, "running");
  assert.equal(state.timeline[0]?.createdAt, "2026-07-15T10:00:00.000Z");

  // Live stream continues after reconnect.
  state = applyAgentEvent(state, {
    type: "timeline.upserted",
    sequence: 18,
    item: { ...baseItem, content: "Answer growing while online after first reconnect" },
  });

  // Reconnect #2: openThread history is stale again.
  state = hydrateThreadSnapshot(state, {
    thread,
    timeline: [{
      ...baseItem,
      content: "Answer growing while online",
      status: "completed",
      createdAt: "2026-07-15T09:59:59.000Z",
    }],
  });
  assert.equal(
    state.timeline[0]?.content,
    "Answer growing while online after first reconnect",
  );
  assert.equal(state.timeline[0]?.status, "running");

  // Reconnect #3: another short live snapshot arrives out of order.
  state = mergeControlSnapshot(state, {
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [{
      ...baseItem,
      content: "Answer growing while online after",
      status: "running",
    }],
    lastSequence: 20,
  });
  assert.equal(
    state.timeline[0]?.content,
    "Answer growing while online after first reconnect",
  );

  // Final authoritative completion catches up with full content.
  state = mergeControlSnapshot(state, {
    ...emptyControlSnapshot,
    threads: [{ ...thread, status: "completed" }],
    timeline: [{
      ...baseItem,
      content: "Answer growing while online after first reconnect and finished",
      status: "completed",
    }],
    lastSequence: 30,
  });
  assert.equal(
    state.timeline[0]?.content,
    "Answer growing while online after first reconnect and finished",
  );
  assert.equal(state.timeline[0]?.status, "completed");
  assert.equal(state.lastSequence, 30);
});

test("keeps historical messages across reconnect snapshots that only carry live items", () => {
  const history = {
    ...timeline,
    id: "user-1",
    kind: "user" as const,
    status: "completed" as const,
    content: "Please continue",
    createdAt: "2026-07-15T09:00:00.000Z",
  };
  const live = {
    ...timeline,
    id: "assistant-1",
    kind: "assistant" as const,
    status: "running" as const,
    content: "working on it with more detail now",
    createdAt: "2026-07-15T10:00:00.000Z",
  };

  let state: ControlSnapshot = {
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [history, live],
    lastSequence: 5,
  };

  for (let round = 0; round < 5; round += 1) {
    state = mergeControlSnapshot(state, {
      ...emptyControlSnapshot,
      threads: [thread],
      timeline: [{
        ...live,
        content: "working on it",
        status: "running",
      }],
      lastSequence: 6 + round,
    });
  }

  assert.deepEqual(state.timeline.map((item) => item.id), ["user-1", "assistant-1"]);
  assert.equal(state.timeline[1]?.content, "working on it with more detail now");
  assert.equal(state.lastSequence, 10);
});

test("an out-of-order snapshot cannot drop a newer thread or move its cursor backwards", () => {
  const current: ControlSnapshot = {
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [timeline],
    approvals: [approval],
    lastSequence: 50,
  };
  const stale: ControlSnapshot = {
    ...emptyControlSnapshot,
    lastSequence: 47,
  };
  const merged = mergeControlSnapshot(current, stale);

  assert.deepEqual(merged.threads, [thread]);
  assert.deepEqual(merged.timeline, [timeline]);
  assert.deepEqual(merged.approvals, [approval]);
  assert.equal(merged.lastSequence, 50);
});

test("an out-of-order snapshot cannot resurrect a thread removed by a newer event", () => {
  const current: ControlSnapshot = {
    ...emptyControlSnapshot,
    lastSequence: 51,
  };
  const stale: ControlSnapshot = {
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [timeline],
    lastSequence: 50,
  };
  const merged = mergeControlSnapshot(current, stale);

  assert.deepEqual(merged.threads, []);
  assert.deepEqual(merged.timeline, []);
  assert.equal(merged.lastSequence, 51);
});


test("collapses provisional user rows after history catch-up while keeping intentional repeats", () => {
  const provisionalFirst = {
    ...timeline,
    id: "user-pending-1",
    kind: "user" as const,
    status: "completed" as const,
    content: "continue",
    clientMessageId: "pending-1",
    createdAt: "2026-07-15T10:00:00.000Z",
  };
  const provisionalSecond = {
    ...timeline,
    id: "user-pending-2",
    kind: "user" as const,
    status: "completed" as const,
    content: "continue",
    clientMessageId: "pending-2",
    createdAt: "2026-07-15T10:00:02.000Z",
  };
  const historyFirst = {
    ...timeline,
    id: "turn-1::item-user-1",
    kind: "user" as const,
    status: "completed" as const,
    content: "continue",
    createdAt: "2026-07-15T10:00:00.000Z",
  };
  const historySecond = {
    ...timeline,
    id: "turn-2::item-user-2",
    kind: "user" as const,
    status: "completed" as const,
    content: "continue",
    createdAt: "2026-07-15T10:00:02.000Z",
  };

  const merged = mergeControlSnapshot({
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [provisionalFirst, provisionalSecond],
    lastSequence: 10,
  }, {
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [historyFirst, historySecond],
    lastSequence: 11,
  });

  assert.deepEqual(merged.timeline.map((item) => item.id), [
    "turn-1::item-user-1",
    "turn-2::item-user-2",
  ]);
  assert.equal(merged.timeline[0]?.clientMessageId, "pending-1");
  assert.equal(merged.timeline[1]?.clientMessageId, "pending-2");
});

test("collapses desktop runtime user rows without client ids one-to-one", () => {
  const liveFirst = {
    ...timeline,
    id: "user-1722521926736",
    kind: "user" as const,
    status: "completed" as const,
    content: "reconnect",
    createdAt: "2026-07-15T10:05:00.000Z",
  };
  const liveSecond = {
    ...liveFirst,
    id: "user-1722521930000",
    createdAt: "2026-07-15T10:06:00.000Z",
  };
  const historyFirst = {
    ...liveFirst,
    id: "turn-1::item-user-1",
    createdAt: "2026-07-15T10:00:00.000Z",
  };
  const historySecond = {
    ...liveFirst,
    id: "turn-2::item-user-2",
    createdAt: "2026-07-15T10:01:00.000Z",
  };

  const hydrated = hydrateThreadSnapshot({
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [liveFirst, liveSecond],
  }, {
    thread,
    timeline: [historyFirst, historySecond],
  });

  assert.deepEqual(hydrated.timeline.map((item) => item.id), [
    "turn-1::item-user-1",
    "turn-2::item-user-2",
  ]);
});

test("collapses unscoped live assistant rows into turn-scoped history rows", () => {
  const live = {
    ...timeline,
    id: "assistant-thread-1",
    kind: "assistant" as const,
    status: "running" as const,
    content: "Answer growing while reconnecting",
    createdAt: "2026-07-15T10:00:01.000Z",
  };
  const history = {
    ...timeline,
    id: "turn-9::assistant-1",
    kind: "assistant" as const,
    status: "completed" as const,
    content: "Answer growing while reconnecting and done",
    createdAt: "2026-07-15T10:00:01.000Z",
  };
  const hydrated = hydrateThreadSnapshot({
    ...emptyControlSnapshot,
    threads: [thread],
    timeline: [live],
    lastSequence: 4,
  }, {
    thread,
    timeline: [history],
  });

  assert.equal(hydrated.timeline.length, 1);
  assert.equal(hydrated.timeline[0]?.id, "turn-9::assistant-1");
  assert.equal(hydrated.timeline[0]?.content, history.content);
  assert.equal(hydrated.timeline[0]?.status, "completed");
});

test("keeps similar assistant replies from different turns", () => {
  const hydrated = hydrateThreadSnapshot({
    ...emptyControlSnapshot,
    threads: [thread],
  }, {
    thread,
    timeline: [{
      ...timeline,
      id: "turn-1::assistant-1",
      kind: "assistant",
      status: "completed",
      content: "Connection restored",
      createdAt: "2026-07-15T10:00:01.000Z",
    }, {
      ...timeline,
      id: "turn-2::assistant-2",
      kind: "assistant",
      status: "completed",
      content: "Connection restored and verified",
      createdAt: "2026-07-15T10:01:01.000Z",
    }],
  });

  assert.deepEqual(hydrated.timeline.map((item) => item.id), [
    "turn-1::assistant-1",
    "turn-2::assistant-2",
  ]);
});
