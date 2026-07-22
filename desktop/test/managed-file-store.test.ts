import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedFileStore, resolveArtifactPaths } from "../src/main/managed-file-store.js";

test("registers uploaded files without copying or persisting user data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-managed-files-"));
  try {
    const source = path.join(root, "source", "brief.txt");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "persistent attachment", "utf8");
    const store = new ManagedFileStore(path.join(root, "managed"));
    const [record] = store.registerUploads("thread-1", [{
      path: source,
      name: "brief.txt",
      kind: "file",
      size: fs.statSync(source).size,
    }]);
    assert.ok(record);
    store.bindTurn([record.id], "turn-1");
    assert.equal(record.path, source);
    assert.equal(store.read(record.id)?.bytes.toString("utf8"), "persistent attachment");
    assert.equal(fs.existsSync(path.join(root, "managed", "files")), false);
    assert.equal(new ManagedFileStore(path.join(root, "managed")).listThread("thread-1").length, 0);
    store.removeThread("thread-1");
    assert.equal(fs.existsSync(source), true);
    assert.equal(store.read(record.id), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collects supported document and image artifacts inside the active project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-artifact-paths-"));
  try {
    const report = path.join(root, "reports", "result.pdf");
    const source = path.join(root, "src", "app.ts");
    const image = path.join(root, "output", "sample.png");
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(report, "%PDF-test", "utf8");
    fs.writeFileSync(source, "export {};", "utf8");
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=", "base64"));
    const paths = resolveArtifactPaths(root, [
      "Created `[reports/result.pdf](reports/result.pdf)` and `src/app.ts`.",
      { path: "reports/result.pdf" },
      { path: path.join(root, "..", "outside.docx") },
      "Generated [sample.png](output/sample.png).",
    ]);
    assert.deepEqual(paths, [report, image]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
