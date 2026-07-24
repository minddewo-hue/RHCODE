import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlStore, type RemoteCommandContext } from "../src/main/control-plane/app";
import type { ThreadSummary } from "@rhzycode/protocol";
import {
  DesktopRuntime,
  resolveAdvertisedSyncHost,
  resolveSyncTlsConfiguration,
} from "../src/main/runtime.js";

const TEST_GENERATED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=";

interface RuntimeInternals {
  controlPlane: { store: ControlStore };
  threads: Map<string, ThreadSummary>;
  activeTurns: Map<string, string>;
  loadedThreadIds: Set<string>;
  handleAgentMessage(message: unknown): void;
  handleSyncEvent(event: unknown): void;
}

function createRuntimeHarness(codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-"))) {
  const runtime = new DesktopRuntime(".", codexHome);
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
  internals.loadedThreadIds.add("thread-1");
  store.onEvent((event) => internals.handleSyncEvent(event));
  runtime.agent.respond = (id, result) => responses.push({ id, result });
  return { runtime, internals, store, responses, codexHome };
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
  assert.deepEqual(runtime.listProjectDirectories(), []);
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
  runtime.agent.request = async (method, params) => {
    assert.equal(method, "thread/resume");
    assert.deepEqual(params, { threadId: thread.id, modelProvider: "rhzy_gateway" });
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

test("hydrates historical messages for mobile thread opening", async () => {
  const { runtime, internals } = createRuntimeHarness();
  const thread = internals.threads.get("thread-1")!;
  runtime.agent.request = async (method, params) => {
    assert.equal(method, "thread/resume");
    assert.deepEqual(params, { threadId: thread.id, modelProvider: "rhzy_gateway" });
    return {
      thread: {
        id: thread.id,
        cwd: path.resolve("."),
        preview: "Historical task",
        updatedAt: Math.floor(Date.now() / 1_000),
        status: { type: "idle" },
        turns: [{
          id: "turn-history",
          status: "completed",
          items: [
            { id: "user-history", type: "userMessage", content: [{ type: "text", text: "Old question" }] },
            { id: "assistant-history", type: "agentMessage", text: "Old answer" },
          ],
        }],
      },
      model: thread.model,
    } as never;
  };

  const result = await runtime.remoteCommandHandlers().openThread(thread.id, remoteContext());

  assert.deepEqual(result.timeline.map((item) => [item.id, item.kind, item.content]), [
    ["user-history", "user", "Old question"],
    ["assistant-history", "assistant", "Old answer"],
  ]);
});

test("keeps the persisted model when resume reports a different default", async () => {
  const { runtime, internals, store } = createRuntimeHarness();
  const thread = internals.threads.get("thread-1")!;
  const persisted = { ...thread, model: "provider/last-selected" };
  internals.threads.set(thread.id, persisted);
  store.upsertThread(persisted);
  internals.loadedThreadIds.delete(thread.id);
  runtime.agent.request = async (method) => {
    assert.equal(method, "thread/resume");
    return {
      thread: {
        id: thread.id,
        cwd: thread.projectPath,
        preview: thread.title,
        status: { type: "idle" },
        turns: [],
      },
      model: "provider/server-default",
    } as never;
  };

  const detail = await runtime.openThread(thread.id);

  assert.equal(detail.thread.model, "provider/last-selected");
  assert.equal(store.snapshot().threads.find((item) => item.id === thread.id)?.model, "provider/last-selected");
});

test("persists a thread model as soon as it is selected", () => {
  const { runtime, store } = createRuntimeHarness();

  const thread = runtime.setThreadModel("thread-1", " provider/switched ");

  assert.equal(thread.model, "provider/switched");
  assert.equal(store.snapshot().threads.find((item) => item.id === thread.id)?.model, "provider/switched");
  assert.throws(() => runtime.setThreadModel("thread-1", " "), /Thread model is invalid/);
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

test("permanently removes a local thread when only App Server index cleanup fails", async () => {
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

  await runtime.deleteThread(emptyThread.id);

  assert.equal(internals.threads.has(emptyThread.id), false);
  assert.equal(store.snapshot().threads.some((thread) => thread.id === emptyThread.id), false);
});

test("permanently deletes a thread rollout from disk", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-thread-delete-"));
  const codexHome = path.join(root, "home");
  const { runtime } = createRuntimeHarness(codexHome);
  const rolloutPath = path.join(codexHome, "sessions", "rollout-thread-1.jsonl");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
  fs.writeFileSync(rolloutPath, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "thread-1", cwd: path.resolve(".") },
  })}\n`, "utf8");
  runtime.agent.request = async () => ({} as never);

  await runtime.deleteThread("thread-1");

  assert.equal(fs.existsSync(rolloutPath), false);
});

test("permanently deletes every project conversation but keeps source files", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-project-delete-"));
  const codexHome = path.join(root, "home");
  const projectPath = path.join(root, "project");
  const sourceFile = path.join(projectPath, "keep.txt");
  const activeRollout = path.join(codexHome, "sessions", "rollout-thread-1.jsonl");
  const archivedRollout = path.join(codexHome, "archived_sessions", "rollout-thread-archived.jsonl");
  const { runtime, internals, store } = createRuntimeHarness(codexHome);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(sourceFile, "keep", "utf8");
  for (const [filePath, id] of [[activeRollout, "thread-1"], [archivedRollout, "thread-archived"]]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({
      type: "session_meta",
      payload: { id, cwd: projectPath },
    })}\n`, "utf8");
  }
  const projectThread = {
    ...internals.threads.get("thread-1")!,
    projectPath,
    status: "running" as const,
  };
  internals.threads.set(projectThread.id, projectThread);
  store.upsertThread(projectThread);
  runtime.rememberProjectDirectory(projectPath);
  const deletedThreadIds: string[] = [];
  runtime.agent.request = async (method, params) => {
    assert.equal(method, "thread/delete");
    deletedThreadIds.push(String((params as { threadId?: string }).threadId));
    return {} as never;
  };

  const result = await runtime.deleteProjectDirectory(projectPath);

  assert.equal(result.deletedConversationCount, 2);
  assert.deepEqual(new Set(deletedThreadIds), new Set(["thread-1", "thread-archived"]));
  assert.equal(fs.existsSync(activeRollout), false);
  assert.equal(fs.existsSync(archivedRollout), false);
  assert.equal(fs.readFileSync(sourceFile, "utf8"), "keep");
  assert.equal(runtime.listProjectDirectories().some((project) => project.path === projectPath), false);
  assert.equal(store.snapshot().threads.some((thread) => thread.projectPath === projectPath), false);
});

test("finishes project deletion when App Server has lost its thread index", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-project-delete-index-"));
  const codexHome = path.join(root, "home");
  const projectPath = path.join(root, "project");
  const rolloutPath = path.join(codexHome, "sessions", "rollout-index-missing.jsonl");
  const { runtime, internals, store } = createRuntimeHarness(codexHome);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
  fs.writeFileSync(rolloutPath, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "index-missing", cwd: projectPath },
  })}\n`, "utf8");
  internals.threads.delete("thread-1");
  store.removeThread("thread-1");
  runtime.rememberProjectDirectory(projectPath);
  runtime.agent.request = async () => {
    throw new Error("thread not found in state database");
  };

  const result = await runtime.deleteProjectDirectory(projectPath);

  assert.equal(result.deletedConversationCount, 1);
  assert.equal(fs.existsSync(rolloutPath), false);
  assert.equal(runtime.listProjectDirectories().some((project) => project.path === projectPath), false);
});

test("lists restored disk conversations when App Server index is empty", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-restored-list-"));
  const codexHome = path.join(root, "home");
  const projectPath = path.join(root, "project");
  const rolloutPath = path.join(codexHome, "sessions", "2026", "07", "24", "rollout-restored-thread.jsonl");
  const { runtime, internals, store } = createRuntimeHarness(codexHome);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: "2026-07-24T08:00:00.000Z",
      type: "session_meta",
      payload: { id: "restored-thread", cwd: projectPath },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T08:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", text: "Restore this project conversation" },
    }),
    "",
  ].join("\n"), "utf8");
  internals.threads.delete("thread-1");
  store.removeThread("thread-1");
  runtime.agent.request = async (method) => method === "thread/list"
    ? { data: [] } as never
    : {} as never;

  const threads = await runtime.listThreads({ cwd: projectPath });

  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.id, "restored-thread");
  assert.equal(threads[0]?.title, "Restore this project conversation");
  assert.equal(store.snapshot().threads[0]?.id, "restored-thread");
  assert.equal(runtime.listProjectDirectories().some((project) => project.path === projectPath), true);
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

test("stores generated images before forwarding completion events to desktop and mobile", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-image-"));
  try {
    const { runtime, internals, store } = createRuntimeHarness(codexHome);
    const forwarded: Array<Record<string, unknown>> = [];
    runtime.on("agent:message", (message) => forwarded.push(message as Record<string, unknown>));
    const result = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=";

    internals.handleAgentMessage({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: { id: "generated-1", type: "imageGeneration", status: "completed", result },
      },
    });

    const params = forwarded[0]?.params as Record<string, unknown>;
    const item = params.item as Record<string, unknown>;
    assert.equal(item.result, undefined);
    assert.equal(item.generated, true);
    assert.match(String(item.savedPath), /generated_images[\\/]generated-generated-1-[a-f0-9]{16}\.png$/);
    assert.deepEqual(fs.readFileSync(String(item.savedPath)), Buffer.from(result, "base64"));
    assert.deepEqual(store.snapshot().timeline, [{
      id: "generated-1",
      threadId: "thread-1",
      kind: "assistant",
      status: "completed",
      title: "",
      content: "",
      images: [{
        id: String(item.name),
        name: String(item.name),
        generated: true,
      }],
      createdAt: store.snapshot().timeline[0]?.createdAt,
    }]);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("restores generated images from thread history for desktop and mobile", async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-image-"));
  try {
    const { runtime, store } = createRuntimeHarness(codexHome);
    const result = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=";
    runtime.agent.request = async () => ({
      thread: {
        id: "thread-1",
        cwd: path.resolve("."),
        turns: [{
          id: "turn-generated-image",
          items: [{
            id: "generated-history-1",
            type: "imageGeneration",
            status: "completed",
            result,
          }],
        }],
      },
    }) as never;

    const detail = await runtime.openThread("thread-1");
    assert.equal(detail.messages.length, 1);
    assert.equal(detail.messages[0]?.role, "assistant");
    assert.equal(detail.messages[0]?.content, "");
    assert.equal(detail.messages[0]?.images?.[0]?.generated, true);
    assert.equal(fs.existsSync(detail.messages[0]?.images?.[0]?.path || ""), true);
    assert.equal(detail.timeline.length, 0);
    assert.equal(store.snapshot().timeline[0]?.kind, "assistant");
    assert.equal(store.snapshot().timeline[0]?.images?.[0]?.generated, true);
    assert.equal(store.snapshot().timeline[0]?.images?.[0]?.id, detail.messages[0]?.images?.[0]?.name);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("restores rollout images omitted by App Server thread history", async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-rollout-image-"));
  try {
    const { runtime } = createRuntimeHarness(codexHome);
    writeGeneratedImageRollout(codexHome, "thread-1", "turn-rollout-image", "ig-rollout-history");
    runtime.agent.request = async () => ({
      thread: {
        id: "thread-1",
        cwd: path.resolve("."),
        turns: [{
          id: "turn-rollout-image",
          items: [{ id: "assistant-history", type: "agentMessage", text: "Generated." }],
        }],
      },
    }) as never;

    const detail = await runtime.openThread("thread-1");

    assert.equal(detail.messages.length, 2);
    assert.equal(detail.messages[0]?.content, "Generated.");
    assert.equal(detail.messages[1]?.id, "ig-rollout-history");
    assert.equal(detail.messages[1]?.images?.[0]?.generated, true);
    assert.equal(fs.existsSync(detail.messages[1]?.images?.[0]?.path || ""), true);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("publishes a rollout image when App Server completes its turn", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-rollout-image-"));
  try {
    const { runtime, internals, store } = createRuntimeHarness(codexHome);
    const forwarded: Array<Record<string, unknown>> = [];
    runtime.on("agent:message", (message) => forwarded.push(message as Record<string, unknown>));
    writeGeneratedImageRollout(codexHome, "thread-1", "turn-rollout-live", "ig-rollout-live");

    internals.handleAgentMessage({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-rollout-live", status: "completed" },
      },
    });

    const generatedEvent = forwarded.find((message) => message.method === "item/completed");
    const params = generatedEvent?.params as Record<string, unknown>;
    const item = params.item as Record<string, unknown>;
    assert.equal(params.threadId, "thread-1");
    assert.equal(item.id, "ig-rollout-live");
    assert.equal(item.type, "imageGeneration");
    assert.equal(item.generated, true);
    assert.equal(fs.existsSync(String(item.savedPath)), true);
    assert.equal(store.snapshot().timeline.some((entry) =>
      entry.id === "ig-rollout-live" && entry.images?.[0]?.generated === true), true);

    internals.handleAgentMessage({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-rollout-live", status: "completed" },
      },
    });
    assert.equal(forwarded.filter((message) => message.method === "item/completed").length, 1);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
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

test("compacts an oversized thread with its last successful model before switching", async (context) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-compact-"));
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const { runtime, internals } = createRuntimeHarness(codexHome);
  const sessions = path.join(codexHome, "sessions", "2026", "07", "22");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, "rollout-2026-07-22T00-00-00-thread-1.jsonl"),
    [
      { type: "turn_context", payload: { turn_id: "turn-ok", model: "provider-5/gpt-5.6-sol" } },
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 185_516 } } } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-ok" } },
    ].map((record) => JSON.stringify(record)).join("\n"),
  );
  const gateway = runtime.gateway as unknown as { getStatus(): Record<string, unknown> };
  gateway.getStatus = () => ({
    models: [
      { id: "provider-2/grok-latest", contextWindow: 131_072 },
      { id: "provider-5/gpt-5.6-sol", contextWindow: null },
    ],
  });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  runtime.agent.request = async (method, params) => {
    requests.push({ method, params: params as Record<string, unknown> });
    if (method === "thread/compact/start") {
      queueMicrotask(() => internals.handleAgentMessage({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "compact-turn", status: "completed" },
        },
      }));
      return {} as never;
    }
    if (method === "turn/start") return { turn: { id: "turn-grok" } } as never;
    return {} as never;
  };

  await runtime.startTurn({
    threadId: "thread-1",
    text: "Continue with Grok",
    model: "provider-2/grok-latest",
  });

  assert.deepEqual(requests.map((request) => request.method), [
    "thread/settings/update",
    "thread/compact/start",
    "turn/start",
  ]);
  assert.deepEqual(requests[0]?.params, {
    threadId: "thread-1",
    model: "provider-5/gpt-5.6-sol",
  });
  assert.equal(requests[2]?.params.model, "provider-2/grok-latest");
});

test("resumes an unloaded existing thread through the internal gateway before starting a turn", async () => {
  const { runtime, internals } = createRuntimeHarness();
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  internals.loadedThreadIds.delete("thread-1");
  runtime.agent.request = async (method, params) => {
    requests.push({ method, params: params as Record<string, unknown> });
    if (method === "thread/resume") {
      return {
        thread: {
          id: "thread-1",
          cwd: path.resolve("."),
          preview: "Request test",
          status: { type: "idle" },
          turns: [],
        },
        model: "test/model",
      } as never;
    }
    return { turn: { id: "turn-1" } } as never;
  };

  await runtime.startTurn({ threadId: "thread-1", text: "Continue the task" });

  assert.deepEqual(requests[0], {
    method: "thread/resume",
    params: { threadId: "thread-1", modelProvider: "rhzy_gateway" },
  });
  assert.equal(requests[1]?.method, "turn/start");
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

  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-attachments-"));
  const imagePath = path.join(fixtureDirectory, "screen.png");
  const filePath = path.join(fixtureDirectory, "notes.txt");
  fs.writeFileSync(imagePath, Buffer.from(TEST_GENERATED_PNG, "base64"));
  fs.writeFileSync(filePath, "attachment notes", "utf8");
  const turnResult = await runtime.startTurn({
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
  const input = request?.params.input as Array<Record<string, unknown>>;
  const persistedFilePath = String(input[0]?.text || "").split("\n- ").at(-1) || "";
  const persistedImagePath = String(input[1]?.path || "");
  assert.equal(turnResult.files?.[0]?.path, persistedFilePath);
  assert.equal(persistedFilePath, filePath);
  assert.equal(persistedImagePath, imagePath);
  assert.equal(fs.readFileSync(persistedFilePath, "utf8"), "attachment notes");
  assert.deepEqual(input, [
    {
      type: "text",
      text: `Inspect these\n\nAttached files (use these absolute paths):\n- ${persistedFilePath}`,
      text_elements: [],
    },
    { type: "localImage", path: persistedImagePath },
  ]);
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});

test("publishes generated document artifacts as downloadable assistant files", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-artifacts-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-project-artifacts-"));
  const report = path.join(project, "output", "report.pdf");
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, "%PDF-generated", "utf8");
  const { runtime, internals, store } = createRuntimeHarness(codexHome);
  internals.threads.set("thread-1", {
    ...internals.threads.get("thread-1")!,
    projectPath: project,
  });
  internals.activeTurns.set("thread-1", "turn-artifact");
  const forwarded: Array<Record<string, unknown>> = [];
  runtime.on("agent:message", (message) => forwarded.push(message as Record<string, unknown>));

  internals.handleAgentMessage({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-artifact",
      item: {
        id: "assistant-artifact",
        type: "agentMessage",
        text: "Created [report.pdf](output/report.pdf).",
      },
    },
  });

  const artifactEvent = forwarded.find((message) =>
    ((message.params as Record<string, unknown>)?.item as Record<string, unknown>)?.type === "artifact");
  const artifactItem = ((artifactEvent?.params as Record<string, unknown>)?.item || {}) as Record<string, unknown>;
  const files = artifactItem.files as Array<Record<string, unknown>>;
  assert.equal(files[0]?.name, "report.pdf");
  assert.equal(files[0]?.source, "generated");
  assert.equal(fs.readFileSync(String(files[0]?.path), "utf8"), "%PDF-generated");
  assert.equal(store.snapshot().timeline.find((item) => item.id === artifactItem.id)?.files?.[0]?.name, "report.pdf");
  fs.rmSync(codexHome, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

test("publishes locally generated image links as inline assistant images", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-image-artifacts-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-project-image-artifacts-"));
  const imagePath = path.join(project, "sample.png");
  fs.writeFileSync(imagePath, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=",
    "base64",
  ));
  const { runtime, internals, store } = createRuntimeHarness(codexHome);
  internals.threads.set("thread-1", {
    ...internals.threads.get("thread-1")!,
    projectPath: project,
  });
  internals.activeTurns.set("thread-1", "turn-image-artifact");
  const forwarded: Array<Record<string, unknown>> = [];
  runtime.on("agent:message", (message) => forwarded.push(message as Record<string, unknown>));

  internals.handleAgentMessage({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-image-artifact",
      item: {
        id: "assistant-image-artifact",
        type: "agentMessage",
        text: `Generated [sample.png](${imagePath}).`,
      },
    },
  });

  const artifactEvent = forwarded.find((message) =>
    ((message.params as Record<string, unknown>)?.item as Record<string, unknown>)?.type === "artifact");
  const artifactItem = ((artifactEvent?.params as Record<string, unknown>)?.item || {}) as Record<string, unknown>;
  const files = artifactItem.files as Array<Record<string, unknown>>;
  assert.equal(files[0]?.name, "sample.png");
  assert.equal(files[0]?.mimeType, "image/png");
  assert.equal(files[0]?.source, "generated");
  assert.deepEqual(fs.readFileSync(String(files[0]?.path)), fs.readFileSync(imagePath));
  assert.equal(store.snapshot().timeline.find((item) => item.id === artifactItem.id)?.files?.[0]?.mimeType, "image/png");
  fs.rmSync(codexHome, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

test("restores an existing local image link when opening an older thread", async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-history-image-artifacts-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-project-history-image-artifacts-"));
  const imagePath = path.join(project, "sample.png");
  fs.writeFileSync(imagePath, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=",
    "base64",
  ));
  const { runtime } = createRuntimeHarness(codexHome);
  runtime.agent.request = async () => ({
    thread: {
      id: "thread-1",
      cwd: project,
      turns: [{
        id: "turn-history-image",
        status: "completed",
        items: [{
          id: "assistant-history-image",
          type: "agentMessage",
          text: `Generated [sample.png](${imagePath}).`,
        }],
      }],
    },
  }) as never;

  const detail = await runtime.openThread("thread-1");

  assert.equal(detail.messages[0]?.id, "assistant-history-image");
  assert.equal(detail.messages[0]?.images?.[0]?.name, "sample.png");
  assert.equal(detail.messages[0]?.images?.[0]?.generated, true);
  assert.deepEqual(fs.readFileSync(detail.messages[0]?.images?.[0]?.path || ""), fs.readFileSync(imagePath));
  fs.rmSync(codexHome, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

test("does not restore an uploaded file after the user deletes the original", async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-history-files-"));
  const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-runtime-history-source-"));
  const source = path.join(sourceDirectory, "requirements.docx");
  fs.writeFileSync(source, "document body", "utf8");
  const { runtime, internals } = createRuntimeHarness(codexHome);
  runtime.agent.request = async (method) => {
    if (method === "turn/start") return { turn: { id: "turn-files" } } as never;
    if (method === "thread/resume") return {
      cwd: ".",
      model: "test/model",
      thread: {
        id: "thread-1",
        cwd: ".",
        turns: [{
          id: "turn-files",
          status: "completed",
          items: [
            { id: "user-files", type: "userMessage", content: [{ type: "text", text: "Review it" }] },
            { id: "assistant-files", type: "agentMessage", text: "Done" },
          ],
        }],
      },
    } as never;
    return {} as never;
  };
  await runtime.startTurn({
    threadId: "thread-1",
    text: "Review it",
    attachments: [{ path: source, name: "requirements.docx", kind: "file", size: 13 }],
  });
  fs.unlinkSync(source);
  internals.loadedThreadIds.delete("thread-1");
  const detail = await runtime.openThread("thread-1");

  const file = detail.messages.find((message) => message.id === "user-files")?.files?.[0];
  assert.equal(file, undefined);
  fs.rmSync(codexHome, { recursive: true, force: true });
  fs.rmSync(sourceDirectory, { recursive: true, force: true });
});

test("executes remote commands through desktop authority with safe defaults", async () => {
  const { runtime, internals } = createRuntimeHarness();
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  runtime.agent.request = async (method, params) => {
    requests.push({ method, params: params as Record<string, unknown> });
    if (method === "thread/start") return { thread: { id: "thread-remote" } } as never;
    if (method === "turn/start") return { turn: { id: "turn-remote" } } as never;
    if (method === "model/list") return {
      data: [
        {
          id: "sub2api/gpt-test",
          model: "sub2api/gpt-test",
          displayName: "Codex - GPT Test",
          description: "Test model",
          defaultReasoningEffort: "high",
        },
        {
          id: "provider-2/gemma-test",
          model: "provider-2/gemma-test",
          displayName: "Gemma - Gemma Test",
          description: "Model without configurable reasoning",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [],
        },
      ],
    } as never;
    return {} as never;
  };
  runtime.gateway.getStatus = () => ({
    state: "running",
    transport: "internal",
    providerCount: 1,
    modelCount: 2,
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
    }, {
      id: "provider-2/gemma-test",
      ownedBy: "Gemma",
      capabilities: {},
      providerId: "provider-2",
      upstreamModel: "gemma-test",
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
    {
      text: "Run from the mobile client",
      model: "sub2api/gpt-test",
      reasoningEffort: "xhigh",
      attachments: [{
        name: "mobile.txt",
        kind: "file",
        size: 6,
        dataBase64: Buffer.from("mobile").toString("base64"),
      }],
    },
    context,
  );
  assert.equal(startedTurn.turnId, "turn-remote");
  const remoteFilePath = String(((requests[1]?.params.input as Array<Record<string, unknown>>)?.[0]?.text || ""))
    .split("\n- ").at(-1) || "";
  assert.equal(fs.readFileSync(remoteFilePath, "utf8"), "mobile");
  internals.activeTurns.set("thread-remote", "turn-remote");
  const interrupted = await commands.interruptTurn("thread-remote", context);
  assert.equal(interrupted.threadId, "thread-remote");
  assert.equal(fs.existsSync(remoteFilePath), false);
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
    }, {
      id: "provider-2/gemma-test",
      model: "provider-2/gemma-test",
      displayName: "Gemma - Gemma Test",
      source: "Gemma",
      sourceModelName: "gemma-test",
      description: "Model without configurable reasoning",
      defaultReasoningEffort: "high",
      reasoningEfforts: [],
    }],
  });

  assert.deepEqual(requests[0], {
    method: "thread/start",
    params: {
      cwd: path.resolve("."),
      modelProvider: "rhzy_gateway",
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

test("lists, deduplicates, and sorts skills from App Server", async () => {
  const { runtime } = createRuntimeHarness();
  let listParams: Record<string, unknown> | undefined;
  runtime.agent.request = async (method, params) => {
    assert.equal(method, "skills/list");
    listParams = params as Record<string, unknown>;
    const systemSkill = {
      name: "system-skill",
      description: "System skill",
      enabled: true,
      path: path.resolve(".codex", "skills", ".system", "system-skill", "SKILL.md"),
      scope: "system",
    };
    return {
      data: [
        {
          cwd: path.resolve("project-a"),
          skills: [systemSkill],
          errors: [{ path: path.resolve("broken", "SKILL.md"), message: "Invalid frontmatter" }],
        },
        {
          cwd: path.resolve("project-b"),
          skills: [
            systemSkill,
            {
              name: "user-skill",
              description: "Long description",
              shortDescription: "Short description",
              enabled: false,
              path: path.resolve(".codex", "skills", "user-skill", "SKILL.md"),
              scope: "user",
              interface: { displayName: "User Skill" },
            },
          ],
          errors: [{ path: path.resolve("broken", "SKILL.md"), message: "Invalid frontmatter" }],
        },
      ],
    } as never;
  };

  const result = await runtime.listSkills(true);
  assert.equal(listParams?.forceReload, true);
  assert.deepEqual(listParams?.cwds, [path.resolve(process.cwd())]);
  assert.deepEqual(result.skills.map((skill) => skill.displayName), ["User Skill", "system-skill"]);
  assert.equal(result.skills[0]?.shortDescription, "Short description");
  assert.equal(result.errors.length, 1);
});

test("writes skill enabled state through App Server", async () => {
  const { runtime } = createRuntimeHarness();
  const skillPath = path.resolve(".codex", "skills", "reviewer", "SKILL.md");
  runtime.agent.request = async (method, params) => {
    assert.equal(method, "skills/config/write");
    assert.deepEqual(params, { path: skillPath, enabled: false });
    return { effectiveEnabled: false } as never;
  };

  assert.equal(await runtime.setSkillEnabled(skillPath, false), false);
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

function writeGeneratedImageRollout(
  codexHome: string,
  threadId: string,
  turnId: string,
  itemId: string,
): void {
  const directory = path.join(codexHome, "sessions", "2026", "07", "22");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-test-${threadId}.jsonl`), JSON.stringify({
    timestamp: "2026-07-22T07:03:38.992Z",
    type: "response_item",
    payload: {
      type: "image_generation_call",
      id: itemId,
      status: "completed",
      revised_prompt: "A generated rollout image",
      result: TEST_GENERATED_PNG,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  }), "utf8");
}
