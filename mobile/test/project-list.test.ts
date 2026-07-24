import assert from "node:assert/strict";
import test from "node:test";
import { filterThreadsInOrder, groupThreadsByProject, isRegisteredProject, isSameProjectPath, registeredProjectPaths } from "../src/state/project-list";

test("shows only project directories still registered by the desktop", () => {
  const paths = registeredProjectPaths([
    "D:\\work\\active",
    " D:\\work\\active ",
    "d:/WORK/active/",
    "D:\\work\\second",
  ]);

  assert.deepEqual(paths, ["D:\\work\\active", "D:\\work\\second"]);
  assert.equal(isRegisteredProject("d:\\WORK\\ACTIVE", paths), true);
  assert.equal(isRegisteredProject("D:\\work\\removed", paths), false);
  assert.equal(isSameProjectPath("D:\\work\\active", "d:/WORK/active/"), true);
  assert.equal(isSameProjectPath("/Work/active", "/work/active"), false);
});

test("filters conversations without changing their project order", () => {
  const threads = [
    { id: "older", hostId: "desktop", title: "Keep first", projectPath: "D:\\work\\active", model: "test", status: "completed" as const, updatedAt: "2026-07-22T00:00:00.000Z" },
    { id: "newer", hostId: "desktop", title: "Keep second", projectPath: "D:\\work\\active", model: "test", status: "completed" as const, updatedAt: "2026-07-23T00:00:00.000Z" },
  ];

  assert.deepEqual(filterThreadsInOrder(threads, "keep").map((thread) => thread.id), ["older", "newer"]);

  const groups = groupThreadsByProject(
    ["D:\\work\\second", "D:\\work\\active", "D:\\work\\empty"],
    threads,
    "",
  );
  assert.deepEqual(groups.map((group) => ({
    path: group.path,
    threads: group.threads.map((thread) => thread.id),
  })), [
    { path: "D:\\work\\second", threads: [] },
    { path: "D:\\work\\active", threads: ["older", "newer"] },
    { path: "D:\\work\\empty", threads: [] },
  ]);
  assert.deepEqual(
    groupThreadsByProject(groups.map((group) => group.path), threads, "D:\\work\\second")
      .map((group) => group.path),
    ["D:\\work\\second"],
  );
});
