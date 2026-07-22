import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.resolve(root, "..");

test("catalog contains only model.rhzy.ai routes", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(desktopRoot, "codex-model-catalog.json"), "utf8"));
  const models = new Map(catalog.models.map((model) => [model.slug, model]));

  assert.ok(models.size > 0);
  assert.equal([...models.keys()].every((slug) => slug.startsWith("sub2api/")), true);
  assert.equal([...models.keys()].some((slug) => /faker|vllm/i.test(slug)), false);
});
