import assert from "node:assert/strict";
import test from "node:test";
import {
  codexComposerCommandPrompt,
  parseCodexComposerCommand,
  type TimelineItem,
} from "@rhzycode/protocol";
import {
  assistantDisplayContent,
  buildChatEntries,
  claimPendingTimelineMatches,
  composerInteractionState,
  conversationPageSwipeDirection,
  countActivityEntries,
  findRetryablePendingMessage,
  isResultEntry,
  isSparseThreadHistory,
  isThreadHistoryLoading,
  needsThreadHistoryCatchUp,
  openThreadHistoryRetryDelayMs,
  openThreadHistorySoftRetryDelayMs,
  reconcilePendingMessages,
  resumeConnectionAction,
  shouldCaptureConversationPageSwipe,
  shouldCatchUpActiveThread,
  shouldContinueThreadHistorySoftRetry,
  shouldKeepSelectedThread,
  shouldOpenThreadHistory,
  shouldReloadCompletedThreadHistory,
  shouldResetOpenedThreadHistory,
  shouldRetryOpenThreadHistory,
  shouldRetrySparseThreadHistory,
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

test("parses Codex composer commands without intercepting escaped or multiline prompts", () => {
  assert.deepEqual(parseCodexComposerCommand(" /resume thread-1 "), {
    name: "resume",
    args: "thread-1",
    known: true,
  });
  assert.deepEqual(parseCodexComposerCommand("/unknown"), {
    name: "unknown",
    args: "",
    known: false,
  });
  assert.equal(parseCodexComposerCommand("//new"), null);
  assert.equal(parseCodexComposerCommand("/new\nwith context"), null);
  assert.match(
    codexComposerCommandPrompt(parseCodexComposerCommand("/review security")!) || "",
    /Additional request: security/,
  );
});

test("hides separator-only assistant noise while a reply is running", () => {
  assert.equal(assistantDisplayContent({
    status: "running",
    title: "RHZYCODE",
    content: "----------------\n----------------\n----------------",
  }), "");
  assert.equal(assistantDisplayContent({
    status: "running",
    title: "RHZYCODE",
    content: "----------------\nUseful reply",
  }), "----------------\nUseful reply");
  assert.equal(assistantDisplayContent({
    status: "completed",
    title: "RHZYCODE",
    content: "----------------\n----------------\n----------------",
  }), "----------------\n----------------\n----------------");
});

test("loads history only while an existing selected thread is opening", () => {
  assert.equal(isThreadHistoryLoading(null, null), false);
  assert.equal(isThreadHistoryLoading("thread-1", null), false);
  assert.equal(isThreadHistoryLoading("thread-1", "thread-2"), false);
  assert.equal(isThreadHistoryLoading("thread-1", "thread-1"), true);
});

test("keeps the composer editable while history loads but waits before sending", () => {
  assert.deepEqual(composerInteractionState({
    hasConversation: true,
    canWrite: true,
    online: true,
    historyLoading: true,
  }), {
    editable: true,
    sendReady: false,
  });
  assert.deepEqual(composerInteractionState({
    hasConversation: true,
    canWrite: true,
    online: true,
    historyLoading: false,
  }), {
    editable: true,
    sendReady: true,
  });
});

test("keeps a newly started thread selected while its server summary is delayed", () => {
  assert.equal(shouldKeepSelectedThread("thread-new", [], [{ threadId: "thread-new" }]), true);
  assert.equal(shouldKeepSelectedThread("thread-new", [{ id: "thread-new" }], []), true);
  assert.equal(shouldKeepSelectedThread("thread-new", [{ id: "thread-old" }], []), false);
  assert.equal(shouldKeepSelectedThread(null, [{ id: "thread-new" }], [{ threadId: "thread-new" }]), false);
});

test("reloads authoritative history only after a mobile-started turn stops", () => {
  assert.equal(shouldReloadCompletedThreadHistory({
    selectedThreadId: "thread-1",
    threadStatus: "running",
    online: true,
    needsCatchUp: true,
  }), false);
  assert.equal(shouldReloadCompletedThreadHistory({
    selectedThreadId: "thread-1",
    threadStatus: "completed",
    online: true,
    needsCatchUp: true,
  }), true);
  assert.equal(shouldReloadCompletedThreadHistory({
    selectedThreadId: "thread-1",
    threadStatus: "failed",
    online: false,
    needsCatchUp: true,
  }), false);
});

test("captures deliberate horizontal page swipes without stealing vertical scrolling", () => {
  assert.equal(shouldCaptureConversationPageSwipe(18, 4), true);
  assert.equal(shouldCaptureConversationPageSwipe(14, 20), false);
  assert.equal(shouldCaptureConversationPageSwipe(30, 22), false);
});

test("switches pages for a short flick or a clear horizontal drag", () => {
  assert.equal(conversationPageSwipeDirection(-24, 4, -0.5, 400), "next");
  assert.equal(conversationPageSwipeDirection(50, 8, 0.1, 400), "previous");
  assert.equal(conversationPageSwipeDirection(-30, 4, -0.1, 400), null);
  assert.equal(conversationPageSwipeDirection(-80, 70, -0.8, 400), null);
});

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

test("keeps protocol timeline messages without client-side content filtering", () => {
  const entries = buildChatEntries({
    selectedThreadId: "thread-1",
    timeline: [
      timeline("user-real", "thread-1", "user", "Keep the real question"),
      timeline("assistant-real", "thread-1", "assistant", "Keep the real answer"),
      timeline(
        "handoff-user",
        "thread-1",
        "user",
        "Another language model started to solve this problem and produced a summary of its thinking process.\nInternal transfer",
      ),
      timeline("handoff-assistant", "thread-1", "assistant", "## Handoff Summary\n\nInternal state"),
      timeline("mention", "thread-1", "assistant", "The text ## Handoff Summary is safe in the middle."),
    ],
    pendingMessages: [],
    ...emptyRequests,
  }, false);

  assert.deepEqual(entries.map((entry) => entry.id), [
    "timeline:handoff-user",
    "timeline:user-real",
    "timeline:assistant-real",
    "timeline:handoff-assistant",
    "timeline:mention",
  ]);
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

test("replaces an attachment pending row with the matching server timeline row", () => {
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
    timeline: [{
      ...timeline("user-1", "thread-1", "user", pending.content),
      clientMessageId: pending.id,
    }],
    pendingMessages: [pending],
    ...emptyRequests,
  }, false);

  assert.deepEqual(entries.map((entry) => entry.id), ["timeline:user-1"]);
  assert.deepEqual(reconcilePendingMessages([pending], entries.flatMap((entry) => (
    entry.type === "timeline" ? [entry.item] : []
  ))), []);
});
test("claims repeated prompts one-to-one using the echoed client message id", () => {
  const pending: PendingMessage[] = [
    { id: "pending-1", threadId: "thread-1", content: "continue", createdAt: now, state: "sent" },
    { id: "pending-2", threadId: "thread-1", content: "continue", createdAt: now, state: "sent" },
  ];
  const serverItem = {
    ...timeline("user-2", "thread-1", "user", "continue"),
    clientMessageId: "pending-2",
  };
  const matches = claimPendingTimelineMatches(pending, [serverItem]);
  const entries = buildChatEntries({
    selectedThreadId: "thread-1",
    timeline: [serverItem],
    pendingMessages: pending,
    ...emptyRequests,
  }, false);

  assert.deepEqual([...matches], [["pending-2", "user-2"]]);
  assert.deepEqual(entries.map((entry) => entry.id), ["timeline:user-2", "pending:pending-1"]);
});

test("reconciles in-flight and failed optimistic rows when recent server history omits the client message id", () => {
  const pending: PendingMessage[] = [
    { id: "pending-1", threadId: "thread-1", content: "same", createdAt: "2026-07-20T10:00:03.000Z", state: "sending" },
    { id: "pending-2", threadId: "thread-1", content: "same", createdAt: "2026-07-20T10:01:03.000Z", state: "failed" },
  ];
  const serverItems = [
    { ...timeline("user-1", "thread-1", "user", "same"), createdAt: "2026-07-20T10:00:00.000Z" },
    { ...timeline("user-2", "thread-1", "user", "same"), createdAt: "2026-07-20T10:01:00.000Z" },
  ];

  assert.deepEqual([...claimPendingTimelineMatches(pending, serverItems)], [
    ["pending-1", "user-1"],
    ["pending-2", "user-2"],
  ]);
  assert.deepEqual(reconcilePendingMessages(pending, serverItems), []);
});

test("does not match a new optimistic send to old identical history", () => {
  const pending: PendingMessage = {
    id: "pending-new",
    threadId: "thread-1",
    content: "continue",
    createdAt: now,
    state: "sending",
  };
  const oldItem = {
    ...timeline("user-old", "thread-1", "user", "continue"),
    createdAt: "2026-07-20T09:00:00.000Z",
  };

  assert.equal(claimPendingTimelineMatches([pending], [oldItem]).size, 0);
  assert.deepEqual(
    buildChatEntries({
      selectedThreadId: "thread-1",
      timeline: [oldItem],
      pendingMessages: [pending],
      ...emptyRequests,
    }, false).map((entry) => entry.id),
    ["timeline:user-old", "pending:pending-new"],
  );
});

test("reuses the latest failed pending id only for the same payload", () => {
  const failed: PendingMessage = {
    id: "pending-failed",
    threadId: "thread-1",
    content: "inspect this",
    createdAt: now,
    state: "failed",
    attachments: [{ name: "screen.png", kind: "image", size: 100 }],
  };

  assert.equal(findRetryablePendingMessage([failed], {
    threadId: "thread-1",
    content: " inspect   this ",
    attachments: [{ name: "screen.png", kind: "image", size: 100 }],
  })?.id, failed.id);
  assert.equal(findRetryablePendingMessage([failed], {
    threadId: "thread-1",
    content: "inspect something else",
    attachments: [{ name: "screen.png", kind: "image", size: 100 }],
  }), null);
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

test("skips reopen after the thread history was already loaded", () => {
  assert.equal(shouldOpenThreadHistory({
    selectedThreadId: "thread-1",
    online: true,
    alreadyOpenedThreadId: null,
  }), true);
  assert.equal(shouldOpenThreadHistory({
    selectedThreadId: "thread-1",
    online: true,
    alreadyOpenedThreadId: "thread-1",
  }), false);
  assert.equal(shouldOpenThreadHistory({
    selectedThreadId: "thread-2",
    online: true,
    alreadyOpenedThreadId: "thread-1",
  }), true);
});

test("does not open history while offline, archived, or unselected", () => {
  assert.equal(shouldOpenThreadHistory({
    selectedThreadId: null,
    online: true,
    alreadyOpenedThreadId: null,
  }), false);
  assert.equal(shouldOpenThreadHistory({
    selectedThreadId: "thread-1",
    online: false,
    alreadyOpenedThreadId: null,
  }), false);
  assert.equal(shouldOpenThreadHistory({
    selectedThreadId: "thread-1",
    selectedIsArchived: true,
    online: true,
    alreadyOpenedThreadId: null,
  }), false);
});

test("chooses resync on resume when the socket survived backgrounding", () => {
  assert.equal(resumeConnectionAction(true), "resync");
  assert.equal(resumeConnectionAction(false), "reconnect");
});

test("reopens history after each offline recovery while skipping duplicate online flaps", () => {
  let opened: string | null = null;
  let previousStatus: string | null = null;
  const statuses = ["online", "offline", "connecting", "online", "online", "offline", "online"] as const;
  let openCount = 0;
  for (const status of statuses) {
    if (shouldResetOpenedThreadHistory(previousStatus, status)) opened = null;
    previousStatus = status;
    if (shouldOpenThreadHistory({
      selectedThreadId: "thread-1",
      online: status === "online",
      alreadyOpenedThreadId: opened,
    })) {
      openCount += 1;
      opened = "thread-1";
    }
  }
  assert.equal(openCount, 3);
});

test("catch-up polling only runs for active remote turns while online", () => {
  assert.equal(shouldCatchUpActiveThread({ online: true, threadStatus: "running" }), true);
  assert.equal(shouldCatchUpActiveThread({ online: true, threadStatus: "waiting_for_approval" }), true);
  assert.equal(shouldCatchUpActiveThread({ online: true, threadStatus: "idle" }), false);
  assert.equal(shouldCatchUpActiveThread({ online: false, threadStatus: "running" }), false);
});

test("resets opened history when the live connection drops", () => {
  assert.equal(shouldResetOpenedThreadHistory("online", "offline"), true);
  assert.equal(shouldResetOpenedThreadHistory("online", "connecting"), true);
  assert.equal(shouldResetOpenedThreadHistory("offline", "connecting"), false);
  assert.equal(shouldResetOpenedThreadHistory("connecting", "online"), false);
});


test("isSparseThreadHistory marks conversations that still lack AI replies", () => {
  assert.equal(isSparseThreadHistory([
    timeline("u1", "thread-1", "user", "hello"),
    timeline("u2", "thread-1", "user", "again"),
  ], "thread-1"), true);
  assert.equal(isSparseThreadHistory([
    timeline("u1", "thread-1", "user", "hello"),
    timeline("a1", "thread-1", "assistant", "hi"),
  ], "thread-1"), false);
  assert.equal(isSparseThreadHistory([
    timeline("u1", "thread-1", "user", "hello"),
    timeline("a1", "thread-other", "assistant", "hi"),
  ], "thread-1"), true);
});

test("shouldRetrySparseThreadHistory bounds flaky openThread catch-up", () => {
  assert.equal(shouldRetrySparseThreadHistory({ online: true, attempt: 0, sparse: true }), true);
  assert.equal(shouldRetrySparseThreadHistory({ online: true, attempt: 3, sparse: true }), true);
  assert.equal(shouldRetrySparseThreadHistory({ online: true, attempt: 4, sparse: true }), false);
  assert.equal(shouldRetrySparseThreadHistory({ online: false, attempt: 0, sparse: true }), false);
  assert.equal(shouldRetrySparseThreadHistory({ online: true, attempt: 0, sparse: false }), false);
});

test("shouldRetryOpenThreadHistory retries sparse payloads and retryable errors", () => {
  assert.equal(shouldRetryOpenThreadHistory({ online: true, attempt: 0, sparse: true }), true);
  assert.equal(shouldRetryOpenThreadHistory({ online: true, attempt: 5, sparse: true }), true);
  assert.equal(shouldRetryOpenThreadHistory({ online: true, attempt: 6, sparse: true }), false);
  assert.equal(shouldRetryOpenThreadHistory({
    online: true,
    attempt: 1,
    error: new Error("timeout"),
    isRetryableError: () => true,
  }), true);
  assert.equal(shouldRetryOpenThreadHistory({
    online: true,
    attempt: 1,
    error: new Error("unauthorized"),
    isRetryableError: () => false,
  }), false);
  assert.equal(shouldRetryOpenThreadHistory({
    online: false,
    attempt: 0,
    error: new Error("timeout"),
    isRetryableError: () => true,
  }), false);
});

test("openThread history retry delays stay bounded", () => {
  assert.equal(openThreadHistoryRetryDelayMs(1), 1_000);
  assert.equal(openThreadHistoryRetryDelayMs(3), 3_000);
  assert.equal(openThreadHistoryRetryDelayMs(20), 10_000);
  assert.equal(openThreadHistorySoftRetryDelayMs(1), 12_000);
  assert.equal(openThreadHistorySoftRetryDelayMs(10), 30_000);
});

test("soft history retries cover sparse payloads and exhausted network errors", () => {
  assert.equal(needsThreadHistoryCatchUp({ sparse: true }), true);
  assert.equal(needsThreadHistoryCatchUp({
    error: new Error("timeout"),
    isRetryableError: () => true,
  }), true);
  assert.equal(needsThreadHistoryCatchUp({
    error: new Error("unauthorized"),
    isRetryableError: () => false,
  }), false);
  assert.equal(shouldContinueThreadHistorySoftRetry({
    online: true,
    needsCatchUp: true,
    softAttempt: 0,
  }), true);
  assert.equal(shouldContinueThreadHistorySoftRetry({
    online: true,
    needsCatchUp: true,
    softAttempt: 9,
  }), true);
  assert.equal(shouldContinueThreadHistorySoftRetry({
    online: true,
    needsCatchUp: true,
    softAttempt: 10,
  }), false);
  assert.equal(shouldContinueThreadHistorySoftRetry({
    online: true,
    needsCatchUp: false,
    softAttempt: 0,
  }), false);
  assert.equal(shouldContinueThreadHistorySoftRetry({
    online: false,
    needsCatchUp: true,
    softAttempt: 0,
  }), false);
});
