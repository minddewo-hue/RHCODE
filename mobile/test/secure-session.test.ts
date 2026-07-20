import assert from "node:assert/strict";
import test from "node:test";
import {
  SecureSessionStore,
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
  const first = await sessions.saveConnection({ host: "192.168.11.103", port: 8790, accessKey: firstKey });
  const firstId = first.activeConnectionId!;
  const second = await sessions.saveConnection({ host: "192.168.11.104", port: 8791, accessKey: secondKey });
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

test("updates an existing endpoint instead of duplicating it", async () => {
  const storage = new MemoryStorage();
  const sessions = new SecureSessionStore(storage);
  await sessions.saveConnection({ host: "192.168.11.103", port: 8790, accessKey: `rhzy_${"A".repeat(43)}` });
  const updated = await sessions.saveConnection({ host: "192.168.11.103", port: 8790, accessKey: `rhzy_${"B".repeat(43)}` });
  assert.equal(updated.connections.length, 1);
  assert.equal(updated.connections[0]?.accessKey, `rhzy_${"B".repeat(43)}`);
});

test("clears or removes only the selected computer", async () => {
  const storage = new MemoryStorage();
  const sessions = new SecureSessionStore(storage);
  const first = await sessions.saveConnection({ host: "192.168.11.103", port: 8790, accessKey: `rhzy_${"A".repeat(43)}` });
  const firstId = first.activeConnectionId!;
  const second = await sessions.saveConnection({ host: "192.168.11.104", port: 8790, accessKey: `rhzy_${"B".repeat(43)}` });
  const secondId = second.activeConnectionId!;

  const cleared = await sessions.clearAccessKey(firstId);
  assert.equal(cleared.connections.find((item) => item.id === firstId)?.accessKey, "");
  assert.equal(cleared.connections.find((item) => item.id === secondId)?.accessKey.length, 48);

  const removed = await sessions.removeConnection(secondId);
  assert.deepEqual(removed.connections.map((item) => item.id), [firstId]);
  assert.equal(removed.activeConnectionId, firstId);
  assert.equal(storage.values.has(secureConnectionKey(secondId)), false);
});

test("migrates the legacy single-computer session", async () => {
  const storage = new MemoryStorage();
  const key = `rhzy_${"A".repeat(43)}`;
  storage.values.set(secureSessionKeys.legacyHost, "192.168.11.103");
  storage.values.set(secureSessionKeys.legacyPort, "not-a-port");
  storage.values.set(secureSessionKeys.legacyAccessKey, key);

  const migrated = await new SecureSessionStore(storage).load("192.168.1.2", 9000);
  assert.equal(migrated.connections.length, 1);
  assert.equal(migrated.connections[0]?.host, "192.168.11.103");
  assert.equal(migrated.connections[0]?.port, 9000);
  assert.equal(migrated.connections[0]?.accessKey, key);
  assert.equal(storage.values.has(secureSessionKeys.legacyAccessKey), false);
});
