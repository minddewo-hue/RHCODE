import type { AgentEvent, ControlSnapshot, RemoteThreadOpenResult, TimelineItem } from "@rhzycode/protocol";
import { dedupeTimelineItems, mergeDuplicateTimelineItems, preferTimelineItem } from "@rhzycode/protocol";

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
  const streamChanged = Boolean(
    current.streamId && incoming.streamId && current.streamId !== incoming.streamId,
  );
  if (streamChanged) return normalizeSnapshot(incoming);
  if (incoming.lastSequence < current.lastSequence) return current;

  const retainedThreadIds = new Set(incoming.threads.map((thread) => thread.id));
  const incomingTimeline = dedupeTimelineItems(
    incoming.timeline.filter((item) => retainedThreadIds.has(item.threadId)),
  );
  const timeline = new Map(incomingTimeline.map((item) => [timelineIdentity(item), item]));

  // Full thread history is richer than the bounded control snapshot. The server
  // stream id is the authority boundary; within one stream, retain history that
  // is absent from the bounded snapshot and collapse matching logical rows.
  for (const item of current.timeline) {
    if (!retainedThreadIds.has(item.threadId)) continue;
    const key = timelineIdentity(item);
    const existing = timeline.get(key);
    if (existing) timeline.set(key, mergeDuplicateTimelineItems(item, existing));
    else timeline.set(key, item);
  }
  return {
    ...incoming,
    timeline: dedupeTimelineItems([...timeline.values()]),
  };
}

function normalizeSnapshot(snapshot: ControlSnapshot): ControlSnapshot {
  const threadIds = new Set(snapshot.threads.map((thread) => thread.id));
  return {
    ...snapshot,
    timeline: dedupeTimelineItems(snapshot.timeline.filter((item) => threadIds.has(item.threadId))),
  };
}

function timelineIdentity(item: TimelineItem): string {
  return `${item.threadId}\u0000${item.logicalId || item.id}`;
}

function upsertTimeline(items: TimelineItem[], value: TimelineItem): TimelineItem[] {
  const identity = timelineIdentity(value);
  return items.some((item) => timelineIdentity(item) === identity)
    ? items.map((item) => (
      timelineIdentity(item) === identity ? mergeDuplicateTimelineItems(item, value) : item
    ))
    : [...items, value];
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  return items.some((item) => item.id === value.id)
    ? items.map((item) => (item.id === value.id ? value : item))
    : [...items, value];
}
