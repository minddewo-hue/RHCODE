import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlCommandError,
  createControlPlane,
  MobileAccessManager,
  type ControlCommandHandlers,
} from "../src/main/control-plane/app.js";

test("delegates authenticated mobile task commands to desktop handlers", async () => {
  const calls: Array<{ command: string; clientId: string; value: unknown }> = [];
  const commands: ControlCommandHandlers = {
    async listModels(context) {
      calls.push({ command: "model.list", clientId: context.client.id, value: null });
      return {
        models: [{
          id: "model-test",
          model: "sub2api/gpt-test",
          displayName: "GPT Test",
          description: "Test model",
          defaultReasoningEffort: "medium",
          isDefault: true,
        }],
      };
    },
    async listProjects(context) {
      calls.push({ command: "project.list", clientId: context.client.id, value: null });
      return { projects: [{ path: "D:\\work", name: "work" }] };
    },
    async createProject(request, context) {
      calls.push({ command: "project.create", clientId: context.client.id, value: request });
      return { project: { path: request.path, name: "mobile-new" }, created: true };
    },
    async forgetProject(request, context) {
      calls.push({ command: "project.forget", clientId: context.client.id, value: request });
      return { projects: [] };
    },
    async browseProjects(request, context) {
      calls.push({ command: "project.browse", clientId: context.client.id, value: request });
      return { path: request.path || null, parentPath: null, directories: [{ path: "D:\\work", name: "work" }] };
    },
    async listArchivedThreads(request, context) {
      calls.push({ command: "thread.list-archived", clientId: context.client.id, value: request });
      return {
        threads: [{
          id: "thread-archived",
          hostId: "local-desktop",
          title: "Archived task",
          projectPath: "D:\\work",
          model: "test/model",
          status: "completed",
          updatedAt: new Date().toISOString(),
        }],
      };
    },
    async startThread(request, context) {
      calls.push({ command: "thread.start", clientId: context.client.id, value: request });
      return {
        threadId: "thread-remote",
        acceptedAt: new Date().toISOString(),
      };
    },
    async openThread(threadId, context) {
      calls.push({ command: "thread.open", clientId: context.client.id, value: { threadId } });
      const createdAt = new Date().toISOString();
      return {
        thread: {
          id: threadId,
          hostId: "local-desktop",
          title: "Remote task",
          projectPath: "D:\\work",
          model: "test/model",
          status: "completed",
          updatedAt: createdAt,
        },
        timeline: [{
          id: "timeline-remote",
          threadId,
          kind: "assistant",
          status: "completed",
          title: "RHZYCODE",
          content: "Restored response",
          createdAt,
        }],
      };
    },
    async startTurn(threadId, request, context) {
      calls.push({ command: "turn.start", clientId: context.client.id, value: { threadId, request } });
      return {
        threadId,
        turnId: "turn-remote",
        acceptedAt: new Date().toISOString(),
      };
    },
    async interruptTurn(threadId, context) {
      calls.push({ command: "turn.interrupt", clientId: context.client.id, value: { threadId } });
      return { threadId, acceptedAt: new Date().toISOString() };
    },
    async submitUserInput(requestId, request, context) {
      calls.push({ command: "user-input.submit", clientId: context.client.id, value: { requestId, request } });
      return { requestId, acceptedAt: new Date().toISOString() };
    },
    async setThreadModel(threadId, request, context) {
      calls.push({ command: "thread.model", clientId: context.client.id, value: { threadId, request } });
      return { threadId, acceptedAt: new Date().toISOString() };
    },
    async renameThread(threadId, request, context) {
      calls.push({ command: "thread.rename", clientId: context.client.id, value: { threadId, request } });
      return { threadId, acceptedAt: new Date().toISOString() };
    },
    async archiveThread(threadId, context) {
      calls.push({ command: "thread.archive", clientId: context.client.id, value: { threadId } });
      return { threadId, acceptedAt: new Date().toISOString() };
    },
    async unarchiveThread(threadId, context) {
      calls.push({ command: "thread.unarchive", clientId: context.client.id, value: { threadId } });
      return { threadId, acceptedAt: new Date().toISOString() };
    },
    async deleteThread(threadId, context) {
      calls.push({ command: "thread.delete", clientId: context.client.id, value: { threadId } });
      return { threadId, acceptedAt: new Date().toISOString() };
    },
  };
  const mobileAccess = new MobileAccessManager();
  const taskToken = mobileAccess.rotateAccessKey().key;
  const controlPlane = await createControlPlane({ logLevel: "silent", mobileAccess, commands });

  const invalidPolicy = await controlPlane.app.inject({
    method: "POST",
    url: "/v1/commands/threads/start",
    headers: { authorization: `Bearer ${taskToken}` },
    payload: {
      projectPath: "D:\\work",
      sandboxMode: "unsupported",
      approvalPolicy: "unsupported",
    },
  });
  assert.equal(invalidPolicy.statusCode, 400);
  assert.equal(calls.length, 0);

  const projects = await controlPlane.app.inject({
    method: "GET",
    url: "/v1/commands/projects",
    headers: { authorization: `Bearer ${taskToken}` },
  });
  assert.equal(projects.statusCode, 200);
  assert.deepEqual(projects.json().projects, [{ path: "D:\\work", name: "work" }]);

  const browsed = await controlPlane.app.inject({
    method: "GET",
    url: "/v1/commands/projects/browse?path=D%3A%5Cwork",
    headers: { authorization: `Bearer ${taskToken}` },
  });
  assert.equal(browsed.statusCode, 200);
  assert.equal(browsed.json().directories[0]?.name, "work");

  const models = await controlPlane.app.inject({
    method: "GET",
    url: "/v1/commands/models",
    headers: { authorization: `Bearer ${taskToken}` },
  });
  assert.equal(models.statusCode, 200);
  assert.equal(models.json().models[0]?.displayName, "GPT Test");

  const createdProject = await controlPlane.app.inject({
    method: "POST",
    url: "/v1/commands/projects",
    headers: {
      authorization: `Bearer ${taskToken}`,
      "idempotency-key": "project-create-0001",
    },
    payload: { path: "D:\\work\\mobile-new", create: true },
  });
  assert.equal(createdProject.statusCode, 201);
  assert.equal(createdProject.json().project.name, "mobile-new");

  const removedProject = await controlPlane.app.inject({
    method: "DELETE",
    url: "/v1/commands/projects",
    headers: {
      authorization: `Bearer ${taskToken}`,
      "idempotency-key": "project-forget-0001",
    },
    payload: { path: "D:\\work\\mobile-new" },
  });
  assert.equal(removedProject.statusCode, 200);
  assert.deepEqual(removedProject.json(), { projects: [] });

  const startedThread = await controlPlane.app.inject({
    method: "POST",
    url: "/v1/commands/threads/start",
    headers: {
      authorization: `Bearer ${taskToken}`,
      "idempotency-key": "thread-start-0001",
    },
    payload: {
      projectPath: "D:\\work",
      model: "sub2api/gpt-test",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  assert.equal(startedThread.statusCode, 201);
  assert.equal(startedThread.json().threadId, "thread-remote");
  assert.equal(controlPlane.store.snapshot().threads.length, 0);

  const replayedThread = await controlPlane.app.inject({
    method: "POST",
    url: "/v1/commands/threads/start",
    headers: {
      authorization: `Bearer ${taskToken}`,
      "idempotency-key": "thread-start-0001",
    },
    payload: {
      projectPath: "D:\\work",
      model: "sub2api/gpt-test",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  assert.equal(replayedThread.statusCode, 201);
  assert.deepEqual(replayedThread.json(), startedThread.json());
  assert.equal(calls.length, 6);

  const conflictingReplay = await controlPlane.app.inject({
    method: "POST",
    url: "/v1/commands/threads/start",
    headers: {
      authorization: `Bearer ${taskToken}`,
      "idempotency-key": "thread-start-0001",
    },
    payload: { projectPath: "D:\\other" },
  });
  assert.equal(conflictingReplay.statusCode, 409);
  assert.equal(calls.length, 6);

  const openedThread = await controlPlane.app.inject({
    method: "GET",
    url: "/v1/commands/threads/thread-remote",
    headers: { authorization: `Bearer ${taskToken}` },
  });
  assert.equal(openedThread.statusCode, 200);
  assert.equal(openedThread.json().thread.id, "thread-remote");
  assert.equal(openedThread.json().timeline[0]?.content, "Restored response");

  const archivedThreads = await controlPlane.app.inject({
    method: "GET",
    url: "/v1/commands/threads/archived?searchTerm=old",
    headers: { authorization: `Bearer ${taskToken}` },
  });
  assert.equal(archivedThreads.statusCode, 200);
  assert.equal(archivedThreads.json().threads[0]?.id, "thread-archived");
  assert.equal(controlPlane.store.snapshot().threads.length, 0);

  const startedTurn = await controlPlane.app.inject({
    method: "POST",
    url: "/v1/commands/threads/thread-remote/turns/start",
    headers: {
      authorization: `Bearer ${taskToken}`,
      "idempotency-key": "turn-start-0001",
    },
    payload: {
      text: "Run the remote task",
      model: "sub2api/gpt-test",
      sandboxMode: "read-only",
      approvalPolicy: "on-request",
    },
  });
  assert.equal(startedTurn.statusCode, 202);
  assert.equal(startedTurn.json().turnId, "turn-remote");
  assert.equal(
    (calls.find((call) => call.command === "turn.start")?.value as { request?: { model?: string } }).request?.model,
    "sub2api/gpt-test",
  );

  const interrupted = await controlPlane.app.inject({
    method: "POST",
    url: "/v1/commands/threads/thread-remote/turns/interrupt",
    headers: {
      authorization: `Bearer ${taskToken}`,
      "idempotency-key": "turn-stop-0001",
    },
    payload: {},
  });
  assert.equal(interrupted.statusCode, 202);

  const submittedInput = await controlPlane.app.inject({
    method: "POST",
    url: "/v1/commands/user-inputs/user-input-remote/submit",
    headers: {
      authorization: `Bearer ${taskToken}`,
      "idempotency-key": "user-input-0001",
    },
    payload: { answers: { token: ["temporary-remote-secret"], mode: ["safe"] } },
  });
  assert.equal(submittedInput.statusCode, 202);

  const replayedInput = await controlPlane.app.inject({
    method: "POST",
    url: "/v1/commands/user-inputs/user-input-remote/submit",
    headers: {
      authorization: `Bearer ${taskToken}`,
      "idempotency-key": "user-input-0001",
    },
    payload: { answers: { mode: ["safe"], token: ["temporary-remote-secret"] } },
  });
  assert.equal(replayedInput.statusCode, 202);
  assert.deepEqual(replayedInput.json(), submittedInput.json());

  const changedModel = await controlPlane.app.inject({
    method: "POST",
    url: "/v1/commands/threads/thread-remote/model",
    headers: {
      authorization: `Bearer ${taskToken}`,
      "idempotency-key": "thread-model-0001",
    },
    payload: { model: "sub2api/gpt-switched" },
  });
  assert.equal(changedModel.statusCode, 200);

  const renamed = await controlPlane.app.inject({
    method: "POST",
    url: "/v1/commands/threads/thread-remote/rename",
    headers: {
      authorization: `Bearer ${taskToken}`,
      "idempotency-key": "thread-rename-0001",
    },
    payload: { name: "Remote private title" },
  });
  assert.equal(renamed.statusCode, 200);

  for (const [operation, key] of [
    ["archive", "thread-archive-0001"],
    ["unarchive", "thread-unarchive-0001"],
  ] as const) {
    const response = await controlPlane.app.inject({
      method: "POST",
      url: `/v1/commands/threads/thread-remote/${operation}`,
      headers: {
        authorization: `Bearer ${taskToken}`,
        "idempotency-key": key,
      },
      payload: {},
    });
    assert.equal(response.statusCode, 200);
  }

  const deleted = await controlPlane.app.inject({
    method: "DELETE",
    url: "/v1/commands/threads/thread-remote",
    headers: {
      authorization: `Bearer ${taskToken}`,
      "idempotency-key": "thread-delete-0001",
    },
    payload: {},
  });
  assert.equal(deleted.statusCode, 200);

  assert.deepEqual(calls.map((call) => call.command), [
    "project.list",
    "project.browse",
    "model.list",
    "project.create",
    "project.forget",
    "thread.start",
    "thread.open",
    "thread.list-archived",
    "turn.start",
    "turn.interrupt",
    "user-input.submit",
    "thread.model",
    "thread.rename",
    "thread.archive",
    "thread.unarchive",
    "thread.delete",
  ]);
  assert.equal(calls.every((call) => call.clientId === "desktop-mobile-access-key"), true);

  const audit = mobileAccess.status().audit;
  assert.equal(audit.some((entry) => entry.action === "task.thread_started"), true);
  assert.equal(audit.some((entry) => entry.action === "project.created"), true);
  assert.equal(audit.some((entry) => entry.action === "project.removed"), true);
  assert.equal(audit.some((entry) => entry.action === "task.turn_started"), true);
  assert.equal(audit.some((entry) => entry.action === "task.turn_interrupted"), true);
  assert.equal(audit.some((entry) => entry.action === "task.user_input_submitted"), true);
  assert.equal(audit.some((entry) => entry.action === "task.thread_model_changed"), true);
  assert.equal(audit.some((entry) => entry.action === "task.thread_renamed"), true);
  assert.equal(audit.some((entry) => entry.action === "task.thread_archived"), true);
  assert.equal(audit.some((entry) => entry.action === "task.thread_unarchived"), true);
  assert.equal(audit.some((entry) => entry.action === "task.thread_deleted"), true);
  assert.doesNotMatch(
    JSON.stringify(audit),
    /Run the remote task|D:\\\\work|temporary-remote-secret|Remote private title/,
  );

  await controlPlane.stop();
});

test("maps unavailable and rejected desktop commands to stable HTTP errors", async () => {
  const mobileAccess = new MobileAccessManager();
  const accessKey = mobileAccess.rotateAccessKey().key;
  const unavailable = await createControlPlane({ logLevel: "silent", mobileAccess });
  const noHandler = await unavailable.app.inject({
    method: "POST",
    url: "/v1/commands/threads/start",
    headers: {
      authorization: `Bearer ${accessKey}`,
      "idempotency-key": "thread-start-0002",
    },
    payload: { projectPath: "D:\\work" },
  });
  assert.equal(noHandler.statusCode, 503);
  await unavailable.stop();

  const rejectingMobileAccess = new MobileAccessManager();
  const rejecting = await createControlPlane({
    logLevel: "silent",
    mobileAccess: rejectingMobileAccess,
    commands: {
      async listArchivedThreads() {
        throw new ControlCommandError("unavailable");
      },
      async startThread() {
        throw new ControlCommandError("unavailable");
      },
      async openThread() {
        throw new ControlCommandError("not_found");
      },
      async startTurn() {
        throw new ControlCommandError("not_found");
      },
      async interruptTurn() {
        throw new ControlCommandError("conflict");
      },
      async submitUserInput() {
        throw new ControlCommandError("invalid");
      },
      async renameThread() {
        throw new ControlCommandError("not_found");
      },
      async archiveThread() {
        throw new ControlCommandError("conflict");
      },
      async unarchiveThread() {
        throw new ControlCommandError("not_found");
      },
      async deleteThread() {
        throw new ControlCommandError("conflict");
      },
    },
  });
  const rejectingToken = rejectingMobileAccess.rotateAccessKey().key;
  const missing = await rejecting.app.inject({
    method: "POST",
    url: "/v1/commands/threads/missing/turns/start",
    headers: {
      authorization: `Bearer ${rejectingToken}`,
      "idempotency-key": "turn-start-0002",
    },
    payload: { text: "Do not leak this prompt" },
  });
  assert.equal(missing.statusCode, 404);
  assert.doesNotMatch(missing.body, /Do not leak this prompt/);

  const conflict = await rejecting.app.inject({
    method: "POST",
    url: "/v1/commands/threads/missing/turns/interrupt",
    headers: {
      authorization: `Bearer ${rejectingToken}`,
      "idempotency-key": "turn-stop-0002",
    },
    payload: {},
  });
  assert.equal(conflict.statusCode, 409);

  const invalidInput = await rejecting.app.inject({
    method: "POST",
    url: "/v1/commands/user-inputs/user-input-missing/submit",
    headers: {
      authorization: `Bearer ${rejectingToken}`,
      "idempotency-key": "user-input-0002",
    },
    payload: { answers: {} },
  });
  assert.equal(invalidInput.statusCode, 400);
  await rejecting.stop();
});
