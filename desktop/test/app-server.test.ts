import assert from "node:assert/strict";
import test from "node:test";
import { appServerConfigOverrides, appServerInitializeParams } from "../src/main/app-server.js";

test("Linux keyring opt-out also covers Codex login and MCP credentials", () => {
  const overrides = {
    model_provider: "rhzy_gateway",
    cli_auth_credentials_store: "keyring",
    mcp_oauth_credentials_store: "auto",
  };
  assert.deepEqual(appServerConfigOverrides(overrides, "linux", "1"), {
    model_provider: "rhzy_gateway",
    cli_auth_credentials_store: "file",
    mcp_oauth_credentials_store: "file",
  });
  assert.equal(overrides.cli_auth_credentials_store, "keyring");
  assert.equal(overrides.mcp_oauth_credentials_store, "auto");
});

test("preserves credential storage unless Linux explicitly opts out of keyring", () => {
  const overrides = { mcp_oauth_credentials_store: "keyring" };
  for (const flag of ["", "0", "true"]) {
    assert.deepEqual(appServerConfigOverrides(overrides, "linux", flag), overrides);
    assert.deepEqual(appServerConfigOverrides({}, "linux", flag), {});
  }
  for (const platform of ["win32", "darwin"] as const) {
    assert.deepEqual(appServerConfigOverrides(overrides, platform, "1"), overrides);
  }
});

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
