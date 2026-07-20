import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveRemoteAttachments } from "../src/main/remote-attachment-store";

test("stores validated mobile attachments under the managed directory", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-remote-attachments-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const [attachment] = saveRemoteAttachments(directory, [{
    name: "../notes.txt",
    kind: "file",
    size: 5,
    dataBase64: Buffer.from("hello").toString("base64"),
  }]);
  assert.equal(attachment.name, "notes.txt");
  assert.equal(fs.readFileSync(attachment.path, "utf8"), "hello");
  assert.equal(path.dirname(attachment.path), directory);
});

test("rejects the whole mobile attachment batch before writing invalid data", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-remote-attachments-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => saveRemoteAttachments(directory, [
    { name: "valid.txt", kind: "file", size: 2, dataBase64: "b2s=" },
    { name: "invalid.txt", kind: "file", size: 3, dataBase64: "bm8=" },
  ]), /size is invalid/);
  assert.deepEqual(fs.readdirSync(directory), []);
});
