import assert from "node:assert/strict";
import test from "node:test";
import { appServerInitializeParams } from "../src/main/app-server.js";

test("opts into experimental App Server methods used by the desktop runtime", () => {
  assert.deepEqual(appServerInitializeParams(), {
    clientInfo: {
      name: "rhzycode_desktop",
      title: "RHZYCODE Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
});
