import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalResponse,
  createApprovalRequest,
  isApprovalRequest,
} from "../src/main/approval-protocol";

test("accepts only approval methods from the current App Server protocol", () => {
  assert.equal(isApprovalRequest("item/commandExecution/requestApproval"), true);
  assert.equal(isApprovalRequest("item/fileChange/requestApproval"), true);
  assert.equal(isApprovalRequest("item/permissions/requestApproval"), true);
  assert.equal(isApprovalRequest("execCommandApproval"), false);
  assert.equal(isApprovalRequest("applyPatchApproval"), false);
});

test("builds current approval requests and response payloads", () => {
  const command = createApprovalRequest({
    rpcId: 7,
    method: "item/commandExecution/requestApproval",
    params: { itemId: "command-1" },
    threadId: "thread-1",
    turnId: "turn-1",
    itemDetails: new Map([["turn-1::command-1", "npm test"]]),
    createdAt: "2026-07-30T00:00:00.000Z",
  });
  assert.equal(command.approval.detail, "npm test");
  assert.deepEqual(approvalResponse(command.pending, "approved"), { decision: "accept" });

  const permissions = createApprovalRequest({
    rpcId: 8,
    method: "item/permissions/requestApproval",
    params: { permissions: { network: { enabled: true }, ignored: true } },
    threadId: "thread-1",
    turnId: "turn-1",
    itemDetails: new Map(),
  });
  assert.deepEqual(approvalResponse(permissions.pending, "approved"), {
    permissions: { network: { enabled: true } },
    scope: "turn",
  });
  assert.deepEqual(approvalResponse(permissions.pending, "declined"), {
    permissions: {},
    scope: "turn",
  });
});
