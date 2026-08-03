import type {
  ApprovalRequest,
  TimelineItem,
  UserInputRequest,
} from "@rhzycode/protocol";

export interface PendingMessage {
  id: string;
  threadId: string;
  content: string;
  createdAt: string;
  state: "sending" | "sent" | "failed";
  attachments?: Array<{
    name: string;
    kind: "file" | "image";
    size: number;
    uri?: string;
  }>;
}

export type ChatEntry =
  | { type: "timeline"; id: string; createdAt: string; item: TimelineItem }
  | { type: "approval"; id: string; createdAt: string; approval: ApprovalRequest }
  | { type: "input"; id: string; createdAt: string; request: UserInputRequest }
  | { type: "pending"; id: string; createdAt: string; message: PendingMessage };

interface ChatEntrySource {
  selectedThreadId: string | null;
  timeline: TimelineItem[];
  approvals: ApprovalRequest[];
  userInputs: UserInputRequest[];
  pendingMessages: PendingMessage[];
}

type ActivitySource = Pick<ChatEntrySource, "selectedThreadId" | "timeline" | "approvals" | "userInputs">;

export function isThreadHistoryLoading(
  selectedThreadId: string | null,
  openingThreadId: string | null,
): boolean {
  return Boolean(selectedThreadId && openingThreadId === selectedThreadId);
}

export function composerInteractionState(options: {
  hasConversation: boolean;
  canWrite: boolean;
  online: boolean;
  historyLoading: boolean;
}): { editable: boolean; sendReady: boolean } {
  const editable = options.hasConversation && options.canWrite && options.online;
  return {
    editable,
    sendReady: editable && !options.historyLoading,
  };
}

/** Whether openThread should run for the selected conversation. */
export function shouldOpenThreadHistory(options: {
  selectedThreadId: string | null;
  selectedIsArchived?: boolean;
  online: boolean;
  alreadyOpenedThreadId: string | null;
}): boolean {
  if (!options.selectedThreadId || !options.online || options.selectedIsArchived) return false;
  return options.alreadyOpenedThreadId !== options.selectedThreadId;
}

export function shouldKeepSelectedThread(
  selectedThreadId: string | null,
  threads: ReadonlyArray<{ id: string }>,
  pendingMessages: ReadonlyArray<Pick<PendingMessage, "threadId">>,
): boolean {
  return Boolean(selectedThreadId && (
    threads.some((thread) => thread.id === selectedThreadId)
    || pendingMessages.some((message) => message.threadId === selectedThreadId)
  ));
}


/** Active remote turns need periodic snapshot catch-up when the live stream is lossy. */
export function shouldCatchUpActiveThread(options: {
  online: boolean;
  threadStatus?: string | null;
}): boolean {
  if (!options.online || !options.threadStatus) return false;
  return ["running", "waiting_for_approval", "waiting_for_input"].includes(options.threadStatus);
}

/** A mobile-started turn gets one authoritative history reload after it stops. */
export function shouldReloadCompletedThreadHistory(options: {
  selectedThreadId: string | null;
  threadStatus?: string | null;
  online: boolean;
  needsCatchUp: boolean;
}): boolean {
  return Boolean(
    options.selectedThreadId
    && options.threadStatus
    && options.online
    && options.needsCatchUp
    && !shouldCatchUpActiveThread({ online: true, threadStatus: options.threadStatus }),
  );
}

/** True when opened history still looks user-heavy and likely missing AI replies. */
export function isSparseThreadHistory(
  timeline: ReadonlyArray<Pick<TimelineItem, "threadId" | "kind">>,
  threadId: string | null | undefined,
): boolean {
  if (!threadId) return false;
  let users = 0;
  let assistants = 0;
  for (const item of timeline) {
    if (item.threadId !== threadId) continue;
    if (item.kind === "user") users += 1;
    if (item.kind === "assistant") assistants += 1;
  }
  return users > 0 && assistants < users;
}

/** Whether a sparse openThread result should keep retrying instead of locking the cache. */
export function shouldRetrySparseThreadHistory(options: {
  online: boolean;
  attempt: number;
  maxAttempts?: number;
  sparse: boolean;
}): boolean {
  return shouldRetryOpenThreadHistory({
    online: options.online,
    attempt: options.attempt,
    maxAttempts: options.maxAttempts ?? 4,
    sparse: options.sparse,
  });
}

/**
 * Unified openThread catch-up policy for sparse history and retryable transport
 * failures. `attempt` is how many retries were already spent (0 = first try done).
 */
export function shouldRetryOpenThreadHistory(options: {
  online: boolean;
  attempt: number;
  maxAttempts?: number;
  sparse?: boolean;
  error?: unknown;
  isRetryableError?: (error: unknown) => boolean;
}): boolean {
  if (!options.online) return false;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 6));
  if (options.attempt >= maxAttempts) return false;
  if (options.error !== undefined) {
    return Boolean(options.isRetryableError?.(options.error));
  }
  return Boolean(options.sparse);
}

/** Backoff between immediate openThread history retries. */
export function openThreadHistoryRetryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(10_000, 1_000 * n);
}

/** Quiet follow-up delay after the immediate retry budget is exhausted. */
export function openThreadHistorySoftRetryDelayMs(softAttempt = 1): number {
  const n = Math.max(1, Math.floor(softAttempt));
  return Math.min(30_000, 12_000 + (n - 1) * 3_000);
}

/** Sparse payloads and retryable transport failures both need quiet catch-up. */
export function needsThreadHistoryCatchUp(options: {
  sparse?: boolean;
  error?: unknown;
  isRetryableError?: (error: unknown) => boolean;
}): boolean {
  if (options.sparse) return true;
  return options.error !== undefined && Boolean(options.isRetryableError?.(options.error));
}

/** Keep softly polling while the selected thread history is still incomplete. */
export function shouldContinueThreadHistorySoftRetry(options: {
  online: boolean;
  needsCatchUp: boolean;
  softAttempt: number;
  maxSoftAttempts?: number;
}): boolean {
  if (!options.online || !options.needsCatchUp) return false;
  const maxSoftAttempts = Math.max(0, Math.floor(options.maxSoftAttempts ?? 10));
  return options.softAttempt < maxSoftAttempts;
}

/** Drop cached openThread state after an offline stretch so history reloads on recovery. */
export function shouldResetOpenedThreadHistory(previousStatus: string | null | undefined, nextStatus: string): boolean {
  if (nextStatus === "offline") return true;
  // connecting after a live session also means the socket is gone; force history reload.
  if (nextStatus === "connecting" && previousStatus === "online") return true;
  return false;
}

/** Foreground resume: keep the socket when possible and only hard-reconnect when it is down. */
export function resumeConnectionAction(socketOpen: boolean): "resync" | "reconnect" {
  return socketOpen ? "resync" : "reconnect";
}

export function shouldCaptureConversationPageSwipe(dx: number, dy: number): boolean {
  const horizontalDistance = Math.abs(dx);
  return horizontalDistance >= 12 && horizontalDistance > Math.abs(dy) * 1.5;
}

export function conversationPageSwipeDirection(
  dx: number,
  dy: number,
  velocityX: number,
  pageWidth: number,
): "previous" | "next" | null {
  if (!shouldCaptureConversationPageSwipe(dx, dy)) return null;
  const horizontalDistance = Math.abs(dx);
  const distanceThreshold = Math.min(56, Math.max(40, pageWidth * 0.12));
  const fastSwipe = Math.abs(velocityX) >= 0.35 && horizontalDistance >= 20;
  if (!fastSwipe && horizontalDistance < distanceThreshold) return null;
  return dx < 0 ? "next" : "previous";
}

export function isResultEntry(entry: ChatEntry): boolean {
  if (entry.type === "pending") return true;
  if (entry.type !== "timeline") return false;
  return entry.item.kind === "user" || entry.item.kind === "assistant";
}

function normalizeMessageContent(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function attachmentSignature(
  attachments: ReadonlyArray<{ name: string; kind: "file" | "image"; size: number }> = [],
): string {
  return attachments
    .map((attachment) => `${attachment.kind}\u0000${attachment.name}\u0000${attachment.size}`)
    .sort()
    .join("\n");
}

export function findRetryablePendingMessage(
  pendingMessages: PendingMessage[],
  input: {
    threadId: string;
    content: string;
    attachments?: ReadonlyArray<{ name: string; kind: "file" | "image"; size: number }>;
  },
): PendingMessage | null {
  const content = normalizeMessageContent(input.content);
  const attachments = attachmentSignature(input.attachments);
  return pendingMessages
    .filter((message) => (
      message.state === "failed"
      && message.threadId === input.threadId
      && normalizeMessageContent(message.content) === content
      && attachmentSignature(message.attachments) === attachments
    ))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0]
    || null;
}

/** One-to-one claim of server user rows by local optimistic sends. */
export function claimPendingTimelineMatches(
  pendingMessages: PendingMessage[],
  timeline: TimelineItem[],
): Map<string, string> {
  const claimedTimelineIds = new Set<string>();
  const matches = new Map<string, string>();
  const userItems = timeline
    .filter((item) => item.kind === "user")
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const orderedPending = pendingMessages
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));

  for (const pending of orderedPending) {
    const match = userItems.find((item) => (
      item.threadId === pending.threadId
      && item.clientMessageId === pending.id
      && !claimedTimelineIds.has(item.id)
    ));
    if (!match) continue;
    claimedTimelineIds.add(match.id);
    matches.set(pending.id, match.id);
  }

  return matches;
}

export function reconcilePendingMessages(
  pendingMessages: PendingMessage[],
  timeline: TimelineItem[],
): PendingMessage[] {
  if (!pendingMessages.length) return pendingMessages;
  const matches = claimPendingTimelineMatches(pendingMessages, timeline);
  if (!matches.size) return pendingMessages;
  return pendingMessages.filter((message) => !matches.has(message.id));
}

function compareChatEntries(left: ChatEntry, right: ChatEntry): number {
  const byTime = left.createdAt.localeCompare(right.createdAt);
  if (byTime) return byTime;
  // Keep stable ordering when timestamps collide during weak-network merges.
  const rank = (entry: ChatEntry): number => {
    if (entry.type === "timeline") {
      if (entry.item.kind === "user") return 0;
      if (entry.item.kind === "assistant") return 1;
      return 2;
    }
    if (entry.type === "pending") return 3;
    if (entry.type === "approval") return 4;
    return 5;
  };
  const byRank = rank(left) - rank(right);
  if (byRank) return byRank;
  return left.id.localeCompare(right.id);
}

export function buildChatEntries(source: ChatEntrySource, includeActivity: boolean): ChatEntry[] {
  if (!source.selectedThreadId) return [];
  const timeline = source.timeline.filter((item) => item.threadId === source.selectedThreadId);
  const threadPending = source.pendingMessages.filter((message) => message.threadId === source.selectedThreadId);
  const matchedPendingIds = new Set(claimPendingTimelineMatches(threadPending, timeline).keys());
  const visiblePending = threadPending.filter((message) => !matchedPendingIds.has(message.id));

  return [
    ...timeline.filter((item) => (
      includeActivity || item.kind === "user" || item.kind === "assistant"
    )).map((item): ChatEntry => ({
      type: "timeline",
      id: `timeline:${item.id}`,
      createdAt: item.createdAt,
      item,
    })),
    ...visiblePending.map((message): ChatEntry => ({
      type: "pending",
      id: `pending:${message.id}`,
      createdAt: message.createdAt,
      message,
    })),
    ...(includeActivity ? source.approvals
      .filter((approval) => approval.threadId === source.selectedThreadId)
      .map((approval): ChatEntry => ({
        type: "approval",
        id: `approval:${approval.id}`,
        createdAt: approval.createdAt,
        approval,
      })) : []),
    ...(includeActivity ? source.userInputs
      .filter((request) => request.threadId === source.selectedThreadId)
      .map((request): ChatEntry => ({
        type: "input",
        id: `input:${request.id}`,
        createdAt: request.createdAt,
        request,
      })) : []),
  ].sort(compareChatEntries);
}

export function countActivityEntries(source: ActivitySource): number {
  if (!source.selectedThreadId) return 0;
  return source.timeline.filter((item) => (
    item.threadId === source.selectedThreadId
    && item.kind !== "user"
    && item.kind !== "assistant"
  )).length
    + source.approvals.filter((item) => item.threadId === source.selectedThreadId).length
    + source.userInputs.filter((item) => item.threadId === source.selectedThreadId).length;
}
