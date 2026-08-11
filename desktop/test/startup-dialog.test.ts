import assert from "node:assert/strict";
import test from "node:test";
import { showStartupDialog, type StartupDialogWindow } from "../src/main/startup-dialog.js";

function createWindow(events: string[], minimized = false): StartupDialogWindow {
  return {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    restore: () => events.push("restore"),
    show: () => events.push("show"),
    focus: () => events.push("focus"),
    moveTop: () => events.push("moveTop"),
    setAlwaysOnTop: (flag) => events.push(`alwaysOnTop:${flag}`),
  };
}

test("keeps Linux startup dialogs visible and restores normal window stacking", async () => {
  const events: string[] = [];
  const result = await showStartupDialog(createWindow(events, true), async () => {
    events.push("dialog");
    return "skipped";
  }, "linux");

  assert.equal(result, "skipped");
  assert.deepEqual(events, [
    "restore",
    "show",
    "alwaysOnTop:true",
    "moveTop",
    "focus",
    "dialog",
    "alwaysOnTop:false",
    "moveTop",
    "focus",
  ]);
});

test("restores Linux window stacking when a startup dialog fails", async () => {
  const events: string[] = [];
  await assert.rejects(
    showStartupDialog(createWindow(events), async () => {
      events.push("dialog");
      throw new Error("dialog failed");
    }, "linux"),
    /dialog failed/,
  );
  assert.deepEqual(events.slice(-3), ["alwaysOnTop:false", "moveTop", "focus"]);
});

test("does not change window stacking on other desktop platforms", async () => {
  const events: string[] = [];
  await showStartupDialog(createWindow(events), async () => events.push("dialog"), "win32");
  assert.deepEqual(events, ["dialog"]);
});
