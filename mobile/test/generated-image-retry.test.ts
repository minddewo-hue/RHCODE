import assert from "node:assert/strict";
import test from "node:test";
import { retryGeneratedImageDownload } from "../src/api/generated-image-retry";

test("retries a newly published generated image until the authenticated route is ready", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await retryGeneratedImageDownload(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("404 not ready");
      return "file:///cache/generated.png";
    },
    [0, 250, 750],
    async (milliseconds) => { waits.push(milliseconds); },
  );

  assert.equal(result, "file:///cache/generated.png");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [250, 750]);
});

test("returns the last image download error after retries are exhausted", async () => {
  let attempts = 0;
  await assert.rejects(
    retryGeneratedImageDownload(
      async () => {
        attempts += 1;
        throw new Error(`failure-${attempts}`);
      },
      [0, 1],
      async () => undefined,
    ),
    /failure-2/,
  );
});
