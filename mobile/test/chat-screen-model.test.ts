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

test("keeps generated image references in assistant result entries", () => {
  const generated = {
    ...timeline("generated-1", "thread-1", "assistant", ""),
    images: [{
      id: "generated-image-a1b2c3d4e5f60708.png",
      name: "generated-image-a1b2c3d4e5f60708.png",
      generated: true,
    }],
  } satisfies TimelineItem;
  const entries = buildChatEntries({
    selectedThreadId: "thread-1",
    timeline: [generated],
    pendingMessages: [],
    ...emptyRequests,
  }, false);

  assert.equal(entries[0]?.type, "timeline");
  if (entries[0]?.type === "timeline") assert.deepEqual(entries[0].item.images, generated.images);
});

test("keeps downloadable generated files in assistant result entries", () => {
  const generated = {
    ...timeline("generated-file-1", "thread-1", "assistant", ""),
    files: [{
      id: "file-report-1",
      name: "report.pdf",
      size: 42,
      source: "generated" as const,
    }],
  } satisfies TimelineItem;
  const entries = buildChatEntries({
    selectedThreadId: "thread-1",
    timeline: [generated],
    pendingMessages: [],
    ...emptyRequests,
  }, false);

  assert.equal(entries[0]?.type, "timeline");
  if (entries[0]?.type === "timeline") assert.deepEqual(entries[0].item.files, generated.files);
});

test("keeps a pending message with attachments without duplicating its timeline message", () => {
  const pending: PendingMessage = {
    id: "pending-1",
    threadId: "thread-1",
    content: "inspect this",
    createdAt: now,
    state: "sent",
    attachments: [
      { name: "screen.png", kind: "image", size: 100, uri: "file:///screen.png" },
      { name: "notes.txt", kind: "file", size: 42 },
    ],
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
