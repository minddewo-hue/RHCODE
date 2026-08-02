import type { AgentEvent, ControlSnapshot, RemoteThreadOpenResult, TimelineItem } from "@rhzycode/protocol";
import { dedupeTimelineItems, preferTimelineItem } from "@rhzycode/protocol";

export const emptyControlSnapshot: ControlSnapshot = {
  hosts: [],
  projects: [],
  threads: [],
  timeline: [],
  approvals: [],
  userInputs: [],
  lastSequence: 0,
};

export function applyAgentEvent(snapshot: ControlSnapshot, event: AgentEvent): ControlSnapshot {
  const next = { ...snapshot, lastSequence: Math.max(snapshot.lastSequence, event.sequence) };

  switch (event.type) {
    case "host.status":
      next.hosts = upsertById(snapshot.hosts, event.host);
      break;
    case "thread.updated":
      next.threads = upsertById(snapshot.threads, event.thread);
      break;
    case "thread.removed":
      next.threads = snapshot.threads.filter((thread) => thread.id !== event.threadId);
      break;
    case "projects.updated":
      next.projects = event.projects;
      break;
    case "timeline.upserted":
      next.timeline = upsertTimeline(snapshot.timeline, event.item);
      break;
    case "approval.requested":
      next.approvals = upsertById(snapshot.approvals, event.approval);
      break;
    case "approval.resolved":
      next.approvals = snapshot.approvals.filter((approval) => approval.id !== event.approvalId);
      break;
    case "user_input.requested":
      next.userInputs = upsertById(snapshot.userInputs, event.request);
      break;
    case "user_input.resolved":
      next.userInputs = snapshot.userInputs.filter((request) => request.id !== event.requestId);
      break;
  }

  return next;
}

export function hydrateThreadSnapshot(
  snapshot: ControlSnapshot,
  result: RemoteThreadOpenResult,
): ControlSnapshot {
  const timeline = new Map(snapshot.timeline.map((item) => [item.id, item]));
  for (const item of result.timeline) {
    const current = timeline.get(item.id);
    timeline.set(item.id, current ? preferTimelineItem(current, item) : item);
  }
  return {
    ...snapshot,
    threads: upsertById(snapshot.threads, result.thread),
    timeline: dedupeTimelineItems([...timeline.values()]),
  };
}

export function mergeControlSnapshot(
  current: ControlSnapshot,
  incoming: ControlSnapshot,
): ControlSnapshot {
  const incomingIsStale = incoming.lastSequence < current.lastSequence;
  const base = incomingIsStale ? current : incoming;
  const retainedThreadIds = new Set(base.threads.map((thread) => thread.id));
  const timeline = new Map(
    current.timeline
      .filter((item) => retainedThreadIds.has(item.threadId))
      .map((item) => [item.id, item]),
  );
  for (const item of incoming.timeline) {
    if (!retainedThreadIds.has(item.threadId)) continue;
    const existing = timeline.get(item.id);
    timeline.set(item.id, existing ? preferTimelineItem(existing, item) : item);
  }
  return {
    ...base,
    timeline: dedupeTimelineItems([...timeline.values()]),
    lastSequence: Math.max(current.lastSequence, incoming.lastSequence),
  };
}

function upsertTimeline(items: TimelineItem[], value: TimelineItem): TimelineItem[] {
  return items.some((item) => item.id === value.id)
    ? items.map((item) => (item.id === value.id ? preferTimelineItem(item, value) : item))
    : [...items, value];
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  return items.some((item) => item.id === value.id)
    ? items.map((item) => (item.id === value.id ? value : item))
    : [...items, value];
}
