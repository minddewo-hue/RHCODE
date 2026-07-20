import assert from "node:assert/strict";
import test from "node:test";
import { ControlStore, createControlPlane } from "../src/app.js";

test("resolves a pending approval exactly once", async () => {
  const controlPlane = await createControlPlane({ logLevel: "silent" });
  const approval = {
    id: "approval-7",
    threadId: "thread-1",
    kind: "command" as const,
    title: "Approve command",
    detail: "npm test",
    createdAt: new Date().toISOString(),
  };

  controlPlane.store.publish({ type: "approval.requested", approval });
  assert.deepEqual(controlPlane.store.snapshot().approvals, [approval]);

  const response = await controlPlane.app.inject({
    method: "POST",
    url: `/v1/approvals/${approval.id}`,
    payload: { decision: "approved" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    type: "approval.resolved",
    sequence: 2,
    approvalId: approval.id,
    decision: "approved",
  });
  assert.deepEqual(controlPlane.store.snapshot().approvals, []);

  const duplicate = await controlPlane.app.inject({
    method: "POST",
    url: `/v1/approvals/${approval.id}`,
    payload: { decision: "declined" },
  });
  assert.equal(duplicate.statusCode, 404);

  await controlPlane.stop();
});

test("resolves user input without persisting answers", async () => {
  const controlPlane = await createControlPlane({ logLevel: "silent" });
  const request = {
    id: "user-input-9",
    threadId: "thread-1",
    questions: [{
      id: "token",
      header: "Credential",
      question: "Enter a temporary token",
      isOther: false,
      isSecret: true,
      options: null,
    }],
    autoResolutionMs: null,
    createdAt: new Date().toISOString(),
  };

  controlPlane.store.publish({ type: "user_input.requested", request });
  assert.deepEqual(controlPlane.store.snapshot().userInputs, [request]);

  const event = controlPlane.store.resolveUserInput(request.id);
  assert.deepEqual(event, {
    type: "user_input.resolved",
    sequence: 2,
    requestId: request.id,
  });
  assert.deepEqual(controlPlane.store.snapshot().userInputs, []);
  assert.doesNotMatch(JSON.stringify(controlPlane.store.listEvents(0)), /temporary-secret-value/);

  await controlPlane.stop();
});

test("restores durable state without reviving pending requests", () => {
  const store = new ControlStore();
  const now = new Date().toISOString();
  store.upsertThread({
    id: "thread-persisted",
    hostId: "local-desktop",
    title: "Persisted task",
    projectPath: "D:\\work",
    model: "test/model",
    status: "completed",
    updatedAt: now,
  });
  store.publish({
    type: "timeline.upserted",
    item: {
      id: "timeline-persisted",
      threadId: "thread-persisted",
      kind: "assistant",
      status: "completed",
      title: "Result",
      content: "Durable output",
      createdAt: now,
    },
  });
  store.publish({
    type: "approval.requested",
    approval: {
      id: "approval-ephemeral",
      threadId: "thread-persisted",
      kind: "command",
      title: "Do not restore",
      detail: "pending process state",
      createdAt: now,
    },
  });

  const restored = new ControlStore(store.exportState());
  assert.equal(restored.snapshot().threads[0]?.id, "thread-persisted");
  assert.equal(restored.snapshot().timeline[0]?.content, "Durable output");
  assert.deepEqual(restored.snapshot().approvals, []);
  assert.equal(restored.listEvents(0).some((event) => event.type === "approval.requested"), false);
  const next = restored.upsertThread({ ...restored.snapshot().threads[0]!, updatedAt: now });
  assert.ok(next.sequence > store.snapshot().lastSequence);
});
