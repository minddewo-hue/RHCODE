import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveGatewayEnvPath } from "../src/main/gateway-module";

test("resolves the source desktop environment outside model-gateway", () => {
  const desktopRoot = path.join(os.tmpdir(), "rhzycode-desktop");
  assert.equal(
    resolveGatewayEnvPath(path.join(desktopRoot, "model-gateway")),
    path.join(desktopRoot, ".env"),
  );
});

test("keeps packaged or external gateway environments inside their root", () => {
  const gatewayRoot = path.join(os.tmpdir(), "rhzycode-resources", "gateway");
  assert.equal(resolveGatewayEnvPath(gatewayRoot), path.join(gatewayRoot, ".env"));
});
