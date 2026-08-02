import assert from "node:assert/strict";
import test from "node:test";
import { buildImageContextMenu, buildTextContextMenu } from "../src/main/text-context-menu";

test("offers cut, copy, paste, and select all for editable text", () => {
  const items = buildTextContextMenu({
    isEditable: true,
    selectionText: "selected",
    editFlags: { canCut: true, canCopy: true, canPaste: true },
  });

  assert.deepEqual(items.map((item) => item.role || item.type), [
    "cut",
    "copy",
    "paste",
    "separator",
    "selectAll",
  ]);
  assert.ok(items.slice(0, 3).every((item) => item.enabled));
});

test("offers copy without edit actions for selected document text", () => {
  const items = buildTextContextMenu({
    isEditable: false,
    selectionText: "response text",
    editFlags: {},
  });

  assert.deepEqual(items.map((item) => item.role || item.type), [
    "copy",
    "separator",
    "selectAll",
  ]);
  assert.equal(items[0].enabled, true);
});

test("keeps copy disabled when document text is not selected", () => {
  const items = buildTextContextMenu({
    isEditable: false,
    selectionText: "",
    editFlags: {},
  });

  assert.equal(items[0].role, "copy");
  assert.equal(items[0].enabled, false);
  assert.equal(items[2].role, "selectAll");
  assert.equal(items[2].enabled, true);
});

test("offers image download through the context menu", () => {
  let downloads = 0;
  const items = buildImageContextMenu(() => { downloads += 1; });

  assert.equal(items.length, 1);
  assert.equal(items[0].label, "Download image");
  assert.equal(typeof items[0].click, "function");
  items[0].click?.({} as never, {} as never, {} as never);
  assert.equal(downloads, 1);
});
