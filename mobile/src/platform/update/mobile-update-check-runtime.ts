import type { MobileUpdate, MobileUpdateStatus } from "./mobile-update";

type CheckResult = Extract<MobileUpdateStatus, { state: "available" | "current" }>;
type Timer = ReturnType<typeof setTimeout>;

export const initialUpdateCheckDelayMs = 1_000;
export const foregroundUpdateCheckDelayMs = 500;
export const updateCheckRetryDelaysMs = [5_000, 15_000, 30_000] as const;

interface UpdateCheckOptions {
  load: () => Promise<CheckResult>;
  readAppState: () => string | null;
  canCheck: () => boolean;
  onChecking: () => void;
  onResult: (result: CheckResult) => void;
  onError: (error: unknown) => void;
  onAvailable: (update: MobileUpdate) => void;
  onCurrent: () => void;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  cancel?: (timer: Timer) => void;
}

export interface MobileUpdateCheckRuntime {
  check: (automatic: boolean) => Promise<void>;
  appStateChanged: (next: string) => void;
  dispose: () => void;
}

/** Update checks follow app visibility independently of desktop connections. */
export function createMobileUpdateCheckRuntime(options: UpdateCheckOptions): MobileUpdateCheckRuntime {
  const schedule = options.schedule || ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.cancel || clearTimeout;
  let appState = options.readAppState();
  let timer: Timer | null = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  let hasChecked = false;
  let needsForegroundCheck = appState !== "active";
  let needsRetry = false;
  let retryAttempt = 0;
  let manualRequested = false;
  let latest: CheckResult | null = null;
  const announced = new Set<string>();

  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function announce(automatic: boolean) {
    if (disposed || appState !== "active" || !options.canCheck() || latest?.state !== "available") return;
    const update = latest.latest;
    const key = update.platform === "android"
      ? `android:${update.versionCode}:${update.sha256}`
      : `ios:${update.version}:${update.buildNumber}`;
    if (automatic && announced.has(key)) return;
    announced.add(key);
    options.onAvailable(update);
  }

  function scheduleCheck(delayMs: number) {
    clearTimer();
    if (disposed || appState !== "active" || !options.canCheck()) return;
    timer = schedule(() => {
      timer = null;
      void check(true);
    }, delayMs);
  }

  function check(automatic: boolean): Promise<void> {
    if (disposed || !options.canCheck() || (automatic && appState !== "active")) return Promise.resolve();
    if (inFlight) {
      if (!automatic) manualRequested = true;
      return inFlight;
    }
    clearTimer();
    needsForegroundCheck = false;
    manualRequested = !automatic;
    options.onChecking();
    inFlight = (async () => {
      try {
        const result = await Promise.resolve().then(options.load);
        if (disposed) return;
        latest = result;
        hasChecked = true;
        needsRetry = false;
        retryAttempt = 0;
        // A download or system installer may have started during this request.
        if (!options.canCheck()) return;
        options.onResult(result);
        if (result.state === "available") announce(!manualRequested);
        else if (manualRequested && appState === "active") options.onCurrent();
      } catch (error) {
        if (disposed) return;
        needsRetry = true;
        if (options.canCheck()) options.onError(error);
        const delay = updateCheckRetryDelaysMs[retryAttempt++];
        if (delay !== undefined) scheduleCheck(delay);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  scheduleCheck(initialUpdateCheckDelayMs);
  return {
    check,
    appStateChanged(next) {
      if (disposed) return;
      const previous = appState;
      appState = next;
      if (next !== "active") {
        if (next === "background") needsForegroundCheck = true;
        clearTimer();
        return;
      }
      // A successful background response must not consume the popup before the
      // user returns. Transient inactive/active events from alerts need no fetch.
      announce(true);
      if (previous !== next && (needsForegroundCheck || !hasChecked || needsRetry)) {
        retryAttempt = 0;
        scheduleCheck(foregroundUpdateCheckDelayMs);
      }
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
