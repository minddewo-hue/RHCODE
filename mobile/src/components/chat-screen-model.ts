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

export function isResultEntry(entry: ChatEntry): boolean {
  if (entry.type === "pending") return true;
  if (entry.type !== "timeline") return false;
  return entry.item.kind === "user" || entry.item.kind === "assistant";
}

export function buildChatEntries(source: ChatEntrySource, includeActivity: boolean): ChatEntry[] {
  if (!source.selectedThreadId) return [];
  const timeline = source.timeline.filter((item) => item.threadId === source.selectedThreadId);
  const attachmentMessages = source.pendingMessages.filter((message) => message.attachments?.length);
  const visiblePending = source.pendingMessages.filter((message) => (
    message.threadId === source.selectedThreadId
    && (message.attachments?.length
      || !timeline.some((item) => item.kind === "user" && item.content.trim() === message.content.trim()))
  ));

  return [
    ...timeline.filter((item) => (
      (includeActivity || item.kind === "user" || item.kind === "assistant")
      && !(item.kind === "user" && attachmentMessages.some((message) => (
        message.threadId === item.threadId && message.content.trim() === item.content.trim()
      )))
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
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
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
