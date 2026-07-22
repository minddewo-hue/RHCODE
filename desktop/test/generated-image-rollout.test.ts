import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRolloutGeneratedImages } from "../src/main/generated-image-rollout.js";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=";

test("restores completed image generation results from a rollout", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-rollout-image-"));
  try {
    const threadId = "019f8896-ea1d-7e21-bc23-61d6537f3f3a";
    const sessionDirectory = path.join(codexHome, "sessions", "2026", "07", "22");
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(path.join(sessionDirectory, `rollout-test-${threadId}.jsonl`), [
      "not-json",
      JSON.stringify({
        timestamp: "2026-07-22T07:03:38.992Z",
        type: "response_item",
        payload: {
          type: "image_generation_call",
          id: "ig-real-result",
          status: "completed",
          revised_prompt: "A generated test image",
          result: ONE_PIXEL_PNG,
          internal_chat_message_metadata_passthrough: { turn_id: "turn-image" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-22T07:03:39.000Z",
        type: "response_item",
        payload: { type: "image_generation_call", id: "ig-incomplete", status: "in_progress" },
      }),
    ].join("\n"), "utf8");

    const images = loadRolloutGeneratedImages(codexHome, threadId);

    assert.equal(images.length, 1);
    assert.equal(images[0]?.id, "ig-real-result");
    assert.equal(images[0]?.turnId, "turn-image");
    assert.equal(images[0]?.revisedPrompt, "A generated test image");
    assert.equal(fs.existsSync(images[0]?.image.path || ""), true);
    assert.deepEqual(fs.readFileSync(images[0]!.image.path), Buffer.from(ONE_PIXEL_PNG, "base64"));
    assert.deepEqual(loadRolloutGeneratedImages(codexHome, "../invalid"), []);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
