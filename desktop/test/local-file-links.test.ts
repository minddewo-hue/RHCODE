import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantContent } from "../src/renderer/src/components/AssistantContent";
import { localFileLinkPath, parseLocalFileLinks } from "../src/renderer/src/local-file-links";

test("renders the reported plan link with its title and a normalized local path", () => {
  const path = "D:/work_space/RHZY_Platform/docs/large-tool-result-processing-plan-2026-11-07.md";
  const content = `Plan: [Processing plan](/${path}).`;
  assert.deepEqual(parseLocalFileLinks(content), [
    { type: "text", text: "Plan: " },
    { type: "file", text: "Processing plan", path },
    { type: "text", text: "." },
  ]);
  const html = renderToStaticMarkup(createElement(AssistantContent, { content }));
  assert.match(html, /role="link"/);
  assert.match(html, />Processing plan<\/button>/);
  assert.ok(!html.includes("[Processing plan]"));
});

test("normalizes absolute file links with spaces, unicode, URIs and source locations", () => {
  for (const [input, expected] of [
    ["/D:/work/docs/plan.md:12:3", "D:/work/docs/plan.md"],
    ["D:\\work\\plan.md:12", "D:\\work\\plan.md"],
    ["</D:/My Project/plan.md:3>", "D:/My Project/plan.md"],
    ["/home/user/plan.md#L12", "/home/user/plan.md"],
    ["file:///D:/My%20Project/plan.md", "D:/My Project/plan.md"],
    ["file://server/share/plan.md", "//server/share/plan.md"],
    ["\\\\server\\share\\plan.md", "\\\\server\\share\\plan.md"],
    ["/tmp/100%/plan.md", "/tmp/100%/plan.md"],
    ["/tmp/%E6%96%B9%E6%A1%88.md", "/tmp/\u65b9\u6848.md"],
  ]) assert.equal(localFileLinkPath(input!), expected);
});

test("preserves code examples, unsupported destinations, and incomplete streaming links", () => {
  for (const content of [
    "`[plan](/tmp/plan.md)`",
    "```md\n[plan](/tmp/plan.md)\n```",
    "~~~md\n[plan](/tmp/plan.md)\n~~~",
    "```md\n[plan](/tmp/plan.md)",
    "[site](https://example.com)",
    "[script](javascript:alert(1))",
    "[relative](docs/plan.md)",
    "[plan](/D:/work/plan.md",
    "<script>alert(1)</script>",
  ]) assert.deepEqual(parseLocalFileLinks(content), [{ type: "text", text: content }]);
  assert.equal(localFileLinkPath("/tmp/%00file"), null);
});

test("supports multiple references and parentheses in file paths without changing other text", () => {
  assert.deepEqual(parseLocalFileLinks("[one](</D:/My Project/plan (final).md>)\n[two](/tmp/two(1).md:5)"), [
    { type: "file", text: "one", path: "D:/My Project/plan (final).md" },
    { type: "text", text: "\n" },
    { type: "file", text: "two", path: "/tmp/two(1).md" },
  ]);
});
