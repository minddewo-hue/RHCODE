import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeGeneratedImage } from "../src/main/generated-image-store.js";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=";

test("stores generated image results with a deterministic local path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-generated-image-"));
  try {
    const first = materializeGeneratedImage(root, {
      id: "image/call:1",
      result: ONE_PIXEL_PNG,
    });
    const second = materializeGeneratedImage(root, {
      id: "image/call:1",
      result: `data:image/png;base64,${ONE_PIXEL_PNG}`,
    });

    assert.ok(first);
    assert.deepEqual(second, first);
    assert.equal(first.generated, true);
    assert.match(first.name, /^generated-image-call-1-[a-f0-9]{16}\.png$/);
    assert.deepEqual(fs.readFileSync(first.path), Buffer.from(ONE_PIXEL_PNG, "base64"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("imports valid saved image paths into managed storage and rejects non-image results", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-generated-image-"));
  try {
    const savedPath = path.join(root, "existing.png");
    fs.writeFileSync(savedPath, Buffer.from(ONE_PIXEL_PNG, "base64"));

    const imported = materializeGeneratedImage(root, { id: "saved-1", savedPath });
    assert.ok(imported);
    assert.notEqual(imported.path, savedPath);
    assert.match(imported.name, /^generated-saved-1-[a-f0-9]{16}\.png$/);
    assert.deepEqual(fs.readFileSync(imported.path), fs.readFileSync(savedPath));
    assert.equal(materializeGeneratedImage(root, { id: "bad", result: "not base64" }), null);
    assert.equal(materializeGeneratedImage(root, {
      id: "text",
      result: Buffer.from("not an image").toString("base64"),
    }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
