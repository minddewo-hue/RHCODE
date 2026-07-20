import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeStalePastedImages, savePastedImage } from "../src/main/pasted-image-store";

test("stores validated clipboard images under the managed temp directory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-paste-test-"));
  try {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const attachment = savePastedImage(directory, {
      name: "clipboard-capture",
      mimeType: "image/png",
      bytes,
    });

    assert.equal(attachment.kind, "image");
    assert.equal(attachment.name, "clipboard-capture.png");
    assert.equal(attachment.size, bytes.byteLength);
    assert.equal(path.dirname(attachment.path), directory);
    assert.deepEqual(fs.readFileSync(attachment.path), Buffer.from(bytes));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects empty and unsupported clipboard images", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-paste-test-"));
  try {
    assert.throws(() => savePastedImage(directory, {
      name: "empty.png",
      mimeType: "image/png",
      bytes: new Uint8Array(),
    }), /empty/i);
    assert.throws(() => savePastedImage(directory, {
      name: "vector.svg",
      mimeType: "image/svg+xml",
      bytes: new Uint8Array([1]),
    }), /unsupported/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("removes stale pasted images while keeping recent files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-paste-test-"));
  try {
    const stale = path.join(directory, "stale.png");
    const recent = path.join(directory, "recent.png");
    fs.writeFileSync(stale, "old");
    fs.writeFileSync(recent, "new");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(stale, oldTime, oldTime);

    removeStalePastedImages(directory, 5_000);

    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(recent), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
