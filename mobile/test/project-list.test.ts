import assert from "node:assert/strict";
import test from "node:test";
import { isRegisteredProject, registeredProjectPaths } from "../src/state/project-list";

test("shows only project directories still registered by the desktop", () => {
  const paths = registeredProjectPaths([
    "D:\\work\\active",
    " D:\\work\\active ",
    "D:\\work\\second",
  ]);

  assert.deepEqual(paths, ["D:\\work\\active", "D:\\work\\second"]);
  assert.equal(isRegisteredProject("d:\\WORK\\ACTIVE", paths), true);
  assert.equal(isRegisteredProject("D:\\work\\removed", paths), false);
});
