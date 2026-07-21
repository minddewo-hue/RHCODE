import assert from "node:assert/strict";
import test from "node:test";
import {
  activityLabel,
  basename,
  describeItem,
  formatFileChanges,
  formatFileSize,
  modelReasoningEfforts,
  notificationThreadId,
  providerCredentialPresentation,
  summarizePrompt,
} from "../src/renderer/src/app-utils";

test("formats renderer display values", () => {
  assert.equal(basename("C:\\work\\project"), "project");
  assert.equal(basename("/work/project/"), "project");
  assert.equal(formatFileSize(1_024), "1 KB");
  assert.equal(activityLabel("commandExecution"), "Command");
  assert.deepEqual(providerCredentialPresentation("sub2api"), {
    label: "model.rhzy.ai API key",
    domain: "model.rhzy.ai",
    prefix: "sk-",
  });
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
