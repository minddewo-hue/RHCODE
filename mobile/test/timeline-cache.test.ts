import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineItem } from "@rhzycode/protocol";
import {
  createInMemoryTimelineCacheStore,
  deleteCachedThread,
  pruneTimelineCache,
  upsertCachedThread,
  type CachedThreadTimeline,
  type ThreadTimelineCache,
} from "../src/storage/timeline-cache";

const now = "2026-07-15T10:00:00.000Z";

function item(id: string, orderKey?: number): TimelineItem {
  return {
    id,
    threadId: "thread-1",
    kind: "assistant",
    status: "completed",
    title: "Reply",
    content: `content of ${id}`,
    createdAt: now,
    ...(orderKey !== undefined ? { orderKey } : {}),
  };
}

function entry(maxOrderKey: number, updatedAt: string): CachedThreadTimeline {
  return { maxOrderKey, timeline: [item(`assistant-${maxOrderKey}`, maxOrderKey)], updatedAt };
}

test("persists and reloads a valid cache round-trip", async () => {
  const store = createInMemoryTimelineCacheStore();
  const threads = upsertCachedThread({}, "thread-1", 4, [item("assistant-4", 4)]);
  await store.save(threads);

  const loaded = await store.load();
  assert.equal(loaded["thread-1"]?.maxOrderKey, 4);
  assert.equal(loaded["thread-1"]?.timeline[0]?.id, "assistant-4");
});

test("treats a corrupt cache file as empty", async () => {
  const values = new Map<string, string>([["timeline-cache", "{not json"]]);
  const store = createInMemoryTimelineCacheStore(values);
  assert.deepEqual(await store.load(), {});
});

for (const version of [1, 2]) test(`discards v${version} caches with obsolete message merging or ordering`, async () => {
  const values = new Map<string, string>([[
    "timeline-cache",
    JSON.stringify({
      version,
      threads: { "thread-1": entry(5, now) },
    }),
  ]]);
  const store = createInMemoryTimelineCacheStore(values);
  assert.deepEqual(await store.load(), {});
  const fresh = upsertCachedThread({}, "thread-1", 6, [item("assistant-6", 6)]);
  await store.save(fresh);
  assert.equal(JSON.parse(values.get("timeline-cache")!).version, 3);
  assert.deepEqual(await store.load(), fresh);
});

test("LRU keeps only the most recently updated threads", () => {
  const threads: ThreadTimelineCache = {};
  for (let n = 1; n <= 25; n += 1) {
    threads[`thread-${n}`] = entry(n, new Date(Date.UTC(2026, 6, 15, 10, 0, n)).toISOString());
  }
  const pruned = pruneTimelineCache(threads);
  assert.equal(Object.keys(pruned).length, 20);
  assert.ok(pruned["thread-25"]);
  assert.ok(!pruned["thread-5"]);
});

test("upsert bumps the cursor and updatedAt; delete removes the entry", () => {
  let threads = upsertCachedThread({}, "thread-1", 3, [item("assistant-3", 3)]);
  threads = upsertCachedThread(threads, "thread-1", 9, [item("assistant-9", 9)]);
  assert.equal(threads["thread-1"]?.maxOrderKey, 9);
  assert.equal(threads["thread-1"]?.timeline.length, 1);

  threads = deleteCachedThread(threads, "thread-1");
  assert.equal("thread-1" in threads, false);
  threads = deleteCachedThread(threads, "thread-missing");
  assert.equal(threads, threads);
});
