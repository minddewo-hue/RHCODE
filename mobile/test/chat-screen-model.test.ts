import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineItem } from "@rhzycode/protocol";
import {
  buildChatEntries,
  countActivityEntries,
  isResultEntry,
  type PendingMessage,
} from "../src/components/chat-screen-model";

const now = "2026-07-20T10:00:00.000Z";

function timeline(id: string, threadId: string, kind: TimelineItem["kind"], content = id): TimelineItem {
  return {
    id,
    threadId,
    kind,
    status: "completed",
    title: id,
    content,
    createdAt: now,
  };
}

const emptyRequests = { approvals: [], userInputs: [] };

test("builds result entries only for the selected thread", () => {
  const entries = buildChatEntries({
    selectedThreadId: "thread-1",
    timeline: [
      timeline("user-1", "thread-1", "user"),
      timeline("assistant-1", "thread-1", "assistant"),
      timeline("command-1", "thread-1", "command"),
      timeline("user-2", "thread-2", "user"),
    ],
    pendingMessages: [],
    ...emptyRequests,
  }, false);

  assert.deepEqual(entries.map((entry) => entry.id), ["timeline:user-1", "timeline:assistant-1"]);
  assert.ok(entries.every(isResultEntry));
});

test("keeps an image pending message without duplicating its timeline message", () => {
  const pending: PendingMessage = {
    id: "pending-1",
    threadId: "thread-1",
    content: "inspect this",
    createdAt: now,
    state: "sent",
    images: [{ name: "screen.png", uri: "file:///screen.png" }],
  };
  const entries = buildChatEntries({
    selectedThreadId: "thread-1",
    timeline: [timeline("user-1", "thread-1", "user", pending.content)],
    pendingMessages: [pending],
    ...emptyRequests,
  }, false);

  assert.deepEqual(entries.map((entry) => entry.id), ["pending:pending-1"]);
});

test("counts activity only for the selected thread", () => {
  const count = countActivityEntries({
    selectedThreadId: "thread-1",
    timeline: [
      timeline("command-1", "thread-1", "command"),
      timeline("user-1", "thread-1", "user"),
      timeline("command-2", "thread-2", "command"),
    ],
    approvals: [{
      id: "approval-1",
      threadId: "thread-1",
      kind: "command",
      title: "Approve",
      detail: "npm test",
      createdAt: now,
    }],
    userInputs: [],
  });

  assert.equal(count, 2);
});
