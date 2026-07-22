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
import { EventEmitter } from "node:events";

const maxEvents = 2_000;
const maxTimelineItems = 2_000;

export interface ControlStoreState {
  snapshot: ControlSnapshot;
  events: AgentEvent[];
}

type AgentEventInput = AgentEvent extends infer Event
  ? Event extends { sequence: number }
    ? Omit<Event, "sequence">
    : never
  : never;

export class ControlStore extends EventEmitter {
  private hosts = new Map<string, HostSummary>();
  private projects: ProjectDirectory[] = [];
  private threads = new Map<string, ThreadSummary>();
  private timeline = new Map<string, TimelineItem>();
  private approvals = new Map<string, ApprovalRequest>();
  private userInputs = new Map<string, UserInputRequest>();
  private events: AgentEvent[] = [];
  private sequence = 0;

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
      platform: "windows",
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
      events: this.events.filter(isDurableEvent).map(durableEvent),
    };
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
    const event = { ...input, sequence: ++this.sequence } as AgentEvent;
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
    if (event.type === "timeline.upserted") this.timeline.set(event.item.id, event.item);
    if (event.type === "approval.requested") this.approvals.set(event.approval.id, event.approval);
    if (event.type === "approval.resolved") this.approvals.delete(event.approvalId);
    if (event.type === "user_input.requested") this.userInputs.set(event.request.id, event.request);
    if (event.type === "user_input.resolved") this.userInputs.delete(event.requestId);
  }

  private restore(state: ControlStoreState): void {
    for (const host of state.snapshot.hosts) this.hosts.set(host.id, host);
    this.projects = [...(state.snapshot.projects || [])];
    for (const thread of state.snapshot.threads) this.threads.set(thread.id, thread);
    for (const item of state.snapshot.timeline.slice(-maxTimelineItems)) this.timeline.set(item.id, item);
    this.events = state.events.filter(isDurableEvent).slice(-maxEvents);
    this.sequence = Math.max(
      state.snapshot.lastSequence,
      ...this.events.map((event) => event.sequence),
      0,
    );
  }
}

function isDurableEvent(event: AgentEvent): boolean {
  return event.type === "host.status"
    || event.type === "projects.updated"
    || event.type === "thread.updated"
    || event.type === "thread.removed"
    || event.type === "timeline.upserted";
}

function durableEvent(event: AgentEvent): AgentEvent {
  return event.type === "timeline.upserted"
    ? { ...event, item: durableTimelineItem(event.item) }
    : event;
}

function durableTimelineItem(item: TimelineItem): TimelineItem {
  const files = item.files?.filter((file) => file.source === "generated") || [];
  const { files: _transientFiles, ...durable } = item;
  return files.length ? { ...durable, files } : durable;
}

export type { AgentEventInput };
