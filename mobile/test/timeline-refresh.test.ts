import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteTimelineDeltaResult } from "@rhzycode/protocol";
import { refreshThreadTimeline } from "../src/api/timeline-refresh";

function page(key: number, hasMore: boolean): RemoteTimelineDeltaResult {
  return {
    threadId: "thread-1",
    timeline: [{
      id: `message-${key}`,
      threadId: "thread-1",
      kind: "assistant",
      status: "completed",
      title: "Assistant",
      content: `body-${key}`,
      createdAt: "2026-10-16T00:00:00.000Z",
      orderKey: key,
    }],
    maxOrderKey: 3,
    hasMore,
  };
}

test("refreshes existing rows and advances by each page rather than the full-history maximum", async () => {
  const cursors: number[] = [];
  const received: number[] = [];
  const max = await refreshThreadTimeline(async (cursor) => {
    cursors.push(cursor);
    return page(cursor + 1, cursor < 2);
  }, (value) => received.push(value.timeline[0]!.orderKey!));
  assert.deepEqual(cursors, [0, 1, 2]);
  assert.deepEqual(received, [1, 2, 3]);
  assert.equal(max, 3);
});

test("rejects non-advancing pages instead of marking incomplete history loaded", async () => {
  await assert.rejects(refreshThreadTimeline(async () => ({
    threadId: "thread-1", timeline: [], maxOrderKey: 10, hasMore: true,
  }), () => undefined), /did not advance/);
});

test("cancelled history requests cannot hydrate a different selected thread", async () => {
  let cancelled = false;
  const result = await refreshThreadTimeline(async () => {
    cancelled = true;
    return page(1, false);
  }, () => assert.fail("cancelled page must not hydrate"), () => cancelled);
  assert.equal(result, null);
});
