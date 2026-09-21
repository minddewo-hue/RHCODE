import assert from "node:assert/strict";
import test from "node:test";
import { ControlStore } from "../src/main/control-plane/store";

test("bounds live timeline state and keeps relay snapshots below the response limit", () => {
  const store = new ControlStore();
  const largeContent = `start-${"x".repeat(400_000)}-end`;
  for (let index = 0; index < 300; index += 1) {
    store.publish({
      type: "timeline.upserted",
      item: {
        id: `large-activity-${index}`,
        threadId: "large-thread",
        kind: "command",
        title: "Large command output",
        content: largeContent,
        status: "completed",
        createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      },
    });
  }

  const snapshot = store.snapshot();
  const encodedBytes = Buffer.byteLength(JSON.stringify(snapshot));
  assert.ok(snapshot.timeline.length <= 250);
  assert.equal(snapshot.timeline.at(-1)?.id, "large-activity-299");
  assert.match(snapshot.timeline.at(-1)?.content || "", /mobile preview truncated/);
  assert.match(snapshot.timeline.at(-1)?.content || "", /^start-/);
  assert.match(snapshot.timeline.at(-1)?.content || "", /-end$/);
  assert.ok(encodedBytes < 35 * 1024 * 1024, `snapshot was ${encodedBytes} bytes`);
});

test("keeps complete small timeline items in chronological order", () => {
  const store = new ControlStore();
  for (let index = 0; index < 3; index += 1) {
    store.publish({
      type: "timeline.upserted",
      item: {
        id: `activity-${index}`,
        threadId: "thread",
        kind: "assistant",
        title: "Answer",
        content: `complete-${index}`,
        status: "completed",
        createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      },
    });
  }

  assert.deepEqual(store.snapshot().timeline.map(({ id, content }) => ({ id, content })), [
    { id: "activity-0", content: "complete-0" },
    { id: "activity-1", content: "complete-1" },
    { id: "activity-2", content: "complete-2" },
  ]);
});

test("bounds live timeline events before WebSocket delivery", () => {
  const store = new ControlStore();
  const event = store.publish({
    type: "timeline.upserted",
    item: {
      id: "oversized-live-event",
      threadId: "thread",
      kind: "command",
      title: "Large output",
      content: `head-${"你".repeat(200_000)}-tail`,
      status: "completed",
      createdAt: new Date().toISOString(),
    },
  });

  assert.equal(event.type, "timeline.upserted");
  if (event.type !== "timeline.upserted") return;
  assert.match(event.item.content, /^head-/);
  assert.match(event.item.content, /mobile preview truncated/);
  assert.match(event.item.content, /-tail$/);
  assert.ok(Buffer.byteLength(JSON.stringify(event)) < 300 * 1024);
  assert.equal(store.listEvents(0)[0], event);
});
