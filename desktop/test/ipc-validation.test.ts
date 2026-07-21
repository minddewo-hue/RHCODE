import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  validateApprovalResolution,
  validateClipboardText,
  validateCredentialUpdate,
  validateIdentifier,
  validateStartThread,
  validateStartTurn,
  validateSyncPort,
  validateTerminalResize,
  validateTerminalStart,
  validateTerminalWrite,
  validateThreadListOptions,
  validateThreadRename,
  validateUserInputResolution,
} from "../src/main/ipc-validation.js";

const projectPath = path.resolve("fixtures", "project");

test("validates and normalizes thread requests", () => {
  assert.deepEqual(validateThreadListOptions(undefined), {});
  assert.deepEqual(
    validateThreadListOptions({ cwd: projectPath, searchTerm: "release", archived: true }),
    { cwd: projectPath, searchTerm: "release", archived: true },
  );
  assert.deepEqual(validateStartThread({
    cwd: projectPath,
    model: "sub2api/gpt-5.5",
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
  }), {
    cwd: projectPath,
    model: "sub2api/gpt-5.5",
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
  });
  assert.deepEqual(validateThreadRename(" thread-1 ", "Release fixes"), {
    threadId: "thread-1",
    name: "Release fixes",
  });
});

test("rejects malformed thread requests before they reach the runtime", () => {
  assert.throws(
    () => validateThreadListOptions({ cwd: projectPath, cursor: "untrusted" }),
    /contains unsupported fields/,
  );
  assert.throws(() => validateStartThread({ cwd: "." }), /cwd must be an absolute path/);
  assert.throws(
    () => validateStartThread({ cwd: projectPath, sandboxMode: "host-write" }),
    /sandboxMode is unsupported/,
  );
  assert.throws(() => validateIdentifier("  ", "threadId"), /threadId must not be empty/);
  assert.throws(() => validateThreadRename("thread-1", " "), /name must not be blank/);
});

test("validates turn content, policies, and attachment metadata", () => {
  const imagePath = path.resolve("fixtures", "screen.png");
  assert.deepEqual(validateStartTurn({
    threadId: "thread-1",
    text: "Inspect this image",
    model: "faker/kimi-for-coding",
    approvalPolicy: "never",
    sandboxMode: "read-only",
    reasoningEffort: "xhigh",
    attachments: [{ path: imagePath, name: "screen.png", kind: "image", size: 12 }],
  }), {
    threadId: "thread-1",
    text: "Inspect this image",
    model: "faker/kimi-for-coding",
    approvalPolicy: "never",
    sandboxMode: "read-only",
    reasoningEffort: "xhigh",
    attachments: [{ path: imagePath, name: "screen.png", kind: "image", size: 12 }],
  });

  assert.throws(
    () => validateStartTurn({ threadId: "thread-1", text: "" }),
    /requires text or an attachment/,
  );
  assert.throws(
    () => validateStartTurn({ threadId: "thread-1", text: "Inspect", model: " " }),
    /model must not be blank/,
  );
  assert.throws(
    () => validateStartTurn({ threadId: "thread-1", text: "Inspect", reasoningEffort: "extreme" }),
    /reasoningEffort is unsupported/,
  );
  assert.throws(
    () => validateStartTurn({
      threadId: "thread-1",
      text: "Inspect",
      attachments: [{ path: "relative.png", name: "screen.png", kind: "image", size: 12 }],
    }),
    /attachments\[0\]\.path must be an absolute path/,
  );
  assert.throws(
    () => validateStartTurn({
      threadId: "thread-1",
      text: "Inspect",
      attachments: Array.from({ length: 21 }, () => ({
        path: imagePath,
        name: "screen.png",
        kind: "image",
        size: 12,
      })),
    }),
    /attachments can contain at most 20 items/,
  );
});

test("validates credentials, clipboard, approvals, and user answers", () => {
  assert.equal(validateClipboardText("192.168.1.25"), "192.168.1.25");
  assert.equal(validateSyncPort(8790), 8790);
  assert.equal(validateSyncPort(65_535), 65_535);
  assert.throws(() => validateSyncPort(0), /between 1 and 65535/);
  assert.throws(() => validateSyncPort("8790"), /between 1 and 65535/);
  assert.deepEqual(validateCredentialUpdate("faker", "secret-value"), {
    providerId: "faker",
    apiKey: "secret-value",
  });
  assert.deepEqual(validateApprovalResolution("approval-1", "approved"), {
    id: "approval-1",
    decision: "approved",
  });
  assert.deepEqual(validateUserInputResolution("request-1", {
    mode: ["fast"],
    token: ["temporary-secret"],
  }), {
    id: "request-1",
    answers: { mode: ["fast"], token: ["temporary-secret"] },
  });

  assert.throws(
    () => validateClipboardText("x".repeat(4_097)),
    /clipboard text must not exceed 4096 characters/,
  );
  assert.throws(
    () => validateApprovalResolution("approval-1", "always"),
    /decision must be approved or declined/,
  );
  assert.throws(
    () => validateUserInputResolution("request-1", JSON.parse('{"__proto__":["value"]}')),
    /answers/,
  );
  assert.throws(
    () => validateCredentialUpdate("faker", "x".repeat(20_001)),
    (error: unknown) => {
      assert.match(String(error), /apiKey must not exceed 20000 characters/);
      assert.doesNotMatch(String(error), /xxx/);
      return true;
    },
  );
});

test("bounds terminal paths, dimensions, identifiers, and writes", () => {
  assert.deepEqual(validateTerminalStart({ cwd: projectPath, cols: 120, rows: 40 }), {
    cwd: projectPath,
    cols: 120,
    rows: 40,
  });
  assert.deepEqual(validateTerminalResize("process-1", 80, 24), {
    processId: "process-1",
    cols: 80,
    rows: 24,
  });
  assert.deepEqual(validateTerminalWrite("process-1", "dir\r"), {
    processId: "process-1",
    data: "dir\r",
  });

  assert.throws(() => validateTerminalStart({ cwd: "relative" }), /must be an absolute path/);
  assert.throws(() => validateTerminalResize("process-1", 501, 24), /cols must be an integer/);
  assert.throws(() => validateTerminalResize("process-1", 80, 0), /rows must be an integer/);
  assert.throws(
    () => validateTerminalWrite("process-1", "x".repeat(65_537)),
    /data must not exceed 65536 characters/,
  );
});
