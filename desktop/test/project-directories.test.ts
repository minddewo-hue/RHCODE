import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ProjectDirectoryError,
  ProjectDirectoryRegistry,
  normalizeProjectDirectoryState,
} from "../src/main/project-directories.js";

test("remembers, persists, and forgets existing desktop project directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-projects-"));
  const saved: unknown[] = [];
  const registry = new ProjectDirectoryRegistry(null, (state) => saved.push(state));
  const target = path.join(root, "mobile-project");
  fs.mkdirSync(target);

  const opened = registry.remember(target);
  assert.equal(opened.path, target);
  assert.equal(fs.statSync(target).isDirectory(), true);
  assert.deepEqual(registry.list(), [{ path: target, name: "mobile-project" }]);

  registry.remember(target);
  assert.equal(saved.length, 1);

  const restored = new ProjectDirectoryRegistry(registry.exportState());
  assert.deepEqual(restored.list(), registry.list());
  registry.forget(target);
  assert.deepEqual(registry.list(), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("rejects relative paths, roots, missing paths, and files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-project-errors-"));
  const file = path.join(root, "file.txt");
  fs.writeFileSync(file, "test", "utf8");
  const registry = new ProjectDirectoryRegistry();

  assert.throws(() => registry.remember("relative-project"), (error) => (
    error instanceof ProjectDirectoryError && error.code === "invalid"
  ));
  assert.throws(() => registry.remember(path.parse(root).root), (error) => (
    error instanceof ProjectDirectoryError && error.code === "invalid"
  ));
  assert.throws(() => registry.remember(path.join(root, "missing")), (error) => (
    error instanceof ProjectDirectoryError && error.code === "not_found"
  ));
  assert.throws(() => registry.remember(file), (error) => (
    error instanceof ProjectDirectoryError && error.code === "conflict"
  ));
  assert.deepEqual(normalizeProjectDirectoryState({ paths: [root, 42] }), { paths: [root] });
  fs.rmSync(root, { recursive: true, force: true });
});

test("creates a missing desktop directory and registers it once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-project-create-"));
  const target = path.join(root, "parent", "mobile-created");
  const registry = new ProjectDirectoryRegistry();

  const first = registry.create(target);
  assert.equal(first.created, true);
  assert.equal(first.project.path, target);
  assert.equal(fs.statSync(target).isDirectory(), true);

  const second = registry.create(target);
  assert.equal(second.created, false);
  assert.deepEqual(registry.list(), [{ path: target, name: "mobile-created" }]);
  fs.rmSync(root, { recursive: true, force: true });
});
