import type {
  AgentEvent,
  ApprovalRequest,
  ControlSnapshot,
  HostSummary,
  ProjectDirectory,
  ThreadSummary,
  TimelineItem,
  UserInputRequest,
} from "@rhzycode/protocol";
import { preferTimelineItem } from "@rhzycode/protocol";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { desktopHostPlatform } from "../platform/desktop-platform";

const maxEvents = 2_000;
// The complete conversation remains in rollout files. The control-plane
// snapshot only needs recent task activity for reconnecting clients.
const maxTimelineItems = 250;

export interface ControlStoreState {
  snapshot: ControlSnapshot;
  events: AgentEvent[];
  commandReplays?: PersistedCommandReplay[];
}

export interface PersistedCommandReplay {
  key: string;
  fingerprint: string;
  expiresAt: number;
  result: unknown;
  clientMessageId?: string;
}

type AgentEventInput = AgentEvent extends infer Event
  ? Event extends { sequence: number }
    ? Omit<Event, "sequence">
    : never
  : never;

export class ControlStore extends EventEmitter {
  private readonly streamId = randomUUID();
  private hosts = new Map<string, HostSummary>();
  private projects: ProjectDirectory[] = [];
  private threads = new Map<string, ThreadSummary>();
  private timeline = new Map<string, TimelineItem>();
  private approvals = new Map<string, ApprovalRequest>();
  private userInputs = new Map<string, UserInputRequest>();
  private events: AgentEvent[] = [];
  private sequence = 0;
  private commandReplays = new Map<string, PersistedCommandReplay>();

  constructor(state?: ControlStoreState | null) {
    super();
    if (state) {
      this.restore(state);
      return;
    }
    const now = new Date().toISOString();
    this.hosts.set("local-desktop", {
      id: "local-desktop",
      name: "开发工作站",
      platform: desktopHostPlatform(),
      status: "offline",
      lastSeenAt: now,
      activeTaskCount: 0,
    });
  }

  snapshot(): ControlSnapshot {
    return {
      hosts: [...this.hosts.values()],
      projects: [...this.projects],
      threads: [...this.threads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      timeline: [...this.timeline.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      approvals: [...this.approvals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      userInputs: [...this.userInputs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      lastSequence: this.sequence,
      streamId: this.streamId,
      earliestReplaySequence: this.earliestReplaySequence(),
    };
  }

  syncMetadata() {
    return {
      type: "control.sync" as const,
      streamId: this.streamId,
      lastSequence: this.sequence,
      earliestReplaySequence: this.earliestReplaySequence(),
    };
  }

  listEvents(after: number): AgentEvent[] {
    return this.events.filter((event) => event.sequence > after);
  }

  exportState(): ControlStoreState {
    const snapshot = this.snapshot();
    return {
      snapshot: {
        ...snapshot,
        timeline: snapshot.timeline.slice(-maxTimelineItems).map(durableTimelineItem),
        approvals: [],
        userInputs: [],
      },
      // Timeline is already represented by the compact latest-item snapshot.
      // Persisting every accumulated streaming revision duplicates large content.
      events: this.events.filter(isPersistedEvent),
      commandReplays: this.listCommandReplays(),
    };
  }

  getCommandReplay(key: string): PersistedCommandReplay | null {
    this.pruneCommandReplays();
    return this.commandReplays.get(key) || null;
  }

  clientMessageIdForTurn(turnId: string): string | undefined {
    this.pruneCommandReplays();
    for (const entry of this.commandReplays.values()) {
      if (!entry.clientMessageId || !entry.result || typeof entry.result !== "object") continue;
      if ((entry.result as { turnId?: unknown }).turnId === turnId) return entry.clientMessageId;
    }
    return undefined;
  }

  saveCommandReplay(entry: PersistedCommandReplay): void {
    this.pruneCommandReplays();
    this.commandReplays.delete(entry.key);
    this.commandReplays.set(entry.key, entry);
    while (this.commandReplays.size > 500) {
      const oldest = this.commandReplays.keys().next().value as string | undefined;
      if (!oldest) break;
      this.commandReplays.delete(oldest);
    }
    this.emit("replay", entry);
  }

  onCommandReplay(listener: (entry: PersistedCommandReplay) => void): () => void {
    this.on("replay", listener);
    return () => this.off("replay", listener);
  }

  upsertHost(host: HostSummary): AgentEvent {
    return this.publish({ type: "host.status", host });
  }

  upsertThread(thread: ThreadSummary): AgentEvent {
    return this.publish({ type: "thread.updated", thread });
  }

  removeThread(threadId: string): AgentEvent {
    return this.publish({ type: "thread.removed", threadId });
  }

  setProjects(projects: ProjectDirectory[]): AgentEvent {
    return this.publish({ type: "projects.updated", projects: [...projects] });
  }

  resolveApproval(id: string, decision: "approved" | "declined"): AgentEvent | null {
    if (!this.approvals.has(id)) return null;
    return this.publish({ type: "approval.resolved", approvalId: id, decision });
  }

  resolveUserInput(id: string): AgentEvent | null {
    if (!this.userInputs.has(id)) return null;
    return this.publish({ type: "user_input.resolved", requestId: id });
  }

  publish(input: AgentEventInput): AgentEvent {
    const normalizedInput = input.type === "timeline.upserted"
      ? { ...input, item: normalizeTimelineIdentity(input.item) }
      : input;
    const event = { ...normalizedInput, sequence: ++this.sequence } as AgentEvent;
    this.apply(event);
    this.events.push(event);
    if (this.events.length > maxEvents) this.events.splice(0, this.events.length - maxEvents);
    this.emit("event", event);
    return event;
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }

  private apply(event: AgentEvent): void {
    if (event.type === "host.status") this.hosts.set(event.host.id, event.host);
    if (event.type === "thread.updated") this.threads.set(event.thread.id, event.thread);
    if (event.type === "thread.removed") this.threads.delete(event.threadId);
    if (event.type === "projects.updated") this.projects = [...event.projects];
    if (event.type === "timeline.upserted") {
      const key = timelineIdentityKey(event.item);
      const current = this.timeline.get(key);
      this.timeline.set(key, current ? preferTimelineItem(current, event.item) : event.item);
    }
    if (event.type === "approval.requested") this.approvals.set(event.approval.id, event.approval);
    if (event.type === "approval.resolved") this.approvals.delete(event.approvalId);
    if (event.type === "user_input.requested") this.userInputs.set(event.request.id, event.request);
    if (event.type === "user_input.resolved") this.userInputs.delete(event.requestId);
  }

  private restore(state: ControlStoreState): void {
    for (const host of state.snapshot.hosts) this.hosts.set(host.id, host);
    this.projects = [...(state.snapshot.projects || [])];
    for (const thread of state.snapshot.threads) this.threads.set(thread.id, thread);
    for (const rawItem of state.snapshot.timeline.slice(-maxTimelineItems)) {
      const item = normalizeTimelineIdentity(rawItem);
      this.timeline.set(timelineIdentityKey(item), item);
    }
    this.events = state.events.filter(isDurableEvent).slice(-maxEvents);
    for (const entry of state.commandReplays || []) {
      if (isPersistedCommandReplay(entry)) this.commandReplays.set(entry.key, entry);
    }
    this.pruneCommandReplays();
    this.sequence = Math.max(
      state.snapshot.lastSequence,
      ...this.events.map((event) => event.sequence),
      0,
    );
  }

  private earliestReplaySequence(): number {
    return this.events[0]?.sequence ?? this.sequence + 1;
  }

  private listCommandReplays(): PersistedCommandReplay[] {
    this.pruneCommandReplays();
    return [...this.commandReplays.values()];
  }

  private pruneCommandReplays(): void {
    const now = Date.now();
    for (const [key, entry] of this.commandReplays) {
      if (entry.expiresAt <= now) this.commandReplays.delete(key);
    }
  }
}

function isDurableEvent(event: AgentEvent): boolean {
  return event.type === "host.status"
    || event.type === "projects.updated"
    || event.type === "thread.updated"
    || event.type === "thread.removed"
    || event.type === "timeline.upserted";
}

function isPersistedEvent(event: AgentEvent): boolean {
  return isDurableEvent(event) && event.type !== "timeline.upserted";
}

function durableTimelineItem(item: TimelineItem): TimelineItem {
  const files = item.files?.filter((file) =>
    file.source === "generated" || file.mimeType?.startsWith("image/") === true) || [];
  const { files: _transientFiles, ...durable } = item;
  return files.length ? { ...durable, files } : durable;
}

function normalizeTimelineIdentity(item: TimelineItem): TimelineItem {
  const logicalId = item.logicalId
    || (item.clientMessageId ? `client-message:${item.clientMessageId}` : undefined);
  return {
    ...item,
    ...(logicalId ? { logicalId } : {}),
  };
}

function timelineIdentityKey(item: TimelineItem): string {
  return `${item.threadId}\u0000${item.logicalId || item.id}`;
}

function isPersistedCommandReplay(value: unknown): value is PersistedCommandReplay {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PersistedCommandReplay>;
  return typeof entry.key === "string"
    && entry.key.length > 0
    && typeof entry.fingerprint === "string"
    && entry.fingerprint.length > 0
    && typeof entry.expiresAt === "number"
    && Number.isFinite(entry.expiresAt)
    && entry.expiresAt > Date.now()
    && (entry.clientMessageId === undefined || typeof entry.clientMessageId === "string")
    && Object.prototype.hasOwnProperty.call(entry, "result");
}

export type { AgentEventInput };
