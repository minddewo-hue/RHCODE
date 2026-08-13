import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveTaskWindowChrome,
  summarizeTaskActivity,
  taskActivityEventFromTransition,
  toastFromEvent,
  toRendererTaskActivity,
} from "../src/main/task-activity.js";

test("summarizes running and waiting task counts", () => {
  const activity = summarizeTaskActivity([
    { status: "running" },
    { status: "waiting_for_approval" },
    { status: "completed" },
    { status: "waiting_for_input" },
  ]);
  assert.deepEqual(activity, {
    activeCount: 3,
    runningCount: 1,
    waitingCount: 2,
    lastEvent: null,
  });
});

test("maps status transitions into activity events", () => {
  assert.deepEqual(
    taskActivityEventFromTransition("running", "completed", "t1", "Build UI"),
    { kind: "completed", threadId: "t1", title: "Build UI" },
  );
  assert.deepEqual(
    taskActivityEventFromTransition("running", "failed", "t1", "Build UI"),
    { kind: "failed", threadId: "t1", title: "Build UI" },
  );
  assert.deepEqual(
    taskActivityEventFromTransition("idle", "running", "t1", "Build UI"),
    { kind: "started", threadId: "t1", title: "Build UI" },
  );
  assert.deepEqual(
    taskActivityEventFromTransition("running", "waiting_for_approval", "t1", "Build UI"),
    { kind: "waiting", threadId: "t1", title: "Build UI" },
  );
});

test("uses indeterminate progress while tasks are running", () => {
  const chrome = resolveTaskWindowChrome({
    activeCount: 1,
    runningCount: 1,
    waitingCount: 0,
    lastEvent: { kind: "started", threadId: "t1", title: "Build UI" },
  }, { focused: true });
  assert.equal(chrome.mode, "indeterminate");
  assert.equal(chrome.progress, 2);
  assert.equal(chrome.accent, "running");
  assert.equal(chrome.shouldFlash, false);
  assert.equal(chrome.notification, null);
});

test("pauses progress bar while waiting for confirmation", () => {
  const chrome = resolveTaskWindowChrome({
    activeCount: 1,
    runningCount: 0,
    waitingCount: 1,
    lastEvent: { kind: "waiting", threadId: "t1", title: "Build UI" },
  }, { focused: false });
  assert.equal(chrome.mode, "paused");
  assert.equal(chrome.accent, "waiting");
  assert.equal(chrome.shouldFlash, true);
  assert.deepEqual(chrome.notification, { title: "需要确认", body: "Build UI" });
});

test("shows success taskbar color and notification when a task completes unfocused", () => {
  const chrome = resolveTaskWindowChrome({
    activeCount: 0,
    runningCount: 0,
    waitingCount: 0,
    lastEvent: { kind: "completed", threadId: "t1", title: "Build UI" },
  }, { focused: false });
  assert.equal(chrome.mode, "normal");
  assert.equal(chrome.progress, 1);
  assert.equal(chrome.accent, "completed");
  assert.equal(chrome.shouldFlash, true);
  assert.equal(chrome.holdMs > 0, true);
  assert.deepEqual(chrome.notification, { title: "任务已完成", body: "Build UI" });
});

test("shows error taskbar color when a task fails", () => {
  const chrome = resolveTaskWindowChrome({
    activeCount: 0,
    runningCount: 0,
    waitingCount: 0,
    lastEvent: { kind: "failed", threadId: "t1", title: "Build UI" },
  }, { focused: true });
  assert.equal(chrome.mode, "error");
  assert.equal(chrome.accent, "failed");
  assert.equal(chrome.shouldFlash, false);
  assert.equal(chrome.notification, null);
});

test("keeps busy chrome when another task is still active after completion", () => {
  const chrome = resolveTaskWindowChrome({
    activeCount: 1,
    runningCount: 1,
    waitingCount: 0,
    lastEvent: { kind: "completed", threadId: "t1", title: "Build UI" },
  }, { focused: false });
  assert.equal(chrome.mode, "indeterminate");
  assert.equal(chrome.accent, "running");
  assert.equal(chrome.shouldFlash, true);
  assert.deepEqual(chrome.notification, { title: "任务已完成", body: "Build UI" });
});

test("builds renderer toast payloads from activity events", () => {
  assert.deepEqual(toastFromEvent({ kind: "completed", threadId: "t1", title: "Build UI" }), {
    tone: "success",
    message: "任务已完成：Build UI",
  });
  const renderer = toRendererTaskActivity({
    activeCount: 0,
    runningCount: 0,
    waitingCount: 0,
    lastEvent: { kind: "failed", threadId: "t1", title: "Build UI" },
  }, {
    progress: 1,
    mode: "error",
    title: "RHZYCODE · 任务失败",
    accent: "failed",
    shouldFlash: false,
    notification: null,
    holdMs: 1000,
  });
  assert.equal(renderer.accent, "failed");
  assert.deepEqual(renderer.toast, { tone: "error", message: "任务失败：Build UI" });
});
