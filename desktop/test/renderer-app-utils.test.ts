import assert from "node:assert/strict";
import test from "node:test";
import {
  activityLabel,
  basename,
  completeAssistantMessage,
  describeItem,
  fitImagePreviewSize,
  formatFileChanges,
  formatFileSize,
  groupModelsBySource,
  groupThreadsByProject,
  isComposerRunning,
  isSameProjectPath,
  mergeActivityDeltas,
  mergeStreamingMessageDeltas,
  modelReasoningEfforts,
  notificationThreadId,
  providerCredentialPresentation,
  providerDisplayName,
  reconcileProjectRegistry,
  storedCollapsedProjectPaths,
  storeCollapsedProjectPaths,
  summarizePrompt,
} from "../src/renderer/src/app-utils";

test("merges streaming deltas without replacing unchanged history", () => {
  const unchanged = { id: "user-1", role: "user" as const, content: "Question" };
  const messages = [
    unchanged,
    { id: "assistant-1", role: "assistant" as const, content: "Part " },
  ];
  const merged = mergeStreamingMessageDeltas(messages, new Map([
    ["assistant-1", "one"],
    ["assistant-2", "Part two"],
  ]));

  assert.strictEqual(merged[0], unchanged);
  assert.deepEqual(merged[1], {
    id: "assistant-1",
    role: "assistant",
    content: "Part one",
    streaming: true,
  });
  assert.deepEqual(merged[2], {
    id: "assistant-2",
    role: "assistant",
    content: "Part two",
    streaming: true,
  });

  const activities = mergeActivityDeltas(
    [{ id: "reasoning", label: "Analysis", detail: "First ", state: "running" }],
    new Map([
      ["reasoning", { label: "Analysis", delta: "second", state: "running" as const }],
      ["command", { label: "Command", delta: "done", state: "done" as const }],
    ]),
  );
  assert.equal(activities.find((entry) => entry.id === "reasoning")?.detail, "First second");
  assert.equal(activities[0]?.id, "command");
});

test("shows completed assistant messages even when no streaming delta arrived", () => {
  const completed = completeAssistantMessage(
    [{ id: "user-1", role: "user", content: "Generate an image" }],
    "turn-1::assistant-1",
    "The image is ready.",
  );

  assert.deepEqual(completed.at(-1), {
    id: "turn-1::assistant-1",
    role: "assistant",
    content: "The image is ready.",
  });
});

test("reconciles a streamed assistant message with its completed text", () => {
  const completed = completeAssistantMessage(
    [{
      id: "turn-1::assistant-1",
      role: "assistant",
      content: "Partial response",
      streaming: true,
    }],
    "turn-1::assistant-1",
    "Complete response",
  );

  assert.deepEqual(completed, [{
    id: "turn-1::assistant-1",
    role: "assistant",
    content: "Complete response",
    streaming: false,
  }]);
});

test("reconciles project removal and re-addition across clients", () => {
  const removed = reconcileProjectRegistry(
    ["D:\\work\\alpha", "D:\\work\\beta"],
    ["d:\\WORK\\beta"],
    [],
  );
  assert.deepEqual(removed.projects, ["d:\\WORK\\beta"]);
  assert.deepEqual(removed.removedProjects, ["D:\\work\\alpha"]);
  assert.deepEqual(removed.forgottenProjects, ["D:\\work\\alpha"]);

  const restored = reconcileProjectRegistry(
    removed.projects,
    ["D:\\work\\beta", "D:\\work\\alpha"],
    removed.forgottenProjects,
  );
  assert.deepEqual(restored.projects, ["D:\\work\\beta", "D:\\work\\alpha"]);
  assert.deepEqual(restored.removedProjects, []);
  assert.deepEqual(restored.forgottenProjects, []);
});

class MemoryLocalStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("formats renderer display values", () => {
  assert.equal(basename("C:\\work\\project"), "project");
  assert.equal(basename("/work/project/"), "project");
  assert.equal(isSameProjectPath("D:\\work_space\\mul_cli", "d:/work_space/mul_cli/"), true);
  assert.equal(isSameProjectPath("/Work/project", "/work/project"), false);
  assert.equal(formatFileSize(1_024), "1 KB");
  assert.equal(activityLabel("commandExecution"), "Command");
  assert.deepEqual(providerCredentialPresentation("sub2api"), {
    label: "model.rhzy.ai API key",
    domain: "model.rhzy.ai",
    prefix: "sk-",
  });
});

test("fits image previews without changing their aspect ratio or upscaling", () => {
  assert.deepEqual(fitImagePreviewSize(320, 240), { width: 320, height: 240 });
  assert.deepEqual(fitImagePreviewSize(1_200, 600), { width: 420, height: 210 });
  assert.deepEqual(fitImagePreviewSize(600, 1_200), { width: 210, height: 420 });
  assert.equal(fitImagePreviewSize(0, 240), null);
});

test("persists valid collapsed projects with path-aware deduplication", () => {
  const storage = new MemoryLocalStorage();
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

  try {
    storeCollapsedProjectPaths(["D:\\work\\alpha", "d:/work/alpha/", "", "/work/beta"]);
    assert.deepEqual(storedCollapsedProjectPaths(), ["D:\\work\\alpha", "/work/beta"]);

    storage.setItem("rhzycode.collapsedProjects", JSON.stringify(["D:\\work\\valid", null, 42]));
    assert.deepEqual(storedCollapsedProjectPaths(), ["D:\\work\\valid"]);
    storage.setItem("rhzycode.collapsedProjects", "not-json");
    assert.deepEqual(storedCollapsedProjectPaths(), []);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("groups all tasks by project and searches across the project tree", () => {
  const threads = [
    {
      id: "thread-b",
      hostId: "desktop",
      title: "Write release notes",
      projectPath: "D:\\work\\beta",
      model: "provider/model",
      status: "completed" as const,
      updatedAt: "2026-07-23T02:00:00.000Z",
    },
    {
      id: "thread-a",
      hostId: "desktop",
      title: "Fix navigation",
      projectPath: "D:\\work\\alpha",
      model: "provider/model",
      status: "completed" as const,
      updatedAt: "2026-07-23T01:00:00.000Z",
    },
    {
      id: "thread-c",
      hostId: "desktop",
      title: "Review navigation",
      projectPath: "D:\\work\\alpha",
      model: "provider/model",
      status: "completed" as const,
      updatedAt: "2026-07-23T03:00:00.000Z",
    },
  ];

  const groups = groupThreadsByProject(
    ["D:\\work\\alpha", "D:\\work\\empty"],
    "D:\\WORK\\ALPHA",
    threads,
  );
  assert.deepEqual(groups.map((group) => ({
    name: group.name,
    threads: group.threads.map((thread) => thread.id),
  })), [
    { name: "alpha", threads: ["thread-a", "thread-c"] },
    { name: "empty", threads: [] },
    { name: "beta", threads: ["thread-b"] },
  ]);

  assert.deepEqual(
    groupThreadsByProject(groups.map((group) => group.path), "", threads, "release")
      .map((group) => ({ name: group.name, threads: group.threads.map((thread) => thread.id) })),
    [{ name: "beta", threads: ["thread-b"] }],
  );
});

test("uses every reasoning effort supported by the selected model", () => {
  assert.deepEqual(modelReasoningEfforts({
    id: "model-1",
    model: "provider/model-1",
    displayName: "Model 1",
    description: "Test model",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "xhigh", description: "Deep" },
    ],
  }), ["low", "medium", "xhigh"]);
});

test("preserves an explicitly empty reasoning effort list", () => {
  assert.deepEqual(modelReasoningEfforts({
    id: "model-1",
    model: "provider/gemma-model",
    displayName: "Gemma model",
    description: "Model without configurable reasoning",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [],
  }), []);
});

test("groups models by source and naturally sorts versions within each source", () => {
  const model = (modelId: string, displayName: string) => ({
    id: modelId,
    model: modelId,
    displayName,
    description: "Test model",
    defaultReasoningEffort: "medium",
  });

  const providers = [
    {
      providerId: "sub2api",
      name: "Sub2API",
      baseUrl: "https://model.example/v1",
      protocol: "responses" as const,
      detectedProtocol: "responses" as const,
      models: [],
      custom: false,
      configured: true,
      source: "secure_store" as const,
    },
    {
      providerId: "domestic",
      name: "Domestic",
      baseUrl: "https://domestic.example/v1",
      protocol: "responses" as const,
      detectedProtocol: "responses" as const,
      models: [],
      custom: true,
      configured: true,
      source: "secure_store" as const,
    },
  ];
  const groups = groupModelsBySource([
    model("domestic/minimax-m2.7", "Legacy label - MiniMax-M2.7"),
    model("sub2api/gpt-5.4-mini", "Codex - gpt-5.4-mini"),
    model("domestic/minimax-m2.1", "Domestic - MiniMax-M2.1"),
    model("sub2api/gpt-5.4", "Sub2API - gpt-5.4"),
    model("domestic/minimax-m3", "Domestic - MiniMax-M3"),
  ], providers);

  assert.deepEqual(groups.map((group) => ({
    source: group.source,
    models: group.models.map((entry) => entry.sourceModelName),
  })), [
    { source: "Sub2API", models: ["gpt-5.4", "gpt-5.4-mini"] },
    { source: "Domestic", models: ["minimax-m2.1", "minimax-m2.7", "minimax-m3"] },
  ]);
});

test("uses the configured provider name consistently", () => {
  assert.equal(providerDisplayName({
    providerId: "sub2api",
    name: "sub2api",
    baseUrl: "https://model.example/v1",
    protocol: "responses",
    detectedProtocol: "responses",
    models: [],
    custom: false,
    configured: true,
    source: "secure_store",
  }), "Sub2API");
});

test("normalizes activity details", () => {
  assert.equal(
    formatFileChanges([{ kind: "update", path: "src/App.tsx", diff: "+changed" }]),
    "update src/App.tsx\n+changed",
  );
  assert.equal(
    describeItem({ type: "commandExecution", command: "npm test", aggregatedOutput: "passed" }),
    "npm test\npassed",
  );
});

test("extracts thread identifiers from supported notifications", () => {
  assert.equal(notificationThreadId({ threadId: "thread-direct" }), "thread-direct");
  assert.equal(notificationThreadId({ thread: { id: "thread-nested" } }), "thread-nested");
  assert.equal(notificationThreadId({ turn: { threadId: "thread-turn" } }), "thread-turn");
  assert.equal(notificationThreadId({}), null);
});

test("creates bounded task titles", () => {
  assert.equal(summarizePrompt("  Fix   desktop layout  "), "Fix desktop layout");
  assert.equal(summarizePrompt("x".repeat(80)), `${"x".repeat(57)}...`);
});

test("locks the composer only for the selected running thread", () => {
  const activeThreadIds = new Set(["thread-running"]);

  assert.equal(isComposerRunning("thread-running", activeThreadIds, false), true);
  assert.equal(isComposerRunning("thread-completed", activeThreadIds, false), false);
  assert.equal(isComposerRunning(null, activeThreadIds, false), false);
  assert.equal(isComposerRunning("thread-completed", activeThreadIds, true), true);
});

test("searches task titles and projects but ignores model id substrings", () => {
  const threads = [
    {
      id: "thread-chip",
      hostId: "desktop",
      title: "报价分析",
      projectPath: "D:\\chip_work\\ChipData",
      model: "provider-2/grok-latest",
      status: "completed" as const,
      updatedAt: "2026-07-23T02:00:00.000Z",
    },
    {
      id: "thread-hook",
      hostId: "desktop",
      title: "Fix react hook order",
      projectPath: "D:\\work\\alpha",
      model: "provider/model",
      status: "completed" as const,
      updatedAt: "2026-07-23T03:00:00.000Z",
    },
  ];

  assert.deepEqual(
    groupThreadsByProject(["D:\\work\\alpha", "D:\\chip_work\\ChipData"], "", threads, "test")
      .map((group) => group.threads.map((thread) => thread.id)),
    [],
  );
  assert.deepEqual(
    groupThreadsByProject(["D:\\work\\alpha", "D:\\chip_work\\ChipData"], "", threads, "hook")
      .map((group) => ({ name: group.name, threads: group.threads.map((thread) => thread.id) })),
    [{ name: "alpha", threads: ["thread-hook"] }],
  );
  assert.deepEqual(
    groupThreadsByProject(["D:\\work\\alpha", "D:\\chip_work\\ChipData"], "", threads, "chip")
      .map((group) => ({ name: group.name, threads: group.threads.map((thread) => thread.id) })),
    [{ name: "ChipData", threads: ["thread-chip"] }],
  );
});
