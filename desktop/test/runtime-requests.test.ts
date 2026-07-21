import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { ControlStore, type RemoteCommandContext } from "../src/main/control-plane/app";
import type { ThreadSummary } from "@rhzycode/protocol";
import {
  DesktopRuntime,
  resolveAdvertisedSyncHost,
  resolveSyncTlsConfiguration,
} from "../src/main/runtime.js";

interface RuntimeInternals {
  controlPlane: { store: ControlStore };
  threads: Map<string, ThreadSummary>;
  activeTurns: Map<string, string>;
  handleAgentMessage(message: unknown): void;
  handleSyncEvent(event: unknown): void;
}

function createRuntimeHarness() {
  const runtime = new DesktopRuntime(".", ".");
  const internals = runtime as unknown as RuntimeInternals;
  const store = new ControlStore();
  const responses: Array<{ id: number | string; result: unknown }> = [];
  internals.controlPlane = { store };
  internals.threads.set("thread-1", {
    id: "thread-1",
    hostId: "local-desktop",
    title: "Request test",
    projectPath: ".",
    model: "test/model",
    status: "running",
    updatedAt: new Date().toISOString(),
  });
  store.onEvent((event) => internals.handleSyncEvent(event));
  runtime.agent.respond = (id, result) => responses.push({ id, result });
  return { runtime, internals, store, responses };
}

function remoteContext(): RemoteCommandContext {
  const now = new Date().toISOString();
  return {
    client: {
      id: "phone-remote",
      name: "Remote phone",
      createdAt: now,
      lastSeenAt: now,
    },
  };
}

test("requires complete TLS files for non-loopback control", () => {
  assert.equal(resolveSyncTlsConfiguration("127.0.0.1", {}), undefined);
  assert.equal(resolveSyncTlsConfiguration("0.0.0.0", {}, undefined, true), undefined);
  assert.throws(
    () => resolveSyncTlsConfiguration("192.168.1.20", {}),
    /Non-loopback control requires HTTPS\/WSS/,
  );
  assert.throws(
    () => resolveSyncTlsConfiguration("127.0.0.1", { RHZYCODE_SYNC_TLS_CERT: "cert.pem" }),
    /must be configured together/,
  );

  const paths: string[] = [];
  const tls = resolveSyncTlsConfiguration(
    "192.168.1.20",
    {
      RHZYCODE_SYNC_TLS_CERT: "cert.pem",
      RHZYCODE_SYNC_TLS_KEY: "key.pem",
      RHZYCODE_SYNC_TLS_CA: "ca.pem",
    },
    (filePath) => {
      paths.push(path.basename(filePath));
      return Buffer.from(path.basename(filePath));
    },
  );
  assert.deepEqual(paths, ["cert.pem", "key.pem", "ca.pem"]);
  assert.equal(Buffer.isBuffer(tls?.cert), true);
  assert.equal(Buffer.isBuffer(tls?.key), true);
  assert.equal(Buffer.isBuffer(tls?.ca), true);
});

test("advertises a physical private IPv4 address for wildcard mobile sync", () => {
  const address = (value: string) => ({
    address: value,
    netmask: "255.255.255.0",
    family: "IPv4" as const,
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${value}/24`,
  });
  assert.equal(resolveAdvertisedSyncHost("127.0.0.1", {}), "127.0.0.1");
  assert.equal(resolveAdvertisedSyncHost("0.0.0.0", {
    "vEthernet (WSL)": [address("172.20.64.1")],
    "Wi-Fi": [address("192.168.1.25")],
  }), "192.168.1.25");
});

test("restores desktop threads without reviving active RPC states", () => {
  const store = new ControlStore();
  store.upsertThread({
    id: "thread-restored",
    hostId: "local-desktop",
    title: "Restored task",
    projectPath: path.resolve("."),
    model: "test/model",
    status: "waiting_for_approval",
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const before = store.snapshot().lastSequence;
  const runtime = new DesktopRuntime(".", ".", "127.0.0.1", 0, store);
  assert.equal(store.snapshot().threads[0]?.status, "interrupted");
  assert.equal(store.snapshot().lastSequence, before + 1);
  assert.equal(store.listEvents(before)[0]?.type, "thread.updated");
  assert.equal(runtime.getSnapshot().threads[0]?.status, "interrupted");
});

test("opens a mobile-created empty thread before its rollout exists", async () => {
  const { runtime, internals } = createRuntimeHarness();
  const emptyThread: ThreadSummary = {
    id: "thread-empty",
    hostId: "local-desktop",
    title: "New task",
    projectPath: path.resolve("."),
    model: "test/model",
    status: "idle",
    updatedAt: new Date().toISOString(),
  };
  internals.threads.set(emptyThread.id, emptyThread);
  runtime.agent.request = async (method) => {
    if (method === "thread/list") return { data: [] } as never;
    throw new Error(`no rollout found for thread id ${emptyThread.id}`);
  };

  assert.deepEqual(await runtime.listThreads({ cwd: emptyThread.projectPath }), [emptyThread]);
  assert.deepEqual(await runtime.openThread(emptyThread.id), {
    thread: emptyThread,
    messages: [],
    timeline: [],
  });
});

test("opens an active thread after its new rollout metadata is written", async () => {
  const { runtime, internals } = createRuntimeHarness();
  const thread = internals.threads.get("thread-1")!;
  let resumeAttempts = 0;
  runtime.agent.request = async (method) => {
    assert.equal(method, "thread/resume");
    resumeAttempts += 1;
    if (resumeAttempts < 3) {
      throw new Error("failed to read session metadata C:\\sessions\\rollout.jsonl: rollout at C:\\sessions\\rollout.jsonl is empty");
    }
    return {
      thread: {
        id: thread.id,
        cwd: thread.projectPath,
        preview: "Request test",
        status: { type: "active" },
        turns: [],
      },
      model: thread.model,
    } as never;
  };

  const detail = await runtime.openThread(thread.id);

  assert.equal(resumeAttempts, 3);
  assert.equal(detail.thread.id, thread.id);
});

test("deletes a local empty thread before its rollout exists", async () => {
  const { runtime, internals, store } = createRuntimeHarness();
  const emptyThread: ThreadSummary = {
    id: "thread-empty",
    hostId: "local-desktop",
    title: "New task",
    projectPath: path.resolve("."),
    model: "test/model",
    status: "idle",
    updatedAt: new Date().toISOString(),
  };
  internals.threads.set(emptyThread.id, emptyThread);
  store.upsertThread(emptyThread);
  runtime.agent.request = async () => {
    throw new Error(`no rollout found for thread id ${emptyThread.id}`);
  };

  await runtime.deleteThread(emptyThread.id);

  assert.equal(internals.threads.has(emptyThread.id), false);
  assert.equal(store.snapshot().threads.some((thread) => thread.id === emptyThread.id), false);
});

test("deletes a local empty thread whose rollout file has no metadata yet", async () => {
  const { runtime, internals, store } = createRuntimeHarness();
  const emptyThread: ThreadSummary = {
    id: "thread-empty-file",
    hostId: "local-desktop",
    title: "New task",
    projectPath: path.resolve("."),
    model: "test/model",
    status: "idle",
    updatedAt: new Date().toISOString(),
  };
  internals.threads.set(emptyThread.id, emptyThread);
  store.upsertThread(emptyThread);
  runtime.agent.request = async () => {
    throw new Error("failed to read session metadata C:\\sessions\\rollout.jsonl: rollout at C:\\sessions\\rollout.jsonl is empty");
  };

  await runtime.deleteThread(emptyThread.id);

  assert.equal(internals.threads.has(emptyThread.id), false);
  assert.equal(store.snapshot().threads.some((thread) => thread.id === emptyThread.id), false);
});

test("preserves a local empty thread when App Server deletion fails", async () => {
  const { runtime, internals, store } = createRuntimeHarness();
  const emptyThread: ThreadSummary = {
    id: "thread-empty",
    hostId: "local-desktop",
    title: "New task",
    projectPath: path.resolve("."),
    model: "test/model",
    status: "idle",
    updatedAt: new Date().toISOString(),
  };
  internals.threads.set(emptyThread.id, emptyThread);
  store.upsertThread(emptyThread);
  runtime.agent.request = async () => {
    throw new Error("App Server unavailable");
  };

  await assert.rejects(() => runtime.deleteThread(emptyThread.id), /App Server unavailable/);

  assert.equal(internals.threads.has(emptyThread.id), true);
  assert.equal(store.snapshot().threads.some((thread) => thread.id === emptyThread.id), true);
});

test("restores local images as message previews instead of placeholder text", async () => {
  const { runtime } = createRuntimeHarness();
  const imagePath = path.resolve("fixtures", "screen.png");
  runtime.agent.request = async () => ({
    thread: {
      id: "thread-1",
      cwd: path.resolve("."),
      turns: [{
        id: "turn-image",
        items: [{
          id: "user-image",
          type: "userMessage",
          content: [
            { type: "text", text: "see" },
            { type: "localImage", path: imagePath },
          ],
        }],
      }],
    },
  }) as never;

  const detail = await runtime.openThread("thread-1");
  assert.deepEqual(detail.messages, [{
    id: "user-image",
    role: "user",
    content: "see",
    images: [{ path: imagePath, name: "screen.png" }],
  }]);
});

test("forwards user answers without storing secret values", () => {
  const { runtime, internals, store, responses } = createRuntimeHarness();
  internals.handleAgentMessage({
    id: 17,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      autoResolutionMs: null,
      questions: [
        {
          id: "mode",
          header: "Mode",
          question: "Choose a mode",
          isOther: false,
          isSecret: false,
          options: [{ label: "Fast", description: "Use the fast path" }],
        },
        {
          id: "token",
          header: "Credential",
          question: "Enter the token",
          isOther: false,
          isSecret: true,
          options: null,
        },
      ],
    },
  });

  assert.equal(store.snapshot().userInputs.length, 1);
  assert.equal(store.snapshot().threads[0]?.status, "waiting_for_input");
  runtime.resolveUserInput("user-input-17", {
    mode: ["Fast"],
    token: ["temporary-secret-value"],
  });

  assert.deepEqual(responses, [{
    id: 17,
    result: {
      answers: {
        mode: { answers: ["Fast"] },
        token: { answers: ["temporary-secret-value"] },
      },
    },
  }]);
  assert.equal(store.snapshot().userInputs.length, 0);
  assert.doesNotMatch(JSON.stringify(store.listEvents(0)), /temporary-secret-value/);
});

test("publishes agent messages as plain assistant content without user metadata rows", () => {
  const { internals, store } = createRuntimeHarness();
  internals.handleAgentMessage({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      item: { id: "user-item", type: "userMessage", text: "userMessage" },
    },
  });
  internals.handleAgentMessage({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      item: { id: "assistant-item", type: "agentMessage", text: "Plain response body" },
    },
  });

  assert.deepEqual(store.snapshot().timeline, [{
    id: "assistant-item",
    threadId: "thread-1",
    kind: "assistant",
    status: "completed",
    title: "",
    content: "Plain response body",
    createdAt: store.snapshot().timeline[0]?.createdAt,
  }]);
  assert.doesNotMatch(JSON.stringify(store.snapshot().timeline), /userMessage|Agent activity/);
});

test("submits remote user input only for pending question IDs", async () => {
  const { runtime, internals, store, responses } = createRuntimeHarness();
  internals.handleAgentMessage({
    id: 18,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-2",
      autoResolutionMs: null,
      questions: [{
        id: "token",
        header: "Credential",
        question: "Enter the temporary token",
        isOther: false,
        isSecret: true,
        options: null,
      }],
    },
  });

  const commands = runtime.remoteCommandHandlers();
  await assert.rejects(
    () => commands.submitUserInput(
      "user-input-18",
      { answers: { unknown: ["must-not-be-forwarded"] } },
      remoteContext(),
    ),
    (error: unknown) => (error as { code?: string }).code === "invalid",
  );
  assert.equal(store.snapshot().userInputs.length, 1);

  const result = await commands.submitUserInput(
    "user-input-18",
    { answers: { token: ["remote-temporary-secret"] } },
    remoteContext(),
  );
  assert.equal(result.requestId, "user-input-18");
  assert.deepEqual(responses, [{
    id: 18,
    result: { answers: { token: { answers: ["remote-temporary-secret"] } } },
  }]);
  assert.equal(store.snapshot().userInputs.length, 0);
  assert.doesNotMatch(JSON.stringify(store.listEvents(0)), /remote-temporary-secret/);
});

test("grants requested permissions for one turn and denies with an empty profile", () => {
  const { runtime, internals, responses } = createRuntimeHarness();
  const params = {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    cwd: "D:\\work",
    reason: "Need network and output access",
    permissions: {
      network: { enabled: true },
      fileSystem: { read: ["D:\\work"], write: ["D:\\work\\out"], entries: [] },
    },
  };

  internals.handleAgentMessage({ id: 21, method: "item/permissions/requestApproval", params });
  runtime.resolveApproval("approval-21", "approved");
  assert.deepEqual(responses.at(-1), {
    id: 21,
    result: {
      permissions: params.permissions,
      scope: "turn",
    },
  });

  internals.handleAgentMessage({ id: 22, method: "item/permissions/requestApproval", params });
  runtime.resolveApproval("approval-22", "declined");
  assert.deepEqual(responses.at(-1), {
    id: 22,
    result: { permissions: {}, scope: "turn" },
  });
});

test("overrides the model, approval policy, and reasoning effort on an existing thread", async () => {
  const { runtime, internals, store } = createRuntimeHarness();
  let request: { method: string; params: Record<string, unknown> } | null = null;
  runtime.agent.request = async (method, params) => {
    request = { method, params: params as Record<string, unknown> };
    return { turn: { id: "turn-1" } } as never;
  };

  await runtime.startTurn({
    threadId: "thread-1",
    text: "Run the task",
    model: "faker/kimi-for-coding",
    approvalPolicy: "untrusted",
    reasoningEffort: "xhigh",
  });

  assert.equal(request?.method, "turn/start");
  assert.equal(request?.params.model, "faker/kimi-for-coding");
  assert.equal(request?.params.approvalPolicy, "untrusted");
  assert.equal(request?.params.effort, "xhigh");
  assert.equal(internals.activeTurns.get("thread-1"), "turn-1");
  assert.equal(internals.threads.get("thread-1")?.model, "faker/kimi-for-coding");
  assert.equal(store.snapshot().threads[0]?.model, "faker/kimi-for-coding");
});

test("routes concurrent turn events to the matching thread", () => {
  const { runtime, internals, store } = createRuntimeHarness();
  const now = new Date().toISOString();
  const secondThread: ThreadSummary = {
    id: "thread-2",
    hostId: "local-desktop",
    title: "Second request",
    projectPath: ".",
    model: "test/model",
    status: "running",
    updatedAt: now,
  };
  internals.threads.set(secondThread.id, secondThread);
  store.upsertThread(secondThread);
  internals.activeTurns.set("thread-1", "turn-1");
  internals.activeTurns.set("thread-2", "turn-2");
  const forwarded: Array<Record<string, unknown>> = [];
  runtime.on("agent:message", (message) => forwarded.push(message as Record<string, unknown>));

  internals.handleAgentMessage({
    method: "item/agentMessage/delta",
    params: {
      turnId: "turn-2",
      itemId: "assistant-2",
      delta: "Second thread output",
    },
  });

  assert.equal(store.snapshot().timeline.find((item) => item.id === "assistant-2")?.threadId, "thread-2");
  assert.equal((forwarded[0]?.params as Record<string, unknown>)?.threadId, "thread-2");
});

test("finalizes running timeline items when a turn is interrupted", async () => {
  const { runtime, internals, store } = createRuntimeHarness();
  internals.activeTurns.set("thread-1", "turn-1");
  runtime.agent.request = async () => ({}) as never;
  internals.handleAgentMessage({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "assistant-running",
      delta: "Partial output",
    },
  });
  assert.equal(store.snapshot().timeline.find((item) => item.id === "assistant-running")?.status, "running");

  await runtime.interruptTurn("thread-1");

  assert.equal(store.snapshot().timeline.find((item) => item.id === "assistant-running")?.status, "completed");
  assert.equal(store.snapshot().threads.find((thread) => thread.id === "thread-1")?.status, "interrupted");
});

test("limits workspace-write sandbox roots and maps attachments to App Server input", async () => {
  const { runtime } = createRuntimeHarness();
  let request: { method: string; params: Record<string, unknown> } | null = null;
  runtime.agent.request = async (method, params) => {
    request = { method, params: params as Record<string, unknown> };
    return { turn: { id: "turn-1" } } as never;
  };

  const imagePath = path.resolve("fixtures", "screen.png");
  const filePath = path.resolve("fixtures", "notes.txt");
  await runtime.startTurn({
    threadId: "thread-1",
    text: "Inspect these",
    sandboxMode: "workspace-write",
    attachments: [
      { path: imagePath, name: "screen.png", kind: "image", size: 12 },
      { path: filePath, name: "notes.txt", kind: "file", size: 24 },
    ],
  });

  assert.equal(request?.method, "turn/start");
  assert.deepEqual(request?.params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [path.resolve(".")],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
  assert.deepEqual(request?.params.input, [
    {
      type: "text",
      text: `Inspect these\n\nAttached files (use these absolute paths):\n- ${filePath}`,
      text_elements: [],
    },
    { type: "localImage", path: imagePath },
  ]);
});

test("executes remote commands through desktop authority with safe defaults", async () => {
  const { runtime, internals } = createRuntimeHarness();
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  runtime.agent.request = async (method, params) => {
    requests.push({ method, params: params as Record<string, unknown> });
    if (method === "thread/start") return { thread: { id: "thread-remote" } } as never;
    if (method === "turn/start") return { turn: { id: "turn-remote" } } as never;
    if (method === "model/list") return {
      data: [{
        id: "sub2api/gpt-test",
        model: "sub2api/gpt-test",
        displayName: "Codex - GPT Test",
        description: "Test model",
        defaultReasoningEffort: "high",
      }],
    } as never;
    return {} as never;
  };
  runtime.gateway.getStatus = () => ({
    state: "running",
    transport: "internal",
    providerCount: 1,
    modelCount: 1,
    configSource: "test",
    providers: [],
    models: [{
      id: "sub2api/gpt-test",
      ownedBy: "sub2api",
      capabilities: {},
      providerId: "sub2api",
      upstreamModel: "gpt-test",
      protocol: "responses",
      contextWindow: null,
      runtimeInstructions: null,
    }],
    error: null,
  });
  const commands = runtime.remoteCommandHandlers();
  const context = {
    client: {
      id: "phone-remote",
      name: "Remote phone",
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    },
  };

  await assert.rejects(
    () => commands.startThread({ projectPath: path.resolve("unknown-project") }, context),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );

  const startedThread = await commands.startThread({ projectPath: path.resolve(".") }, context);
  assert.equal(startedThread.threadId, "thread-remote");
  const startedTurn = await commands.startTurn(
    "thread-remote",
    { text: "Run from the mobile client", model: "sub2api/gpt-test", reasoningEffort: "xhigh" },
    context,
  );
  assert.equal(startedTurn.turnId, "turn-remote");
  internals.activeTurns.set("thread-remote", "turn-remote");
  const interrupted = await commands.interruptTurn("thread-remote", context);
  assert.equal(interrupted.threadId, "thread-remote");
  assert.deepEqual(await commands.listModels?.(context), {
    models: [{
      id: "sub2api/gpt-test",
      model: "sub2api/gpt-test",
      displayName: "Codex - GPT Test",
      source: "Sub2API",
      sourceModelName: "gpt-test",
      description: "Test model",
      defaultReasoningEffort: "high",
      reasoningEfforts: ["high"],
    }],
  });

  assert.deepEqual(requests[0], {
    method: "thread/start",
    params: {
      cwd: path.resolve("."),
      approvalPolicy: "on-request",
      sandbox: "read-only",
    },
  });
  assert.equal(requests[1]?.method, "turn/start");
  assert.equal(requests[1]?.params.model, "sub2api/gpt-test");
  assert.equal(requests[1]?.params.approvalPolicy, "on-request");
  assert.equal(requests[1]?.params.effort, "xhigh");
  assert.deepEqual(requests[1]?.params.sandboxPolicy, {
    type: "readOnly",
    networkAccess: false,
  });
  assert.deepEqual(requests[2], {
    method: "turn/interrupt",
    params: { threadId: "thread-remote", turnId: "turn-remote" },
  });
  assert.equal(requests[3]?.method, "model/list");
});

test("executes remote thread lifecycle commands and rehydrates restored state", async () => {
  const { runtime, internals, store } = createRuntimeHarness();
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let restored = false;
  const serverThread = {
    id: "thread-1",
    name: "Remote lifecycle",
    cwd: path.resolve("."),
    updatedAt: Math.floor(Date.now() / 1_000),
    status: { type: "notLoaded" },
  };
  runtime.agent.request = async (method, params) => {
    requests.push({ method, params: params as Record<string, unknown> });
    if (method === "thread/list") {
      const archived = Boolean((params as { archived?: boolean }).archived);
      return { data: archived === !restored ? [serverThread] : [] } as never;
    }
    if (method === "thread/unarchive") restored = true;
    return {} as never;
  };
  const commands = runtime.remoteCommandHandlers();

  await assert.rejects(
    () => commands.archiveThread("thread-1", remoteContext()),
    (error: unknown) => (error as { code?: string }).code === "conflict",
  );
  assert.equal(requests.length, 0);

  const current = internals.threads.get("thread-1")!;
  internals.threads.set("thread-1", { ...current, status: "completed" });
  await commands.renameThread("thread-1", { name: "Remote lifecycle" }, remoteContext());
  await commands.archiveThread("thread-1", remoteContext());
  assert.equal(store.snapshot().threads.length, 0);

  await commands.unarchiveThread("thread-1", remoteContext());
  assert.equal(store.snapshot().threads[0]?.id, "thread-1");
  await commands.deleteThread("thread-1", remoteContext());
  assert.equal(store.snapshot().threads.length, 0);

  assert.deepEqual(requests.map((request) => request.method), [
    "thread/name/set",
    "thread/archive",
    "thread/list",
    "thread/unarchive",
    "thread/list",
    "thread/delete",
  ]);
  assert.equal(
    store.listEvents(0).filter((event) => event.type === "thread.removed").length,
    2,
  );
});

test("keeps archived listings out of the active control snapshot", async () => {
  const { runtime, store } = createRuntimeHarness();
  let listParams: Record<string, unknown> | null = null;
  runtime.agent.request = async (_method, params) => {
    listParams = params as Record<string, unknown>;
    return ({
    data: [{
      id: "thread-archived",
      name: "Archived task",
      cwd: path.resolve("."),
      updatedAt: Math.floor(Date.now() / 1_000),
      status: { type: "notLoaded" },
    }],
    }) as never;
  };

  const result = await runtime.remoteCommandHandlers().listArchivedThreads(
    { searchTerm: "Archived" },
    remoteContext(),
  );
  assert.equal(result.threads[0]?.id, "thread-archived");
  assert.equal(listParams?.archived, true);
  assert.equal(listParams?.searchTerm, "Archived");
  assert.equal(store.snapshot().threads.some((thread) => thread.id === "thread-archived"), false);
  assert.equal(
    store.listEvents(0).some(
      (event) => event.type === "thread.updated" && event.thread.id === "thread-archived",
    ),
    false,
  );
});

test("forwards server-side thread search and archive operations", async () => {
  const { runtime, store } = createRuntimeHarness();
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  runtime.agent.request = async (method, params) => {
    requests.push({ method, params: params as Record<string, unknown> });
    return method === "thread/list" ? { data: [] } as never : {} as never;
  };

  await runtime.listThreads({ cwd: "D:\\work", searchTerm: "gateway", archived: true });
  await runtime.archiveThread("thread-1");

  assert.deepEqual(requests[0], {
    method: "thread/list",
    params: {
      cursor: null,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      cwd: "D:\\work",
      searchTerm: "gateway",
      archived: true,
    },
  });
  assert.deepEqual(requests[1], {
    method: "thread/archive",
    params: { threadId: "thread-1" },
  });
  assert.equal(store.snapshot().threads.length, 0);
  assert.equal(store.listEvents(0).at(-1)?.type, "thread.removed");
});

test("renames and permanently deletes threads through App Server", async () => {
  const { runtime, store } = createRuntimeHarness();
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  runtime.agent.request = async (method, params) => {
    requests.push({ method, params: params as Record<string, unknown> });
    return {} as never;
  };

  await runtime.renameThread("thread-1", "  Release   work  ");
  assert.equal(store.snapshot().threads[0]?.title, "Release work");
  await runtime.deleteThread("thread-1");

  assert.deepEqual(requests, [
    { method: "thread/name/set", params: { threadId: "thread-1", name: "Release work" } },
    { method: "thread/delete", params: { threadId: "thread-1" } },
  ]);
  assert.equal(store.snapshot().threads.length, 0);
});

test("keeps App Server retries running and fails only on the terminal error", () => {
  const { internals, store } = createRuntimeHarness();
  for (const message of [
    "Upstream returned 401",
    "Upstream returned 429",
    "Upstream first-byte timeout",
  ]) {
    internals.handleAgentMessage({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: true,
        error: { message },
      },
    });
    assert.equal(internals.threads.get("thread-1")?.status, "running");
    assert.equal(store.snapshot().timeline.find((item) => item.id === "error-turn-1")?.status, "running");
  }

  internals.handleAgentMessage({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: { message: "Retry budget exhausted" },
    },
  });

  assert.equal(store.snapshot().threads[0]?.status, "failed");
  assert.equal(store.snapshot().timeline.find((item) => item.id === "error-turn-1")?.status, "failed");
  assert.match(store.snapshot().timeline.find((item) => item.id === "error-turn-1")?.content || "", /Retry budget exhausted/);
});

test("changes the mobile sync port and restores the previous listener on failure", async () => {
  const firstPort = await availablePort();
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const blockedAddress = blocker.address();
  assert.ok(blockedAddress && typeof blockedAddress !== "string");

  const runtime = new DesktopRuntime(".", ".", "127.0.0.1", 0, new ControlStore());
  try {
    const changed = await runtime.setSyncPort(firstPort);
    assert.equal(changed.state, "running");
    assert.equal(changed.port, firstPort);

    await assert.rejects(runtime.setSyncPort(blockedAddress.port), /address already in use/i);
    assert.equal(runtime.getSyncStatus().state, "running");
    assert.equal(runtime.getSyncStatus().port, firstPort);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await runtime.stop();
  }
});

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
