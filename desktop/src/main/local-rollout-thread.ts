import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationFile, ConversationMessage, ThreadDetail, ThreadSummary } from "@rhzycode/protocol";
import type { ManagedFileRecord } from "./managed-file-store";
import { turnScopedItemId } from "../shared/item-identity";
import { findRolloutPath, loadRolloutGeneratedImages } from "./generated-image-rollout";

const MAX_ROLLOUT_BYTES = 256 * 1024 * 1024;

interface TimedMessage {
  message: ConversationMessage;
  createdAt: string;
  order: number;
  turnId: string | null;
}

interface ParsedRolloutRecord {
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  order: number;
}

export interface LocalRolloutLoadOptions {
  /**
   * Persist project-local document/image paths discovered in assistant text so
   * reopen can show the same inline previews as the live session.
   */
  materializeArtifacts?: (turnId: string | null, content: string) => ManagedFileRecord[];
}

export interface RolloutUploadedImage {
  turnId: string | null;
  name: string;
  dataUrl: string;
}

export async function loadLocalRolloutThread(
  codexHome: string,
  thread: ThreadSummary,
  managedFiles: ManagedFileRecord[] = [],
  options: LocalRolloutLoadOptions = {},
): Promise<ThreadDetail | null> {
  const rolloutPath = findRolloutPath(codexHome, thread.id);
  if (!rolloutPath) return null;

  let contents: string;
  try {
    const stats = await fs.promises.stat(rolloutPath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_ROLLOUT_BYTES) return null;
    contents = await fs.promises.readFile(rolloutPath, "utf8");
  } catch {
    return null;
  }

  const records: ParsedRolloutRecord[] = [];
  let order = 0;
  for (const line of contents.split(/\r?\n/)) {
    order += 1;
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    records.push({
      type: stringValue(record.type),
      payload: asRecord(record.payload),
      createdAt: validTimestamp(record.timestamp, thread.updatedAt),
      order,
    });
  }

  const hiddenCompactionMessages = compactionMessageOrders(records);
  const responseMessages: TimedMessage[] = [];
  const materializedArtifacts: ManagedFileRecord[] = [];
  for (const record of records) {
    const payload = record.payload;
    const createdAt = record.createdAt;
    const turnId = messageTurnId(payload);
    if (record.type === "response_item" && payload.type === "message") {
      const role = payload.role === "user" || payload.role === "assistant" ? payload.role : null;
      if (!role) continue;
      const content = extractResponseMessageText(payload);
      if (!content || hiddenCompactionMessages.has(record.order) || (role === "user" && isInjectedContext(content))) continue;
      const uploadedFiles = role === "user"
        ? managedFiles.filter((file) => file.source === "upload" && file.turnId === turnId)
        : [];
      if (role === "assistant" && options.materializeArtifacts) {
        materializedArtifacts.push(...options.materializeArtifacts(turnId, content));
      }
      responseMessages.push({
        message: {
          id: turnScopedItemId(turnId, stringValue(payload.id) || `offline-message-${record.order}`),
          role,
          content: role === "user" ? stripUserAttachmentMarkup(content) : content,
          ...(role === "user" && !uploadedFiles.some((file) => file.kind === "image")
            ? localMessageImages(payload.content)
            : {}),
          ...(uploadedFiles.length ? { files: uploadedFiles.map(managedFileReference) } : {}),
        },
        createdAt,
        order: record.order,
        turnId,
      });
      continue;
    }
  }

  const messages = responseMessages;
  attachGeneratedManagedFiles(messages, [...managedFiles, ...materializedArtifacts]);
  for (const image of loadRolloutGeneratedImages(codexHome, thread.id)) {
    messages.push({
      message: {
        id: turnScopedItemId(image.turnId, image.id),
        role: "assistant",
        content: "",
        images: [image.image],
      },
      createdAt: image.createdAt,
      order: order += 1,
      turnId: image.turnId,
    });
  }
  messages.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.order - right.order);

  return {
    thread,
    messages: messages.map((entry) => entry.message),
    timeline: [],
  };
}

export async function loadRolloutUploadedImages(
  codexHome: string,
  threadId: string,
): Promise<RolloutUploadedImage[]> {
  const rolloutPath = findRolloutPath(codexHome, threadId);
  if (!rolloutPath) return [];
  let contents: string;
  try {
    const stats = await fs.promises.stat(rolloutPath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_ROLLOUT_BYTES) return [];
    contents = await fs.promises.readFile(rolloutPath, "utf8");
  } catch {
    return [];
  }

  const images: RolloutUploadedImage[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type !== "response_item") continue;
    const payload = asRecord(record.payload);
    if (payload.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) continue;
    const turnId = messageTurnId(payload);
    payload.content.forEach((entry, index) => {
      const item = asRecord(entry);
      if (item.type !== "input_image") return;
      const dataUrl = stringValue(item.image_url);
      if (!dataUrl.startsWith("data:image/")) return;
      images.push({
        turnId,
        name: rolloutImageName(payload.content as unknown[], index),
        dataUrl,
      });
    });
  }
  return images;
}

export function reconcileRolloutUploadedImages(
  managedFiles: ManagedFileRecord[],
  rolloutImages: RolloutUploadedImage[],
): ManagedFileRecord[] {
  const expectedByTurn = new Map<string, number>();
  for (const image of rolloutImages) {
    const key = uploadedImageTurnKey(image.turnId);
    expectedByTurn.set(key, (expectedByTurn.get(key) || 0) + 1);
  }
  if (expectedByTurn.size === 0) return managedFiles;

  const candidatesByTurn = new Map<string, ManagedFileRecord[]>();
  for (const file of managedFiles) {
    if (file.source !== "upload" || file.kind !== "image") continue;
    const key = uploadedImageTurnKey(file.turnId);
    if (!expectedByTurn.has(key)) continue;
    const candidates = candidatesByTurn.get(key) || [];
    candidates.push(file);
    candidatesByTurn.set(key, candidates);
  }

  const keptIds = new Set<string>();
  for (const [key, expected] of expectedByTurn) {
    const candidates = candidatesByTurn.get(key) || [];
    candidates.sort((left, right) => (
      Number(left.originalPath.startsWith("data:")) - Number(right.originalPath.startsWith("data:"))
      || left.createdAt.localeCompare(right.createdAt)
    ));
    for (const file of candidates.slice(0, expected)) keptIds.add(file.id);
  }

  return managedFiles.filter((file) => (
    file.source !== "upload"
    || file.kind !== "image"
    || !expectedByTurn.has(uploadedImageTurnKey(file.turnId))
    || keptIds.has(file.id)
  ));
}

function uploadedImageTurnKey(turnId: string | null): string {
  return turnId || "\u0000";
}

function compactionMessageOrders(records: ParsedRolloutRecord[]): Set<number> {
  const hidden = new Set<number>();
  for (let compactedIndex = 0; compactedIndex < records.length; compactedIndex += 1) {
    const compacted = records[compactedIndex]!;
    if (compacted.type !== "compacted") continue;
    const compactionMessage = stringValue(compacted.payload.message);
    if (!compactionMessage) continue;

    let assistantFound = false;
    let userFound = false;
    for (let index = compactedIndex - 1; index >= 0 && (!assistantFound || !userFound); index -= 1) {
      const candidate = records[index]!;
      if (candidate.type === "compacted") break;
      if (candidate.type !== "response_item" || candidate.payload.type !== "message") continue;
      const content = extractResponseMessageText(candidate.payload);
      if (!content) continue;
      if (!userFound && candidate.payload.role === "user" && content === compactionMessage) {
        hidden.add(candidate.order);
        userFound = true;
      }
      if (!assistantFound && candidate.payload.role === "assistant" && (
        content === compactionMessage || compactionMessage.endsWith(`\n${content}`)
      )) {
        hidden.add(candidate.order);
        assistantFound = true;
      }
    }
  }
  return hidden;
}

function extractResponseMessageText(payload: Record<string, unknown>): string {
  if (typeof payload.text === "string") return payload.text.trim();
  if (!Array.isArray(payload.content)) return "";
  return payload.content.flatMap((entry) => {
    const item = asRecord(entry);
    return new Set(["input_text", "output_text", "text"]).has(String(item.type))
      && typeof item.text === "string"
      ? [item.text]
      : [];
  }).join("\n").trim();
}

function rolloutImageName(content: unknown[], imageIndex: number): string {
  for (let index = imageIndex - 1; index >= 0; index -= 1) {
    const text = stringValue(asRecord(content[index]).text);
    const pathMatch = /<image\b[^>]*\bpath=(?:"([^"]+)"|'([^']+)')[^>]*>/i.exec(text);
    const imagePath = pathMatch?.[1] || pathMatch?.[2];
    if (imagePath) return path.basename(imagePath) || "image";
  }
  return "image";
}

function localMessageImages(value: unknown): Pick<ConversationMessage, "images"> | Record<string, never> {
  if (!Array.isArray(value)) return {};
  const images = value.flatMap((entry) => {
    const item = asRecord(entry);
    if (item.type !== "input_image") return [];
    const candidate = stringValue(item.path) || stringValue(item.image_url);
    if (!candidate) return [];
    let imagePath = candidate;
    try {
      if (candidate.startsWith("file:")) imagePath = fileURLToPath(candidate);
    } catch {
      return [];
    }
    if (!path.isAbsolute(imagePath)) return [];
    return [{ path: imagePath, name: path.basename(imagePath) || "image" }];
  });
  return images.length > 0 ? { images } : {};
}

function attachGeneratedManagedFiles(
  messages: TimedMessage[],
  managedFiles: ManagedFileRecord[],
): void {
  const generated = dedupeManagedFiles(managedFiles.filter((file) => file.source === "generated"));
  if (!generated.length) return;

  const byTurn = new Map<string, ManagedFileRecord[]>();
  const orphans: ManagedFileRecord[] = [];
  for (const file of generated) {
    if (file.turnId) {
      const list = byTurn.get(file.turnId) || [];
      list.push(file);
      byTurn.set(file.turnId, list);
    } else {
      orphans.push(file);
    }
  }

  for (const [turnId, files] of byTurn) {
    let assistantIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.message.role === "assistant" && messages[index]?.turnId === turnId) {
        assistantIndex = index;
        break;
      }
    }
    if (assistantIndex === -1) {
      messages.push(artifactMessage(files, turnId));
    } else {
      messages[assistantIndex] = {
        ...messages[assistantIndex]!,
        message: withGeneratedAttachments(messages[assistantIndex]!.message, files),
      };
    }
  }

  if (!orphans.length) return;
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.message.role === "assistant") {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex === -1) {
    messages.push(artifactMessage(orphans, null));
  } else {
    messages[assistantIndex] = {
      ...messages[assistantIndex]!,
      message: withGeneratedAttachments(messages[assistantIndex]!.message, orphans),
    };
  }
}

function artifactMessage(files: ManagedFileRecord[], turnId: string | null): TimedMessage {
  const first = files[0]!;
  return {
    message: withGeneratedAttachments({
      id: turnScopedItemId(turnId, `files-${first.id}`),
      role: "assistant",
      content: "",
    }, files),
    createdAt: first.createdAt,
    order: Number.MAX_SAFE_INTEGER,
    turnId,
  };
}

function withGeneratedAttachments(
  message: ConversationMessage,
  files: ManagedFileRecord[],
): ConversationMessage {
  const generatedFiles = files.filter((file) => file.kind === "file").map(managedFileReference);
  const generatedImages = files
    .filter((file) => file.kind === "image")
    .map((file) => ({ path: file.path, name: file.name, generated: true as const }));
  return {
    ...message,
    ...(generatedFiles.length ? { files: [...(message.files || []), ...generatedFiles] } : {}),
    ...(generatedImages.length ? { images: [...(message.images || []), ...generatedImages] } : {}),
  };
}

function dedupeManagedFiles(files: ManagedFileRecord[]): ManagedFileRecord[] {
  const unique = new Map<string, ManagedFileRecord>();
  for (const file of files) {
    if (!unique.has(file.id)) unique.set(file.id, file);
  }
  return [...unique.values()];
}

function messageTurnId(payload: Record<string, unknown>): string | null {
  const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
  return stringValue(metadata.turn_id) || null;
}

function isInjectedContext(value: string): boolean {
  const normalized = value.trimStart();
  return normalized.startsWith("<environment_context>")
    || normalized.startsWith("<permissions instructions>")
    || normalized.startsWith("<collaboration_mode>")
    || normalized.startsWith("<skills_instructions>")
    || normalized.startsWith("<turn_aborted>")
    || normalized.startsWith("# AGENTS.md instructions");
}

function stripUserAttachmentMarkup(value: string): string {
  const withoutImageWrappers = value
    .replace(/<image\b[^>]*\bpath=(?:"[^"]*"|'[^']*')[^>]*>\s*<\/image>/gi, "")
    .replace(/<image\b[^>]*\bpath=(?:"[^"]*"|'[^']*')[^>]*>/gi, "")
    .replace(/<\/image>/gi, "")
    .trim();
  return withoutImageWrappers.split("\n\nAttached files (use these absolute paths):\n", 1)[0] || withoutImageWrappers;
}

function managedFileReference(record: ManagedFileRecord): ConversationFile {
  return {
    id: record.id,
    name: record.name,
    size: record.size,
    mimeType: record.mimeType,
    source: record.source,
    path: record.path,
  };
}

function validTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
