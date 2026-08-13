import type { TimelineItem } from "@rhzycode/protocol";

/** Coalesce high-frequency streaming timeline upserts for weak mobile links. */
export const STREAMING_TIMELINE_COALESCE_MS = 200;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface TimelinePublishCoalescerOptions {
  coalesceMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
}

/**
 * Publishes terminal/user timeline items immediately. Running stream updates are
 * coalesced so each item emits at most about once per coalesce window, always
 * keeping the latest content. The first running update (and any update whose
 * coalesce window has already elapsed) publishes synchronously. Flush before a
 * terminal publish so no partial frame is left behind.
 */
export class TimelinePublishCoalescer {
  private readonly pending = new Map<string, TimelineItem>();
  private readonly timers = new Map<string, TimerHandle>();
  private readonly lastPublishedAt = new Map<string, number>();
  private readonly coalesceMs: number;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancel: (handle: TimerHandle) => void;

  constructor(
    private readonly publish: (item: TimelineItem) => void,
    options: TimelinePublishCoalescerOptions = {},
  ) {
    this.coalesceMs = Math.max(0, options.coalesceMs ?? STREAMING_TIMELINE_COALESCE_MS);
    this.now = options.now || Date.now;
    this.schedule = options.schedule || ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel || ((handle) => clearTimeout(handle));
  }

  enqueue(item: TimelineItem): void {
    if (item.status !== "running") {
      this.flush(item.id);
      this.publish(item);
      this.lastPublishedAt.set(item.id, this.now());
      return;
    }

    this.pending.set(item.id, item);
    if (this.timers.has(item.id)) return;

    const lastPublishedAt = this.lastPublishedAt.get(item.id);
    const delay = lastPublishedAt == null
      ? 0
      : Math.max(0, this.coalesceMs - (this.now() - lastPublishedAt));

    // Synchronous path keeps first/due frames visible without waiting for timers.
    if (delay === 0) {
      this.publishPending(item.id);
      return;
    }

    const timer = this.schedule(() => {
      this.timers.delete(item.id);
      this.publishPending(item.id);
    }, delay);
    this.timers.set(item.id, timer);
  }

  flush(itemId?: string): void {
    if (itemId) {
      this.flushOne(itemId);
      return;
    }
    const ids = new Set<string>([...this.timers.keys(), ...this.pending.keys()]);
    for (const id of ids) this.flushOne(id);
  }

  dispose(): void {
    for (const timer of this.timers.values()) this.cancel(timer);
    this.timers.clear();
    this.pending.clear();
    this.lastPublishedAt.clear();
  }

  private publishPending(itemId: string): void {
    const next = this.pending.get(itemId);
    this.pending.delete(itemId);
    if (!next) return;
    this.publish(next);
    this.lastPublishedAt.set(itemId, this.now());
  }

  private flushOne(itemId: string): void {
    const timer = this.timers.get(itemId);
    if (timer != null) this.cancel(timer);
    this.timers.delete(itemId);
    this.publishPending(itemId);
  }
}
