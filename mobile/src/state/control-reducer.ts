import type { AgentEvent, ControlSnapshot, RemoteThreadOpenResult } from "@rhzycode/protocol";

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
      next.timeline = upsertById(snapshot.timeline, event.item);
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
  for (const item of result.timeline) timeline.set(item.id, item);
  return {
    ...snapshot,
    threads: upsertById(snapshot.threads, result.thread),
    timeline: [...timeline.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
  };
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  return items.some((item) => item.id === value.id)
    ? items.map((item) => (item.id === value.id ? value : item))
    : [...items, value];
}
