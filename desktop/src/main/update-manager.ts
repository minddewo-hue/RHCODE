import { EventEmitter } from "node:events";
import {
  compareVersions,
  parseUpdateForPlatform,
  type DesktopUpdate,
  type DesktopUpdatePlatform,
} from "@rhzycode/update-contract";

export { compareVersions } from "@rhzycode/update-contract";

export const DESKTOP_UPDATE_INTERVAL_MS = 2 * 60 * 60 * 1_000;
export const DEFAULT_UPDATE_MANIFEST_URL = "https://minio.gshbzw.com/wxfile/rhzycode/version.json";

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

interface UpdateManagerOptions {
  manifestUrl?: string;
  currentVersion?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  platform?: DesktopUpdatePlatform;
}

export class UpdateManager extends EventEmitter {
  private status: UpdateStatus;
  private initialCheck: NodeJS.Timeout | null = null;
  private periodicCheck: NodeJS.Timeout | null = null;

  constructor(
    private readonly adapter: UpdateAdapter,
    enabled: boolean,
    private readonly options: UpdateManagerOptions = {},
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
    if (!options.platform) throw new Error("An enabled desktop updater requires a supported platform.");
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
      const latest = await fetchDesktopUpdate({
        manifestUrl: this.options.manifestUrl,
        fetchImpl: this.options.fetchImpl,
        timeoutMs: this.options.timeoutMs,
        platform: this.options.platform!,
      });
      if (compareVersions(latest.version, this.options.currentVersion || "0.0.0") <= 0) {
        this.setStatus({ state: "not_available", version: latest.version, percent: null, error: null });
        return this.getStatus();
      }
      this.adapter.setFeedURL?.({ provider: "generic", url: latest.feedUrl });
      this.adapter.forceDevUpdateConfig = true;
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

export async function fetchDesktopUpdate(options: {
  manifestUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  platform: DesktopUpdatePlatform;
}): Promise<DesktopUpdate> {
  const manifestUrl = options.manifestUrl || DEFAULT_UPDATE_MANIFEST_URL;
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 8_000);
  try {
    const url = new URL(manifestUrl);
    url.searchParams.set("_", String(Date.now()));
    const response = await fetchImpl(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Update service returned HTTP ${response.status}.`);
    return parseUpdateForPlatform(await response.json(), options.platform);
  } finally {
    clearTimeout(timeout);
  }
}
