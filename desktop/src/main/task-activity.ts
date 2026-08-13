export type TaskActivityEventKind =
  | "started"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted";

export interface TaskActivityEvent {
  kind: TaskActivityEventKind;
  threadId: string;
  title: string;
}

export interface TaskActivityStatus {
  activeCount: number;
  runningCount: number;
  waitingCount: number;
  lastEvent: TaskActivityEvent | null;
}

export type TaskProgressMode = "none" | "normal" | "indeterminate" | "error" | "paused";
export type TaskAccent = "idle" | "running" | "waiting" | "completed" | "failed";

export interface TaskWindowChrome {
  progress: number;
  mode: TaskProgressMode;
  title: string;
  accent: TaskAccent;
  shouldFlash: boolean;
  notification: { title: string; body: string } | null;
  /** Keep terminal success/error color before returning to the steady state. */
  holdMs: number;
}

export interface RendererTaskActivityStatus extends TaskActivityStatus {
  accent: TaskAccent;
  toast: { tone: "success" | "error" | "warning" | "info"; message: string } | null;
}

const BASE_TITLE = "RHZYCODE";
const COMPLETION_HOLD_MS = 3200;

export function isActiveTaskStatus(status: string): boolean {
  return status === "running"
    || status === "waiting_for_approval"
    || status === "waiting_for_input";
}

export function summarizeTaskActivity(
  threads: Array<{ status: string }>,
  lastEvent: TaskActivityEvent | null = null,
): TaskActivityStatus {
  let runningCount = 0;
  let waitingCount = 0;
  for (const thread of threads) {
    if (thread.status === "running") runningCount += 1;
    else if (thread.status === "waiting_for_approval" || thread.status === "waiting_for_input") {
      waitingCount += 1;
    }
  }
  return {
    activeCount: runningCount + waitingCount,
    runningCount,
    waitingCount,
    lastEvent,
  };
}

export function taskActivityEventFromTransition(
  previousStatus: string,
  nextStatus: string,
  threadId: string,
  title: string,
): TaskActivityEvent | null {
  if (previousStatus === nextStatus) return null;
  if (isActiveTaskStatus(previousStatus) && !isActiveTaskStatus(nextStatus)) {
    if (nextStatus === "failed") return { kind: "failed", threadId, title };
    if (nextStatus === "interrupted") return { kind: "interrupted", threadId, title };
    return { kind: "completed", threadId, title };
  }
  if (nextStatus === "waiting_for_approval" || nextStatus === "waiting_for_input") {
    return { kind: "waiting", threadId, title };
  }
  if (nextStatus === "running" && previousStatus !== "running") {
    return { kind: "started", threadId, title };
  }
  return null;
}

export function resolveTaskWindowChrome(
  activity: TaskActivityStatus,
  options: { focused: boolean; baseTitle?: string } = { focused: true },
): TaskWindowChrome {
  const baseTitle = options.baseTitle || BASE_TITLE;
  const event = activity.lastEvent;
  const steady = steadyTaskWindowChrome(activity, baseTitle);

  if (!event) {
    return {
      ...steady,
      shouldFlash: false,
      notification: null,
      holdMs: 0,
    };
  }

  if (event.kind === "waiting") {
    return {
      ...steady,
      shouldFlash: !options.focused,
      notification: options.focused
        ? null
        : { title: "需要确认", body: event.title },
      holdMs: 0,
    };
  }

  if (event.kind === "completed" || event.kind === "failed" || event.kind === "interrupted") {
    const failed = event.kind === "failed";
    const interrupted = event.kind === "interrupted";
    const notification = options.focused
      ? null
      : {
          title: failed ? "任务失败" : interrupted ? "任务已中断" : "任务已完成",
          body: event.title,
        };

    // Other tasks are still running: keep busy chrome, but still notify/flash.
    if (activity.activeCount > 0) {
      return {
        ...steady,
        shouldFlash: !options.focused,
        notification,
        holdMs: 0,
      };
    }

    return {
      progress: 1,
      mode: failed ? "error" : interrupted ? "paused" : "normal",
      title: failed
        ? `${baseTitle} · 任务失败`
        : interrupted
          ? `${baseTitle} · 任务已中断`
          : `${baseTitle} · 任务已完成`,
      accent: failed ? "failed" : interrupted ? "waiting" : "completed",
      shouldFlash: !options.focused,
      notification,
      holdMs: COMPLETION_HOLD_MS,
    };
  }

  return {
    ...steady,
    shouldFlash: false,
    notification: null,
    holdMs: 0,
  };
}

export function toRendererTaskActivity(
  activity: TaskActivityStatus,
  chrome: TaskWindowChrome,
): RendererTaskActivityStatus {
  return {
    ...activity,
    accent: chrome.accent,
    toast: toastFromEvent(activity.lastEvent),
  };
}

export function toastFromEvent(
  event: TaskActivityEvent | null,
): RendererTaskActivityStatus["toast"] {
  if (!event) return null;
  if (event.kind === "completed") {
    return { tone: "success", message: `任务已完成：${event.title}` };
  }
  if (event.kind === "failed") {
    return { tone: "error", message: `任务失败：${event.title}` };
  }
  if (event.kind === "interrupted") {
    return { tone: "warning", message: `任务已中断：${event.title}` };
  }
  if (event.kind === "waiting") {
    return { tone: "warning", message: `需要确认：${event.title}` };
  }
  // Starting a task already has running progress chrome; avoid noisy start toasts.
  return null;
}

function steadyTaskWindowChrome(
  activity: TaskActivityStatus,
  baseTitle: string,
): Pick<TaskWindowChrome, "progress" | "mode" | "title" | "accent"> {
  if (activity.waitingCount > 0 && activity.runningCount === 0) {
    return {
      progress: 1,
      mode: "paused",
      title: activity.waitingCount > 1
        ? `${baseTitle} · ${activity.waitingCount} 项待确认`
        : `${baseTitle} · 等待确认`,
      accent: "waiting",
    };
  }
  if (activity.activeCount > 0) {
    return {
      progress: 2,
      mode: "indeterminate",
      title: activity.activeCount > 1
        ? `${baseTitle} · ${activity.activeCount} 个任务执行中`
        : `${baseTitle} · 任务执行中`,
      accent: "running",
    };
  }
  return {
    progress: -1,
    mode: "none",
    title: baseTitle,
    accent: "idle",
  };
}
