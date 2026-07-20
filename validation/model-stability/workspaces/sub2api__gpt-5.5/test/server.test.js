import assert from "node:assert/strict";
import test from "node:test";
import { createServer, resolveRequestPath } from "../src/server.js";

test("resolves only managed static paths", () => {
  assert.match(resolveRequestPath("/") || "", /public[\\/]index\.html$/);
  assert.match(resolveRequestPath("/src/analysis.js") || "", /src[\\/]analysis\.js$/);
  assert.equal(resolveRequestPath("/src/../../package.json"), null);
  assert.equal(resolveRequestPath("/%2e%2e/package.json"), null);
});

test("serves the application and rejects traversal", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /算力趋势研判台/);
    const script = await fetch(`${base}/app.js`);
    assert.equal(script.status, 200);
    const traversal = await fetch(`${base}/%2e%2e/%2e%2e/package.json`);
    assert.ok([403, 404].includes(traversal.status));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
