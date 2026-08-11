export interface StartupDialogWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  moveTop(): void;
  setAlwaysOnTop(flag: boolean): void;
}

export async function showStartupDialog<T>(
  window: StartupDialogWindow,
  showDialog: () => Promise<T>,
  platform: NodeJS.Platform = process.platform,
): Promise<T> {
  const elevate = platform === "linux" && !window.isDestroyed();
  if (elevate) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.setAlwaysOnTop(true);
    window.moveTop();
    window.focus();
  }

  try {
    return await showDialog();
  } finally {
    if (elevate && !window.isDestroyed()) {
      window.setAlwaysOnTop(false);
      window.moveTop();
      window.focus();
    }
  }
}
