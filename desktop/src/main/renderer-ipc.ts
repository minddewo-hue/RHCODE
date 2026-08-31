import type { BrowserWindow } from "electron";

export function shouldRecoverRenderer(reason: string): boolean {
  return reason !== "clean-exit" && reason !== "killed";
}

/**
 * Sends an IPC event only while the window has an attached, fully loaded main frame.
 * Renderer events may race with reloads and window teardown, when WebContents itself
 * can still be alive even though its WebFrameMain has already been disposed.
 */
export function sendToRenderer(
  window: BrowserWindow | null,
  channel: string,
  ...args: unknown[]
): boolean {
  try {
    if (!window || window.isDestroyed()) return false;

    const contents = window.webContents;
    if (contents.isDestroyed() || contents.isLoadingMainFrame()) return false;

    const frame = contents.mainFrame;
    if (frame.isDestroyed() || frame.detached) return false;

    frame.send(channel, ...args);
    return true;
  } catch (error) {
    if (isRendererLifecycleError(error)) return false;
    throw error;
  }
}

function isRendererLifecycleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:frame|webcontents).*(?:disposed|destroyed)|object has been destroyed/i.test(message);
}
