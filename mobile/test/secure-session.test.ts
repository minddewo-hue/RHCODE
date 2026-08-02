import assert from "node:assert/strict";
import test from "node:test";
import {
  SecureSessionStore,
  mobileNavigationKey,
  secureConnectionKey,
  secureSessionKeys,
  type SecureStorageAdapter,
} from "../src/storage/secure-session";

class MemoryStorage implements SecureStorageAdapter {
  readonly values = new Map<string, string>();

  async getItemAsync(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItemAsync(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async deleteItemAsync(key: string): Promise<void> {
    this.values.delete(key);
  }
}

test("starts without a configured computer", async () => {
  const sessions = new SecureSessionStore(new MemoryStorage());
  assert.deepEqual(await sessions.load(), {
    connections: [],
    activeConnectionId: null,
  });
});

test("saves multiple computers with separate secure KEY values", async () => {
  const storage = new MemoryStorage();
  const sessions = new SecureSessionStore(storage);
  const firstKey = `rhzy_${"A".repeat(43)}`;
  const secondKey = `rhzy_${"B".repeat(43)}`;
  const first = await sessions.saveConnection({ accessKey: firstKey });
  const firstId = first.activeConnectionId!;
  const second = await sessions.saveConnection({ accessKey: secondKey });
  const secondId = second.activeConnectionId!;

  assert.equal(firstId === secondId, false);
  assert.equal(storage.values.get(secureConnectionKey(firstId)), firstKey);
  assert.equal(storage.values.get(secureConnectionKey(secondId)), secondKey);
  assert.equal(storage.values.get(secureSessionKeys.connections)?.includes(firstKey), false);
  assert.equal(storage.values.get(secureSessionKeys.connections)?.includes(secondKey), false);
  assert.deepEqual(await sessions.load(), second);

  await sessions.setActiveConnection(firstId);
  assert.equal((await sessions.load()).activeConnectionId, firstId);
});

test("keeps multiple KEY-only computers on the shared transfer endpoint", async () => {
  const storage = new MemoryStorage();
  const sessions = new SecureSessionStore(storage);
  const firstKey = `rhzy_${"A".repeat(43)}`;
  const secondKey = `rhzy_${"B".repeat(43)}`;
  await sessions.saveConnection({ accessKey: firstKey });
  const saved = await sessions.saveConnection({ accessKey: secondKey });
  assert.equal(saved.connections.length, 2);
  assert.deepEqual(saved.connections.map((connection) => connection.accessKey), [firstKey, secondKey]);
});

test("updates an existing computer by id instead of duplicating it", async () => {
  const storage = new MemoryStorage();
  const sessions = new SecureSessionStore(storage);
  const original = await sessions.saveConnection({ accessKey: `rhzy_${"A".repeat(43)}` });
  const updated = await sessions.saveConnection({
    id: original.activeConnectionId!,
    accessKey: `rhzy_${"B".repeat(43)}`,
  });
  assert.equal(updated.connections.length, 1);
  assert.equal(updated.connections[0]?.accessKey, `rhzy_${"B".repeat(43)}`);
});

test("persists the last project and thread separately for each computer", async () => {
  const storage = new MemoryStorage();
  const sessions = new SecureSessionStore(storage);
  await sessions.saveNavigation("computer-1", {
    projectPath: "D:\\work\\first",
    threadId: "thread-first",
    newThreadDraft: false,
    collapsedProjectPaths: ["D:\\work\\first", "D:\\work\\shared"],
  });
  await sessions.saveNavigation("computer-2", {
    projectPath: "D:\\work\\second",
    threadId: null,
    newThreadDraft: true,
    collapsedProjectPaths: ["D:\\work\\second"],
  });

  const restored = new SecureSessionStore(storage);
  assert.deepEqual(await restored.loadNavigation("computer-1"), {
    projectPath: "D:\\work\\first",
    threadId: "thread-first",
    newThreadDraft: false,
    collapsedProjectPaths: ["D:\\work\\first", "D:\\work\\shared"],
  });
  assert.deepEqual(await restored.loadNavigation("computer-2"), {
    projectPath: "D:\\work\\second",
    threadId: null,
    newThreadDraft: true,
    collapsedProjectPaths: ["D:\\work\\second"],
  });
});

test("loads older navigation and filters malformed collapsed project paths", async () => {
  const storage = new MemoryStorage();
  storage.values.set(mobileNavigationKey("computer-old"), JSON.stringify({
    projectPath: "D:\\work\\old",
    threadId: null,
    newThreadDraft: false,
  }));
  storage.values.set(mobileNavigationKey("computer-malformed"), JSON.stringify({
    collapsedProjectPaths: ["D:\\work\\valid", "", null, 42, "D:\\work\\valid"],
  }));
  const sessions = new SecureSessionStore(storage);

  assert.deepEqual((await sessions.loadNavigation("computer-old")).collapsedProjectPaths, []);
  assert.deepEqual((await sessions.loadNavigation("computer-malformed")).collapsedProjectPaths, ["D:\\work\\valid"]);
});

test("clears or removes only the selected computer", async () => {
  const storage = new MemoryStorage();
  const sessions = new SecureSessionStore(storage);
  const first = await sessions.saveConnection({ accessKey: `rhzy_${"A".repeat(43)}` });
  const firstId = first.activeConnectionId!;
  const second = await sessions.saveConnection({ accessKey: `rhzy_${"B".repeat(43)}` });
  const secondId = second.activeConnectionId!;
  await sessions.saveNavigation(secondId, {
    projectPath: "D:\\work",
    threadId: "thread-2",
    newThreadDraft: false,
    collapsedProjectPaths: ["D:\\work"],
  });

  const cleared = await sessions.clearAccessKey(firstId);
  assert.equal(cleared.connections.find((item) => item.id === firstId)?.accessKey, "");
  assert.equal(cleared.connections.find((item) => item.id === secondId)?.accessKey.length, 48);

  const removed = await sessions.removeConnection(secondId);
  assert.deepEqual(removed.connections.map((item) => item.id), [firstId]);
  assert.equal(removed.activeConnectionId, firstId);
  assert.equal(storage.values.has(secureConnectionKey(secondId)), false);
  assert.equal(storage.values.has(mobileNavigationKey(secondId)), false);
});

test("rejects connection metadata from obsolete direct-endpoint versions", async () => {
  const storage = new MemoryStorage();
  const firstKey = `rhzy_${"A".repeat(43)}`;
  const secondKey = `rhzy_${"B".repeat(43)}`;
  storage.values.set(secureSessionKeys.connections, JSON.stringify([
    { id: "computer-1", host: "192.168.11.103", port: 8790 },
    { id: "computer-2", host: "192.168.11.104", port: 8791 },
  ]));
  storage.values.set(secureSessionKeys.activeConnectionId, "computer-2");
  storage.values.set(secureConnectionKey("computer-1"), firstKey);
  storage.values.set(secureConnectionKey("computer-2"), secondKey);

  assert.deepEqual(await new SecureSessionStore(storage).load(), {
    connections: [],
    activeConnectionId: null,
  });
});
