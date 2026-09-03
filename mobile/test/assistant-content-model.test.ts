import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAssistantContent,
  parseAssistantInline,
} from "../src/components/assistant-content-model";

test("splits long assistant markdown into mobile-friendly blocks", () => {
  const blocks = parseAssistantContent([
    "## 测试架构",
    "",
    "建议建立独立模块 `D:\\work_space\\WeChatPluginGitHubTest`。",
    "",
    "1. PR 快速门禁",
    "2. 每日真机回归",
    "",
    "```text",
    "设备 A -> 测试中继",
    "设备 B -> 测试中继",
    "```",
  ].join("\n"));

  assert.deepEqual(blocks, [
    { type: "heading", level: 2, text: "测试架构" },
    { type: "paragraph", text: "建议建立独立模块 `D:\\work_space\\WeChatPluginGitHubTest`。" },
    { type: "list", ordered: true, items: ["PR 快速门禁", "每日真机回归"] },
    { type: "code", language: "text", content: "设备 A -> 测试中继\n设备 B -> 测试中继" },
  ]);
});

test("parses markdown tables into rows that can be stacked on narrow screens", () => {
  const blocks = parseAssistantContent([
    "| 范围 | 自动化内容 |",
    "|---|---|",
    "| 上行消息 | text、image、voice |",
    "| 协议可靠性 | `D:\\work_space`、HMAC、断线重连 |",
  ].join("\n"));

  assert.deepEqual(blocks, [{
    type: "table",
    headers: ["范围", "自动化内容"],
    rows: [
      ["上行消息", "text、image、voice"],
      ["协议可靠性", "`D:\\work_space`、HMAC、断线重连"],
    ],
  }]);
});

test("preserves readable inline emphasis, code, and web links", () => {
  assert.deepEqual(parseAssistantInline("使用 **真机** 和 `adb reverse`，查看 [文档](https://example.com/docs)。"), [
    { type: "text", text: "使用 " },
    { type: "strong", text: "真机" },
    { type: "text", text: " 和 " },
    { type: "code", text: "adb reverse" },
    { type: "text", text: "，查看 " },
    { type: "link", text: "文档", url: "https://example.com/docs" },
    { type: "text", text: "。" },
  ]);
});

test("shows desktop file links as clean references instead of raw markdown", () => {
  assert.deepEqual(parseAssistantInline("保留 [run.ps1](D:\\work_space\\Plugin\\tests\\run.ps1:1) 作为门禁。"), [
    { type: "text", text: "保留 " },
    { type: "link", text: "run.ps1", url: "D:\\work_space\\Plugin\\tests\\run.ps1:1" },
    { type: "text", text: " 作为门禁。" },
  ]);
});
