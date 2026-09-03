import assert from "node:assert/strict";
import test from "node:test";
import {
  removeStoredLastThread,
  storedApprovalPolicy,
  storedCollapsedProjectPaths,
  storedForgottenProjects,
  storedLastProject,
  storedLastThread,
  storedReasoningEffort,
  storedRecentProjects,
  storedSandboxMode,
  storedSelectedModel,
  storedThemeMode,
  storedThemePreset,
  storeCollapsedProjectPaths,
  storeLastProject,
  storeLastThread,
  storeRecentProjects,
  storeSelectedModel,
} from "../src/renderer/src/renderer-preferences";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function withStorage(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

test("persists renderer preferences through typed defaults", () => {
  const storage = new MemoryStorage();
  withStorage(storage, () => {
    assert.equal(storedThemeMode(), "dark");
    assert.equal(storedThemePreset(), "forest");
    assert.equal(storedApprovalPolicy(), "on-request");
    assert.equal(storedSandboxMode(), "workspace-write");
    assert.equal(storedReasoningEffort(), "high");

    storeLastProject("D:\\work\\alpha");
    storeSelectedModel("provider/model");
    assert.equal(storedLastProject(), "D:\\work\\alpha");
    assert.equal(storedSelectedModel(), "provider/model");
    storeLastProject("");
    assert.equal(storedLastProject(), "");

    storage.setItem("rhzycode.themeMode", "invalid");
    storage.setItem("rhzycode.themePreset", "invalid");
    storage.setItem("rhzycode.reasoningEffort", "extreme");
    assert.equal(storedThemeMode(), "dark");
    assert.equal(storedThemePreset(), "forest");
    assert.equal(storedReasoningEffort(), "high");
  });
});

test("normalizes, bounds, and removes per-project last threads", () => {
  const storage = new MemoryStorage();
  withStorage(storage, () => {
    storeLastThread("D:\\Work\\Alpha", "thread-1");
    assert.equal(storedLastThread("d:/work/alpha/"), "thread-1");

    storeLastThread("d:/WORK/ALPHA/", "thread-2");
    assert.equal(storedLastThread("D:\\work\\alpha"), "thread-2");
    assert.equal(Object.keys(JSON.parse(storage.getItem("rhzycode.lastThreads")!)).length, 1);

    storeLastThread("\\\\SERVER\\Share\\Project", "thread-unc");
    assert.equal(storedLastThread("//server/share/project/"), "thread-unc");

    for (let index = 0; index < 51; index += 1) {
      storeLastThread(`D:\\projects\\${index}`, `thread-${index}`);
    }
    const stored = JSON.parse(storage.getItem("rhzycode.lastThreads")!) as Record<string, string>;
    assert.equal(Object.keys(stored).length, 50);
    assert.equal(storedLastThread("D:\\Work\\Alpha"), null);
    assert.equal(storedLastThread("d:/projects/50"), "thread-50");

    removeStoredLastThread("D:/PROJECTS/50/");
    assert.equal(storedLastThread("D:\\projects\\50"), null);

    storage.setItem("rhzycode.lastThreads", "not-json");
    removeStoredLastThread("D:\\projects\\1");
    assert.equal(storage.getItem("rhzycode.lastThreads"), null);
  });
});

test("deduplicates stored project lists and rejects damaged entries", () => {
  const storage = new MemoryStorage();
  withStorage(storage, () => {
    storeCollapsedProjectPaths(["D:\\work\\alpha", "d:/work/alpha/", "", "/work/beta"]);
    assert.deepEqual(storedCollapsedProjectPaths(), ["D:\\work\\alpha", "/work/beta"]);

    storeRecentProjects(Array.from({ length: 60 }, (_, index) => `/work/${index}`));
    assert.equal(storedRecentProjects().length, 50);

    storage.setItem("rhzycode.forgottenProjects", JSON.stringify(["D:\\work\\valid", null, 42]));
    assert.deepEqual(storedForgottenProjects(), ["D:\\work\\valid"]);
    storage.setItem("rhzycode.collapsedProjects", "not-json");
    assert.deepEqual(storedCollapsedProjectPaths(), []);
  });
});

test("keeps the renderer usable when web storage is unavailable", () => {
  const unavailable = {
    getItem: () => { throw new Error("storage disabled"); },
    setItem: () => { throw new Error("storage disabled"); },
    removeItem: () => { throw new Error("storage disabled"); },
  };
  withStorage(unavailable, () => {
    assert.equal(storedLastProject(), "");
    assert.equal(storedLastThread("D:\\work\\alpha"), null);
    assert.deepEqual(storedRecentProjects(), []);
    assert.doesNotThrow(() => {
      storeLastProject("D:\\work\\alpha");
      storeLastThread("D:\\work\\alpha", "thread-1");
      storeRecentProjects(["D:\\work\\alpha"]);
      removeStoredLastThread("D:\\work\\alpha");
    });
  });
});
