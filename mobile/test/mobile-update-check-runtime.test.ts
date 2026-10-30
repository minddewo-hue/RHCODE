import assert from "node:assert/strict";
import test from "node:test";
import type { MobileUpdate, MobileUpdateStatus } from "../src/platform/update/mobile-update";
import {
  createMobileUpdateCheckRuntime,
  foregroundUpdateCheckDelayMs,
  initialUpdateCheckDelayMs,
  updateCheckRetryDelaysMs,
} from "../src/platform/update/mobile-update-check-runtime";

type Result = Extract<MobileUpdateStatus, { state: "available" | "current" }>;
type Timer = ReturnType<typeof setTimeout>;

function available(versionCode = 47): Result {
  return {
    state: "available", error: null,
    latest: {
      platform: "android", version: "0.1.47", versionCode,
      downloadUrl: "https://example.test/app.apk", bytes: 1234, sha256: "a".repeat(64),
      releaseNotes: "Test update",
    },
  };
}

function deferred() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function harness(initialAppState: string | null = "active") {
  let now = 0;
  let nextTimer = 0;
  let appState = initialAppState;
  let busy = false;
  let fetches = 0;
  let currentMessages = 0;
  let load = async (): Promise<Result> => available();
  const timers = new Map<Timer, { due: number; callback: () => void }>();
  const prompts: MobileUpdate[] = [];
  const states: string[] = [];
  const errors: unknown[] = [];
  const runtime = createMobileUpdateCheckRuntime({
    load: () => { fetches += 1; return load(); },
    readAppState: () => appState,
    canCheck: () => !busy,
    onChecking: () => states.push("checking"),
    onResult: (result) => states.push(result.state),
    onError: (error) => { errors.push(error); states.push("error"); },
    onAvailable: (update) => prompts.push(update),
    onCurrent: () => { currentMessages += 1; },
    schedule(callback, delayMs) {
      const timer = ++nextTimer as unknown as Timer;
      timers.set(timer, { due: now + delayMs, callback });
      return timer;
    },
    cancel: (timer) => { timers.delete(timer); },
  });
  return {
    runtime, prompts, states, errors,
    get fetches() { return fetches; },
    get currentMessages() { return currentMessages; },
    setLoad(next: () => Promise<Result>) { load = next; },
    setBusy(next: boolean) { busy = next; },
    changeAppState(next: string) { appState = next; runtime.appStateChanged(next); },
    async tick(ms: number) {
      const target = now + ms;
      for (;;) {
        const entry = [...timers].filter(([, task]) => task.due <= target)
          .sort((left, right) => left[1].due - right[1].due)[0];
        if (!entry) break;
        timers.delete(entry[0]);
        now = entry[1].due;
        entry[1].callback();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

test("automatically checks and prompts after a cold start without opening settings", async () => {
  const app = harness();
  await app.tick(initialUpdateCheckDelayMs - 1);
  assert.equal(app.fetches, 0);
  await app.tick(1);
  assert.equal(app.fetches, 1);
  assert.deepEqual(app.states, ["checking", "available"]);
  assert.equal(app.prompts.length, 1);
  app.runtime.dispose();
});

test("reopening from the background detects a release published after the initial check", async () => {
  const app = harness();
  app.setLoad(async () => ({ ...available(), state: "current" }));
  await app.tick(initialUpdateCheckDelayMs);
  assert.equal(app.prompts.length, 0);
  assert.equal(app.currentMessages, 0);
  app.changeAppState("background");
  app.setLoad(async () => available());
  app.changeAppState("active");
  await app.tick(foregroundUpdateCheckDelayMs);
  assert.equal(app.fetches, 2);
  assert.equal(app.prompts.length, 1);
  app.runtime.dispose();
});

test("startup network failure retries automatically instead of requiring a manual check", async () => {
  const app = harness();
  app.setLoad(async () => { throw new Error("network unavailable"); });
  await app.tick(initialUpdateCheckDelayMs);
  assert.equal(app.errors.length, 1);
  app.setLoad(async () => available());
  await app.tick(updateCheckRetryDelaysMs[0]);
  assert.equal(app.fetches, 2);
  assert.equal(app.prompts.length, 1);
  app.runtime.dispose();
});

test("synchronous request errors release the in-flight check before retrying", async () => {
  const app = harness();
  app.setLoad(() => { throw new Error("request setup failed"); });
  await app.tick(initialUpdateCheckDelayMs);
  assert.equal(app.errors.length, 1);
  app.setLoad(async () => available());
  await app.tick(updateCheckRetryDelaysMs[0]);
  assert.equal(app.fetches, 2);
  assert.equal(app.prompts.length, 1);
  app.runtime.dispose();
});

test("background-to-inactive-to-active transitions still check when reopening", async () => {
  const app = harness();
  app.setLoad(async () => ({ ...available(), state: "current" }));
  await app.tick(initialUpdateCheckDelayMs);
  app.changeAppState("background");
  app.changeAppState("inactive");
  app.setLoad(async () => available());
  app.changeAppState("active");
  await app.tick(foregroundUpdateCheckDelayMs);
  assert.equal(app.fetches, 2);
  assert.equal(app.prompts.length, 1);
  app.runtime.dispose();
});

test("retries are bounded and another foreground entry can recover after exhaustion", async () => {
  const app = harness();
  app.setLoad(async () => { throw new Error("offline"); });
  await app.tick(initialUpdateCheckDelayMs);
  for (const delay of updateCheckRetryDelaysMs) await app.tick(delay);
  await app.tick(120_000);
  assert.equal(app.fetches, 4);
  app.changeAppState("background");
  app.setLoad(async () => available());
  app.changeAppState("active");
  await app.tick(foregroundUpdateCheckDelayMs);
  assert.equal(app.fetches, 5);
  assert.equal(app.prompts.length, 1);
  app.runtime.dispose();
});

test("a response arriving in the background waits to show its popup until the user returns", async () => {
  const app = harness();
  const response = deferred();
  app.setLoad(() => response.promise);
  await app.tick(initialUpdateCheckDelayMs);
  app.changeAppState("background");
  response.resolve(available());
  await settle();
  assert.equal(app.prompts.length, 0);
  app.changeAppState("active");
  assert.equal(app.prompts.length, 1);
  await app.tick(foregroundUpdateCheckDelayMs);
  assert.equal(app.prompts.length, 1);
  app.changeAppState("inactive");
  app.changeAppState("active");
  await app.tick(5_000);
  assert.equal(app.fetches, 2, "alert focus changes must not trigger another check");
  assert.equal(app.prompts.length, 1);
  app.runtime.dispose();
});

test("a launch with unknown or background app state checks when it becomes active", async () => {
  for (const state of [null, "background"]) {
    const app = harness(state);
    await app.tick(10_000);
    assert.equal(app.fetches, 0);
    app.changeAppState("active");
    await app.tick(foregroundUpdateCheckDelayMs);
    assert.equal(app.fetches, 1);
    assert.equal(app.prompts.length, 1);
    app.runtime.dispose();
  }
});

test("manual and automatic checks share a request while preserving manual feedback", async () => {
  const app = harness();
  const response = deferred();
  app.setLoad(() => response.promise);
  const first = app.runtime.check(true);
  const manual = app.runtime.check(false);
  assert.equal(first, manual);
  await settle();
  assert.equal(app.fetches, 1);
  response.resolve({ ...available(), state: "current" });
  await manual;
  assert.equal(app.currentMessages, 1);
  await app.tick(initialUpdateCheckDelayMs);
  assert.equal(app.fetches, 1);
  app.runtime.dispose();
});

test("a newer Android build still prompts when its visible version is unchanged", async () => {
  const app = harness();
  await app.tick(initialUpdateCheckDelayMs);
  app.changeAppState("background");
  app.setLoad(async () => available(48));
  app.changeAppState("active");
  await app.tick(foregroundUpdateCheckDelayMs);
  assert.equal(app.prompts.length, 2);
  app.runtime.dispose();
});

test("automatic checks do not interrupt downloads or overwrite installation status", async () => {
  const app = harness();
  const response = deferred();
  app.setLoad(() => response.promise);
  await app.tick(initialUpdateCheckDelayMs);
  app.setBusy(true);
  response.resolve(available());
  await settle();
  assert.deepEqual(app.states, ["checking"]);
  assert.equal(app.prompts.length, 0);
  app.changeAppState("background");
  app.changeAppState("active");
  await app.tick(10_000);
  await app.runtime.check(false);
  assert.equal(app.fetches, 1);
  app.runtime.dispose();
});

test("cleanup cancels startup work and ignores requests that finish after unmount", async () => {
  const startup = harness();
  startup.runtime.dispose();
  await startup.tick(30_000);
  assert.equal(startup.fetches, 0);
  const app = harness();
  const response = deferred();
  app.setLoad(() => response.promise);
  await app.tick(initialUpdateCheckDelayMs);
  app.runtime.dispose();
  response.resolve(available());
  await settle();
  assert.deepEqual(app.states, ["checking"]);
  assert.equal(app.prompts.length, 0);
});
