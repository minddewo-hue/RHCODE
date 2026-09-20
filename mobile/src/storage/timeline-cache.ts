import type { TimelineItem } from "@rhzycode/protocol";
import { timelineItemSchema } from "@rhzycode/protocol";
import { z } from "zod";

/**
 * Per-connection local cache of thread timelines (sync plan §3.2 支柱三).
 * Stores the body rows (user/assistant) plus the largest `orderKey` seen per
 * thread so a cold start can render instantly and then catch up incrementally
 * via GET /timeline?afterOrderKey=N instead of re-fetching every thread.
 */

export interface TextFileAdapter {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export interface CachedThreadTimeline {
  /** Largest orderKey observed from the desktop for this thread (cursor). */
  maxOrderKey: number;
  timeline: TimelineItem[];
  updatedAt: string;
}

export type ThreadTimelineCache = Record<string, CachedThreadTimeline>;

const cachedThreadSchema = z.object({
  maxOrderKey: z.number().int().nonnegative(),
  timeline: z.array(timelineItemSchema).max(50_000),
  updatedAt: z.string().datetime(),
});

const cacheSchema = z.object({
  version: z.literal(1),
  threads: z.record(z.string().min(1).max(500), cachedThreadSchema),
});

/** LRU cap: keep the most recently updated threads only. */
const maxCachedThreads = 20;

export class ThreadTimelineCacheStore {
  constructor(private readonly adapter: TextFileAdapter) {}

  async load(): Promise<ThreadTimelineCache> {
    try {
      const raw = await this.adapter.read();
      if (!raw) return {};
      const parsed = cacheSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.threads : {};
    } catch {
      // Corrupt cache is not fatal: a full openThread refills it.
      return {};
    }
  }

  async save(threads: ThreadTimelineCache): Promise<void> {
    try {
      await this.adapter.write(JSON.stringify({ version: 1, threads: pruneTimelineCache(threads) }));
    } catch {
      // Best-effort persistence only; the network paths never depend on it.
    }
  }
}

export function pruneTimelineCache(threads: ThreadTimelineCache): ThreadTimelineCache {
  const entries = Object.entries(threads)
    .filter((entry): entry is [string, CachedThreadTimeline] =>
      Boolean(entry[1]) && Array.isArray(entry[1].timeline))
    .sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt));
  const kept: ThreadTimelineCache = {};
  for (const [threadId, entry] of entries.slice(0, maxCachedThreads)) {
    kept[threadId] = {
      maxOrderKey: entry.maxOrderKey,
      timeline: entry.timeline,
      updatedAt: entry.updatedAt,
    };
  }
  return kept;
}

export function upsertCachedThread(
  threads: ThreadTimelineCache,
  threadId: string,
  maxOrderKey: number,
  timeline: TimelineItem[],
): ThreadTimelineCache {
  return {
    ...threads,
    [threadId]: {
      maxOrderKey,
      timeline,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function deleteCachedThread(
  threads: ThreadTimelineCache,
  threadId: string,
): ThreadTimelineCache {
  if (!(threadId in threads)) return threads;
  const next = { ...threads };
  delete next[threadId];
  return next;
}

/** In-memory adapter for web builds and unit tests. */
export function createInMemoryTimelineCacheStore(
  values: Map<string, string> = new Map(),
  key = "timeline-cache",
): ThreadTimelineCacheStore {
  return new ThreadTimelineCacheStore({
    async read() {
      return values.get(key) ?? null;
    },
    async write(text) {
      values.set(key, text);
    },
  });
}
