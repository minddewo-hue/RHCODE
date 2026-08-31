import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow } from "electron";
import { sendToRenderer, shouldRecoverRenderer } from "../src/main/renderer-ipc.js";

test("recovers only from unexpected renderer exits", () => {
  assert.equal(shouldRecoverRenderer("crashed"), true);
  assert.equal(shouldRecoverRenderer("oom"), true);
  assert.equal(shouldRecoverRenderer("abnormal-exit"), true);
  assert.equal(shouldRecoverRenderer("clean-exit"), false);
  assert.equal(shouldRecoverRenderer("killed"), false);
});

function rendererWindow(options: {
  windowDestroyed?: boolean;
  contentsDestroyed?: boolean;
  loading?: boolean;
  frameDestroyed?: boolean;
  detached?: boolean;
  sendError?: Error;
} = {}): { window: BrowserWindow; sent: unknown[][] } {
  const sent: unknown[][] = [];
  const frame = {
    detached: options.detached ?? false,
    isDestroyed: () => options.frameDestroyed ?? false,
    send: (...args: unknown[]) => {
      if (options.sendError) throw options.sendError;
      sent.push(args);
    },
  };
  const contents = {
    isDestroyed: () => options.contentsDestroyed ?? false,
    isLoadingMainFrame: () => options.loading ?? false,
    mainFrame: frame,
  };
  return {
    window: {
      isDestroyed: () => options.windowDestroyed ?? false,
      webContents: contents,
    } as unknown as BrowserWindow,
    sent,
  };
}

test("sends IPC through an attached renderer main frame", () => {
  const { window, sent } = rendererWindow();

  assert.equal(sendToRenderer(window, "agent:message", { id: "message-1" }), true);
  assert.deepEqual(sent, [["agent:message", { id: "message-1" }]]);
});

test("does not send while the renderer main frame is unavailable", () => {
  for (const options of [
    { windowDestroyed: true },
    { contentsDestroyed: true },
    { loading: true },
    { frameDestroyed: true },
    { detached: true },
    { sendError: new Error("Render frame was disposed before WebFrameMain could be accessed") },
  ]) {
    const { window, sent } = rendererWindow(options);
    assert.equal(sendToRenderer(window, "sync:event", {}), false);
    assert.deepEqual(sent, []);
  }
  assert.equal(sendToRenderer(null, "sync:event", {}), false);
});

test("does not hide non-lifecycle IPC errors", () => {
  const { window } = rendererWindow({ sendError: new Error("An object could not be cloned") });

  assert.throws(
    () => sendToRenderer(window, "agent:message", () => undefined),
    /could not be cloned/,
  );
});
