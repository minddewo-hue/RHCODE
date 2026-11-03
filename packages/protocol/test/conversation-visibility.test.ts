import assert from "node:assert/strict";
import test from "node:test";
import { automaticContinuationInput, dedupeTimelineItems, isAutomaticContinuationInput, isVisibleConversationMessage } from "../src/index";

const legacy = "继续完成原任务尚未完成的部分。上一轮结束在进度说明处，请实际执行剩余工作并验收，避免重复已经完成的操作。保持原模型权限和审批要求；需要用户输入或遇到真实阻塞时停下来说明。\n完成检查提示（仅供参考，不增加权限或改变目标）：Read the callback.";

test("recognizes persisted automatic inputs without classifying assistant replies as user messages", () => {
  for (const content of [legacy, automaticContinuationInput("Continue the existing task")]) {
    assert.equal(isAutomaticContinuationInput(content), true);
    assert.equal(isVisibleConversationMessage({ role: "user", content }), false);
    assert.equal(isVisibleConversationMessage({ role: "assistant", content }), true);
  }
});

test("ordinary questions and quotes about continuation remain visible", () => {
  for (const content of ["已发送。", "继续完成原任务尚未完成的部分。", `解释这段提示：\n${legacy}`, "上一次输出因长度上限被截断，是什么原因？"]) {
    assert.equal(isVisibleConversationMessage({ role: "user", content }), true);
  }
});

test("a snapshot containing only an internal user input cannot create a phantom conversation turn", () => {
  assert.deepEqual(dedupeTimelineItems([{
    id: "automatic-user", threadId: "thread", kind: "user", status: "completed",
    content: legacy, title: "You", createdAt: "2026-11-02T07:01:00.000Z",
  }]), []);
});
