import fs from "node:fs";
import { findRolloutPath } from "./generated-image-rollout";

const MAX_ROLLOUT_BYTES = 256 * 1024 * 1024;

export interface RolloutThreadState {
  currentTokens: number | null;
  lastSuccessfulModel: string | null;
}

export function loadRolloutThreadState(
  codexHome: string,
  threadId: string,
): RolloutThreadState {
  const rolloutPath = findRolloutPath(codexHome, threadId);
  if (!rolloutPath) return emptyState();

  let contents: string;
  try {
    const stats = fs.statSync(rolloutPath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_ROLLOUT_BYTES) return emptyState();
    contents = fs.readFileSync(rolloutPath, "utf8");
  } catch {
    return emptyState();
  }

  const turnModels = new Map<string, string>();
  let currentTokens: number | null = null;
  let lastSuccessfulModel: string | null = null;
  for (const line of contents.split(/\r?\n/)) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = asRecord(record.payload);
    if (record.type === "turn_context") {
      const turnId = stringValue(payload.turn_id);
      const model = stringValue(payload.model);
      if (turnId && model) turnModels.set(turnId, model);
      continue;
    }
    if (record.type !== "event_msg") continue;
    if (payload.type === "token_count") {
      const info = asRecord(payload.info);
      const lastUsage = asRecord(info.last_token_usage);
      const value = Number(lastUsage.total_tokens);
      if (Number.isFinite(value) && value >= 0) currentTokens = value;
      continue;
    }
    if (payload.type !== "task_complete" || payload.error) continue;
    const turnId = stringValue(payload.turn_id);
    if (turnId && turnModels.has(turnId)) lastSuccessfulModel = turnModels.get(turnId)!;
  }
  return { currentTokens, lastSuccessfulModel };
}

function emptyState(): RolloutThreadState {
  return { currentTokens: null, lastSuccessfulModel: null };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
