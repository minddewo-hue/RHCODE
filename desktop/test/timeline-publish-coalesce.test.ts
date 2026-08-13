import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineItem } from "@rhzycode/protocol";
import { TimelinePublishCoalescer } from "../src/main/timeline-publish-coalesce";

function item(id: string, content: string, status: TimelineItem["status"] = "running"): TimelineItem {
  return {
    id,
    threadId: "thread-1",
    kind: "assistant",
    status,
    title: "RHZYCODE",
    content,
    createdAt: "2026-07-31T10:00:00.000Z",
  };
}

test("publishes the first running update immediately and coalesces later deltas", () => {
  const published: string[] = [];
  const timers: Array<{ cb: () => void; ms: number }> = [];
  let now = 1_000;
  const coalescer = new TimelinePublishCoalescer((entry) => {
    published.push(entry.content);
  }, {
    coalesceMs: 200,
    now: () => now,
    schedule: (cb, ms) => {
      timers.push({ cb, ms });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: () => undefined,
  });

  coalescer.enqueue(item("a", "Hel"));
  assert.deepEqual(published, ["Hel"]);
  assert.equal(timers.length, 0);

  coalescer.enqueue(item("a", "Hello"));
  coalescer.enqueue(item("a", "Hello world"));
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.ms, 200);
  assert.deepEqual(published, ["Hel"]);
  now = 1_200;
  timers.shift()!.cb();
  assert.deepEqual(published, ["Hel", "Hello world"]);
});

test("terminal status flushes pending running content then publishes completion", () => {
  const published: Array<{ content: string; status: string }> = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let cancelCount = 0;
  const coalescer = new TimelinePublishCoalescer((entry) => {
    published.push({ content: entry.content, status: entry.status });
  }, {
    coalesceMs: 200,
    now: () => 5_000,
    schedule: (cb) => {
      const id = nextTimer++;
      timers.set(id, cb);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (id) => {
      cancelCount += 1;
      timers.delete(id as unknown as number);
    },
  });

  coalescer.enqueue(item("a", "partial"));
  assert.deepEqual(published, [{ content: "partial", status: "running" }]);
  assert.equal(timers.size, 0);

  coalescer.enqueue(item("a", "partial answer"));
  assert.equal(timers.size, 1);
  coalescer.enqueue(item("a", "partial answer done", "completed"));
  assert.equal(cancelCount, 1);
  assert.equal(timers.size, 0);
  assert.deepEqual(published, [
    { content: "partial", status: "running" },
    { content: "partial answer", status: "running" },
    { content: "partial answer done", status: "completed" },
  ]);
});

test("publishes immediately when the coalesce window has already elapsed", () => {
  const published: string[] = [];
  let now = 1_000;
  const coalescer = new TimelinePublishCoalescer((entry) => published.push(entry.content), {
    coalesceMs: 200,
    now: () => now,
    schedule: () => {
      throw new Error("timer should not be scheduled after window elapses");
    },
    cancel: () => undefined,
  });

  coalescer.enqueue(item("a", "first"));
  now = 1_250;
  coalescer.enqueue(item("a", "second"));
  assert.deepEqual(published, ["first", "second"]);
});

test("dispose drops pending timers without publishing", () => {
  const published: string[] = [];
  let now = 1_000;
  const coalescer = new TimelinePublishCoalescer((entry) => published.push(entry.content), {
    coalesceMs: 200,
    now: () => now,
    schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
    cancel: () => undefined,
  });
  coalescer.enqueue(item("a", "first"));
  coalescer.enqueue(item("a", "lost"));
  coalescer.dispose();
  assert.deepEqual(published, ["first"]);
});
