import assert from "node:assert/strict";
import test from "node:test";
import { ControlStore } from "../src/main/control-plane/store";

test("publishes and restores authoritative desktop project directories", () => {
  const store = new ControlStore();
  const project = { path: "D:\\work\\active", name: "active" };

  const added = store.setProjects([project]);
  assert.equal(added.type, "projects.updated");
  assert.deepEqual(store.snapshot().projects, [project]);

  const restored = new ControlStore(store.exportState());
  assert.deepEqual(restored.snapshot().projects, [project]);

  const removed = restored.setProjects([]);
  assert.equal(removed.type, "projects.updated");
  assert.deepEqual(restored.snapshot().projects, []);
});
