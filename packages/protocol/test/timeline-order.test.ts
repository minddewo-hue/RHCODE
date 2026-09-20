import assert from "node:assert/strict";
import test from "node:test";
import {
  compareTimelineOrder,
  dedupeTimelineItems,
  preferTimelineItem,
  type TimelineItem,
} from "../src/index";

function item(
  partial: Partial<TimelineItem> & Pick<TimelineItem, "id" | "threadId" | "kind" | "status" | "content">,
): TimelineItem {
  return { title: "", createdAt: "2026-07-30T00:00:00.000Z", ...partial };
}

test("orders same-thread items by orderKey even when createdAt disagrees", () => {
  const items = [
    item({ id: "a", threadId: "t1", kind: "user", status: "completed", content: "u", orderKey: 1, createdAt: "2026-07-30T00:00:03.000Z" }),
    item({ id: "b", threadId: "t1", kind: "assistant", status: "completed", content: "a", orderKey: 2, createdAt: "2026-07-30T00:00:01.000Z" }),
    item({ id: "c", threadId: "t1", kind: "command", status: "completed", content: "c", orderKey: 3, createdAt: "2026-07-30T00:00:02.000Z" }),
    item({ id: "d", threadId: "t1", kind: "assistant", status: "completed", content: "d", orderKey: 4, createdAt: "2026-07-30T00:00:00.000Z" }),
  ];

  assert.deepEqual(dedupeTimelineItems(items).map((entry) => entry.id), ["a", "b", "c", "d"]);
});

test("keeps the createdAt → id fallback for legacy items without orderKey", () => {
  const items = [
    item({ id: "a", threadId: "t1", kind: "user", status: "completed", content: "a", createdAt: "2026-07-30T00:00:02.000Z" }),
    item({ id: "b", threadId: "t1", kind: "assistant", status: "completed", content: "b", createdAt: "2026-07-30T00:00:01.000Z" }),
    item({ id: "c", threadId: "t1", kind: "assistant", status: "completed", content: "c", createdAt: "2026-07-30T00:00:03.000Z" }),
  ];

  assert.deepEqual(dedupeTimelineItems(items).map((entry) => entry.id), ["b", "a", "c"]);
});

test("resolves same-millisecond ties by orderKey, then by id", () => {
  const at = "2026-07-30T00:00:00.000Z";
  const keyed = [
    item({ id: "a", threadId: "t1", kind: "user", status: "completed", content: "a", orderKey: 2, createdAt: at }),
    item({ id: "b", threadId: "t1", kind: "assistant", status: "completed", content: "b", orderKey: 1, createdAt: at }),
    item({ id: "c", threadId: "t1", kind: "assistant", status: "completed", content: "c", orderKey: 3, createdAt: at }),
  ];
  assert.deepEqual(dedupeTimelineItems(keyed).map((entry) => entry.id), ["b", "a", "c"]);

  const legacy = [
    item({ id: "zeta", threadId: "t2", kind: "user", status: "completed", content: "z", createdAt: at }),
    item({ id: "alpha", threadId: "t2", kind: "assistant", status: "completed", content: "a", createdAt: at }),
  ];
  assert.deepEqual(dedupeTimelineItems(legacy).map((entry) => entry.id), ["alpha", "zeta"]);
});

test("compares across threads by createdAt, within a thread by orderKey", () => {
  const crossThreadLeft = item({ id: "a", threadId: "t1", kind: "user", status: "completed", content: "a", orderKey: 5, createdAt: "2026-07-30T00:00:01.000Z" });
  const crossThreadRight = item({ id: "b", threadId: "t2", kind: "user", status: "completed", content: "b", orderKey: 1, createdAt: "2026-07-30T00:00:02.000Z" });
  assert.ok(compareTimelineOrder(crossThreadLeft, crossThreadRight) < 0);

  const sameThreadLeft = item({ id: "c", threadId: "t1", kind: "user", status: "completed", content: "c", orderKey: 2, createdAt: "2026-07-30T00:00:09.000Z" });
  const sameThreadRight = item({ id: "d", threadId: "t1", kind: "assistant", status: "completed", content: "d", orderKey: 4, createdAt: "2026-07-30T00:00:05.000Z" });
  assert.ok(compareTimelineOrder(sameThreadLeft, sameThreadRight) < 0);
});

test("merges a provisional user row and its canonical row into exactly one line", () => {
  const provisional = item({
    id: "user-prov-1",
    threadId: "t1",
    kind: "user",
    status: "running",
    content: "Hello world",
    createdAt: "2026-07-30T00:00:01.000Z",
    orderKey: 5,
  });
  const canonical = item({
    id: "turn-1::user-1",
    threadId: "t1",
    kind: "user",
    status: "completed",
    content: "Hello world",
    createdAt: "2026-07-30T00:00:02.000Z",
    orderKey: 2,
  });

  const merged = dedupeTimelineItems([provisional, canonical]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, "turn-1::user-1");
  assert.equal(merged[0]?.status, "completed");
  // First-assigned generation order wins; the earliest timestamp is kept.
  assert.equal(merged[0]?.orderKey, 2);
  assert.equal(merged[0]?.createdAt, "2026-07-30T00:00:01.000Z");
});

test("dedupes by logicalId even when the content drifted between sources", () => {
  const live = item({
    id: "live-1",
    threadId: "t1",
    kind: "assistant",
    status: "completed",
    content: "Draft reply",
    createdAt: "2026-07-30T00:00:01.000Z",
    logicalId: "logical-9",
    orderKey: 3,
  });
  const history = item({
    id: "history-1",
    threadId: "t1",
    kind: "assistant",
    status: "completed",
    content: "Draft reply, done",
    createdAt: "2026-07-30T00:00:02.000Z",
    logicalId: "logical-9",
    orderKey: 7,
  });

  const merged = dedupeTimelineItems([live, history]);
  assert.equal(merged.length, 1);
  // The richer (longer) streaming payload survives the merge.
  assert.equal(merged[0]?.content, "Draft reply, done");
  assert.equal(merged[0]?.orderKey, 3);
  assert.equal(merged[0]?.createdAt, "2026-07-30T00:00:01.000Z");
});

test("preferTimelineItem keeps the first-assigned (smaller) orderKey on upsert", () => {
  const current = item({
    id: "turn-1::assistant-1",
    threadId: "t1",
    kind: "assistant",
    status: "running",
    content: "Hi",
    createdAt: "2026-07-30T00:00:01.000Z",
    orderKey: 3,
  });
  const incoming = item({
    id: "turn-1::assistant-1",
    threadId: "t1",
    kind: "assistant",
    status: "completed",
    content: "Hello there",
    createdAt: "2026-07-30T00:00:02.000Z",
    orderKey: 7,
  });

  const merged = preferTimelineItem(current, incoming);
  assert.equal(merged.content, "Hello there");
  assert.equal(merged.status, "completed");
  assert.equal(merged.orderKey, 3);
  assert.equal(merged.createdAt, "2026-07-30T00:00:01.000Z");
});

test("counts stay duplicate-free when live, snapshot, and history rows overlap", () => {
  const user = "2026-07-30T00:00:00.000Z";
  const assistant = "2026-07-30T00:00:01.000Z";
  const items = [
    // live provisional + canonical history for the same user row
    item({ id: "user-prov-9", threadId: "t1", kind: "user", status: "completed", content: "Ship it", createdAt: user, orderKey: 1 }),
    item({ id: "turn-9::user-9", threadId: "t1", kind: "user", status: "completed", content: "Ship it", createdAt: user, orderKey: 1 }),
    // live stream row + history row for the same assistant reply (different ids, shared logicalId)
    item({ id: "live-9", threadId: "t1", kind: "assistant", status: "completed", content: "Done.", createdAt: assistant, logicalId: "logical-ship", orderKey: 2 }),
    item({ id: "turn-9::assistant-9", threadId: "t1", kind: "assistant", status: "completed", content: "Done.", createdAt: assistant, logicalId: "logical-ship", orderKey: 2 }),
    // a third, unrelated row
    item({ id: "turn-9::command-1", threadId: "t1", kind: "command", status: "completed", content: "npm test", createdAt: assistant, orderKey: 3 }),
  ];

  const merged = dedupeTimelineItems(items);
  assert.deepEqual(merged.map((entry) => entry.id), ["turn-9::user-9", "turn-9::assistant-9", "turn-9::command-1"]);
  assert.deepEqual(merged.map((entry) => entry.content), ["Ship it", "Done.", "npm test"]);
});
