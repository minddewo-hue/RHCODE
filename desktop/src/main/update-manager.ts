import { EventEmitter } from "node:events";

export const DESKTOP_UPDATE_INTERVAL_MS = 2 * 60 * 60 * 1_000;

export function isDesktopUpdateWindow(date: Date): boolean {
  const hour = date.getHours();
  return hour >= 10 && hour < 20;
}

export type UpdateState =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "not_available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateStatus {
  enabled: boolean;
  state: UpdateState;
  version: string | null;
  percent: number | null;
  error: string | null;
}

export interface UpdateAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  forceDevUpdateConfig?: boolean;
  on(event: string, listener: (value?: unknown) => void): unknown;
  setFeedURL?(options: { provider: "generic"; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export class UpdateManager extends EventEmitter {
  private status: UpdateStatus;
  private initialCheck: NodeJS.Timeout | null = null;
  private periodicCheck: NodeJS.Timeout | null = null;

  constructor(
    private readonly adapter: UpdateAdapter,
    enabled: boolean,
    updateUrl?: string,
  ) {
    super();
    this.status = {
      enabled,
      state: enabled ? "idle" : "disabled",
      version: null,
      percent: null,
      error: null,
    };
    if (!enabled) return;
    if (updateUrl) {
      adapter.setFeedURL?.({ provider: "generic", url: updateUrl });
      adapter.forceDevUpdateConfig = true;
    }
    adapter.autoDownload = false;
    adapter.autoInstallOnAppQuit = true;
    this.bindEvents();
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  start(): void {
    if (!this.status.enabled || this.initialCheck || this.periodicCheck) return;
    this.initialCheck = setTimeout(() => {
      this.initialCheck = null;
      void this.check().catch(() => undefined);
    }, 10_000);
    this.initialCheck.unref();
    this.periodicCheck = setInterval(() => {
      if (!isDesktopUpdateWindow(new Date())) return;
      void this.check().catch(() => undefined);
    }, DESKTOP_UPDATE_INTERVAL_MS);
    this.periodicCheck.unref();
  }

  async check(): Promise<UpdateStatus> {
    this.requireEnabled();
    this.setStatus({ state: "checking", percent: null, error: null });
    try {
      await this.adapter.checkForUpdates();
    } catch (error) {
      this.setError(error);
    }
    return this.getStatus();
  }

  async download(): Promise<UpdateStatus> {
    this.requireEnabled();
    if (this.status.state !== "available" && this.status.state !== "error") {
      throw new Error("No update is available to download.");
    }
    this.setStatus({ state: "downloading", percent: 0, error: null });
    try {
      await this.adapter.downloadUpdate();
    } catch (error) {
      this.setError(error);
    }
    return this.getStatus();
  }

  install(): void {
    this.requireEnabled();
    if (this.status.state !== "downloaded") throw new Error("No downloaded update is ready.");
    this.adapter.quitAndInstall();
  }

  private bindEvents(): void {
    this.adapter.on("checking-for-update", () => this.setStatus({ state: "checking", error: null }));
    this.adapter.on("update-available", (value) => {
      const info = (value || {}) as { version?: unknown };
      this.setStatus({ state: "available", version: String(info.version || "") || null, error: null });
    });
    this.adapter.on("update-not-available", (value) => {
      const info = (value || {}) as { version?: unknown };
      this.setStatus({ state: "not_available", version: String(info.version || "") || null, percent: null, error: null });
    });
    this.adapter.on("download-progress", (value) => {
      const progress = (value || {}) as { percent?: unknown };
      const percent = Number(progress.percent);
      this.setStatus({ state: "downloading", percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0 });
    });
    this.adapter.on("update-downloaded", (value) => {
      const info = (value || {}) as { version?: unknown };
      this.setStatus({ state: "downloaded", version: String(info.version || this.status.version || "") || null, percent: 100, error: null });
    });
    this.adapter.on("error", (value) => this.setError(value));
  }

  private setError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error || "Update failed");
    this.setStatus({ state: "error", error: message.slice(0, 500) });
  }

  private setStatus(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.getStatus());
  }

  private requireEnabled(): void {
    if (!this.status.enabled) throw new Error("Automatic updates are not configured for this build.");
  }
}
