import fs from "node:fs";
import path from "node:path";
import {
  materializeGeneratedImage,
  type StoredGeneratedImage,
} from "./generated-image-store";

const MAX_ROLLOUT_BYTES = 256 * 1024 * 1024;
const MAX_SESSION_FILES = 10_000;
const THREAD_ID_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;

export interface RolloutGeneratedImage {
  id: string;
  turnId: string | null;
  createdAt: string;
  revisedPrompt: string | null;
  image: StoredGeneratedImage;
}

export function loadRolloutGeneratedImages(
  codexHome: string,
  threadId: string,
): RolloutGeneratedImage[] {
  if (!THREAD_ID_PATTERN.test(threadId)) return [];
  const rolloutPath = findRolloutPath(codexHome, threadId);
  if (!rolloutPath) return [];

  let contents: string;
  try {
    const stats = fs.statSync(rolloutPath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_ROLLOUT_BYTES) return [];
    contents = fs.readFileSync(rolloutPath, "utf8");
  } catch {
    return [];
  }

  const outputDirectory = path.join(codexHome, "generated_images");
  const images = new Map<string, RolloutGeneratedImage>();
  for (const line of contents.split(/\r?\n/)) {
    if (!line.includes('"image_generation_call"')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type !== "response_item") continue;
    const payload = asRecord(record.payload);
    if (payload.type !== "image_generation_call" || payload.status !== "completed") continue;
    const id = String(payload.id || "").trim();
    if (!id || images.has(id)) continue;
    const image = materializeGeneratedImage(outputDirectory, payload);
    if (!image) continue;
    const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
    images.set(id, {
      id,
      turnId: typeof metadata.turn_id === "string" ? metadata.turn_id : null,
      createdAt: typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString(),
      revisedPrompt: typeof payload.revised_prompt === "string" ? payload.revised_prompt : null,
      image,
    });
  }
  return [...images.values()];
}

export function findRolloutPath(codexHome: string, threadId: string): string | null {
  const suffix = `-${threadId}.jsonl`.toLowerCase();
  for (const directoryName of ["sessions", "archived_sessions"]) {
    const root = path.join(codexHome, directoryName);
    const pending = [root];
    let visitedFiles = 0;
    while (pending.length > 0 && visitedFiles < MAX_SESSION_FILES) {
      const directory = pending.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
          continue;
        }
        if (!entry.isFile()) continue;
        visitedFiles += 1;
        if (entry.name.toLowerCase().endsWith(suffix)) return entryPath;
      }
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
