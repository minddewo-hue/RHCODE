import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gzip, gunzip } from "node:zlib";

const BACKUP_FORMAT = "rhzycode-conversation-backup";
const BACKUP_VERSION = 1;
const MAX_SESSION_COUNT = 10_000;
const MAX_SESSION_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_SESSION_BYTES = 512 * 1024 * 1024;
const MAX_BACKUP_FILE_BYTES = 512 * 1024 * 1024;
const MAX_BACKUP_JSON_BYTES = 768 * 1024 * 1024;
const MAX_SESSION_PREVIEW_BYTES = 1024 * 1024;
const THREAD_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

interface BackupSession {
  threadId: string;
  archived: boolean;
  relativePath: string;
  modifiedAt: string;
  size: number;
  sha256: string;
  encoding: "base64";
  content: string;
}

interface ConversationBackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  projectPath: string;
  sessions: BackupSession[];
}

interface SessionMetadata {
  id: string;
  cwd: string;
}

interface DecodedBackupSession {
  entry: BackupSession;
  contents: Buffer;
  metadata: SessionMetadata;
}

export interface ConversationBackupResult {
  filePath: string;
  conversationCount: number;
  size: number;
}

export interface ConversationRestoreResult {
  filePath: string;
  importedCount: number;
  skippedCount: number;
  projectPaths: string[];
}

export interface ConversationSessionRecord {
  threadId: string;
  projectPath: string;
  archived: boolean;
  title: string;
  model: string;
  modifiedAt: string;
}

export async function listConversationSessions(
  codexHome: string,
): Promise<ConversationSessionRecord[]> {
  const sessions = new Map<string, ConversationSessionRecord>();
  for (const directoryName of ["sessions", "archived_sessions"] as const) {
    for (const filePath of await listJsonlFiles(path.join(codexHome, directoryName))) {
      const session = await readSessionRecord(filePath, directoryName === "archived_sessions");
      if (!session) continue;
      const current = sessions.get(session.threadId);
      if (!current || current.archived && !session.archived) sessions.set(session.threadId, session);
    }
  }
  return [...sessions.values()];
}

export async function listProjectConversationThreadIds(
  codexHome: string,
  projectPath: string,
): Promise<string[]> {
  const threadIds = new Set<string>();
  for (const directoryName of ["sessions", "archived_sessions"]) {
    for (const filePath of await listJsonlFiles(path.join(codexHome, directoryName))) {
      const metadata = await readSessionMetadataFile(filePath);
      if (metadata && samePath(metadata.cwd, projectPath)) threadIds.add(metadata.id);
    }
  }
  return [...threadIds];
}

export async function deleteConversationSessionFiles(
  codexHome: string,
  requestedThreadIds: Iterable<string>,
): Promise<number> {
  const threadIds = new Set(
    [...requestedThreadIds].filter((threadId) => THREAD_ID_PATTERN.test(threadId)),
  );
  if (threadIds.size === 0) return 0;

  let deletedCount = 0;
  for (const directoryName of ["sessions", "archived_sessions"]) {
    for (const filePath of await listJsonlFiles(path.join(codexHome, directoryName))) {
      const metadata = await readSessionMetadataFile(filePath);
      const fileName = path.basename(filePath).toLowerCase();
      const matchesFileName = !metadata && [...threadIds].some((threadId) =>
        fileName.endsWith(`-${threadId.toLowerCase()}.jsonl`));
      if (!threadIds.has(metadata?.id || "") && !matchesFileName) continue;
      try {
        await fs.unlink(filePath);
        deletedCount += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return deletedCount;
}

export async function backupProjectConversations(
  codexHome: string,
  projectPath: string,
  destinationPath: string,
): Promise<ConversationBackupResult> {
  const sessions: BackupSession[] = [];
  let totalBytes = 0;

  for (const directoryName of ["sessions", "archived_sessions"] as const) {
    const root = path.join(codexHome, directoryName);
    for (const filePath of await listJsonlFiles(root)) {
      const snapshot = await readStableSession(filePath);
      if (!snapshot) continue;
      const { contents, stats } = snapshot;
      const metadata = readSessionMetadata(contents);
      if (!metadata || !samePath(metadata.cwd, projectPath)) continue;

      totalBytes += contents.length;
      if (totalBytes > MAX_TOTAL_SESSION_BYTES) {
        throw new Error("Project conversations are too large for a single backup.");
      }
      if (sessions.length >= MAX_SESSION_COUNT) {
        throw new Error("Project has too many conversations for a single backup.");
      }

      sessions.push({
        threadId: metadata.id,
        archived: directoryName === "archived_sessions",
        relativePath: toPortableRelativePath(root, filePath),
        modifiedAt: stats.mtime.toISOString(),
        size: contents.length,
        sha256: sha256(contents),
        encoding: "base64",
        content: contents.toString("base64"),
      });
    }
  }

  if (sessions.length === 0) {
    throw new Error("No conversations were found for this project.");
  }

  const manifest: ConversationBackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    projectPath,
    sessions,
  };
  const compressed = await gzipBuffer(Buffer.from(JSON.stringify(manifest), "utf8"));
  await writeFileAtomically(destinationPath, compressed);
  return { filePath: destinationPath, conversationCount: sessions.length, size: compressed.length };
}

export async function restoreProjectConversations(
  codexHome: string,
  backupPath: string,
): Promise<ConversationRestoreResult> {
  const stats = await fs.stat(backupPath);
  if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_BACKUP_FILE_BYTES) {
    throw new Error("Conversation backup file is empty or too large.");
  }

  const compressed = await fs.readFile(backupPath);
  let manifest: ConversationBackupManifest;
  try {
    const json = await gunzipBuffer(compressed);
    manifest = JSON.parse(json.toString("utf8")) as ConversationBackupManifest;
  } catch {
    throw new Error("Conversation backup file is invalid or damaged.");
  }

  const decoded = validateManifest(manifest);
  const existingThreadIds = await collectThreadIds(codexHome);
  let importedCount = 0;
  let skippedCount = 0;
  const projectPaths = new Set<string>();
  const writtenPaths: string[] = [];

  try {
    for (const session of decoded) {
      projectPaths.add(session.metadata.cwd);
      if (existingThreadIds.has(session.entry.threadId)) {
        skippedCount += 1;
        continue;
      }

      const root = path.join(codexHome, session.entry.archived ? "archived_sessions" : "sessions");
      const destinationPath = resolveBackupRelativePath(root, session.entry.relativePath);
      const finalPath = await availableSessionPath(destinationPath, root, session.entry.threadId);
      await fs.mkdir(path.dirname(finalPath), { recursive: true });
      await fs.writeFile(finalPath, session.contents, { flag: "wx", mode: 0o600 });
      writtenPaths.push(finalPath);
      const modifiedAt = new Date(session.entry.modifiedAt);
      await fs.utimes(finalPath, modifiedAt, modifiedAt).catch(() => undefined);
      existingThreadIds.add(session.entry.threadId);
      importedCount += 1;
    }
  } catch (error) {
    await Promise.all(writtenPaths.map((filePath) => fs.rm(filePath, { force: true })));
    throw error;
  }

  return {
    filePath: backupPath,
    importedCount,
    skippedCount,
    projectPaths: [...projectPaths],
  };
}

function validateManifest(value: ConversationBackupManifest): DecodedBackupSession[] {
  if (!value || typeof value !== "object"
    || value.format !== BACKUP_FORMAT
    || value.version !== BACKUP_VERSION
    || typeof value.projectPath !== "string"
    || !Array.isArray(value.sessions)
    || value.sessions.length === 0
    || value.sessions.length > MAX_SESSION_COUNT) {
    throw new Error("Conversation backup format is not supported.");
  }

  let totalBytes = 0;
  const ids = new Set<string>();
  return value.sessions.map((entry) => {
    if (!entry || typeof entry !== "object"
      || !THREAD_ID_PATTERN.test(entry.threadId)
      || typeof entry.archived !== "boolean"
      || !isSafeRelativePath(entry.relativePath)
      || typeof entry.modifiedAt !== "string"
      || !Number.isFinite(new Date(entry.modifiedAt).getTime())
      || !Number.isSafeInteger(entry.size)
      || entry.size <= 0
      || entry.size > MAX_SESSION_BYTES
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || entry.encoding !== "base64"
      || typeof entry.content !== "string"
      || !isCanonicalBase64(entry.content)
      || ids.has(entry.threadId)) {
      throw new Error("Conversation backup contains an invalid session entry.");
    }

    const contents = Buffer.from(entry.content, "base64");
    totalBytes += contents.length;
    const metadata = readSessionMetadata(contents);
    if (contents.length !== entry.size
      || totalBytes > MAX_TOTAL_SESSION_BYTES
      || sha256(contents) !== entry.sha256
      || !metadata
      || metadata.id !== entry.threadId) {
      throw new Error("Conversation backup session data is invalid or damaged.");
    }
    ids.add(entry.threadId);
    return { entry, contents, metadata };
  });
}

async function collectThreadIds(codexHome: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const directoryName of ["sessions", "archived_sessions"]) {
    for (const filePath of await listJsonlFiles(path.join(codexHome, directoryName))) {
      try {
        const handle = await fs.open(filePath, "r");
        try {
          const buffer = Buffer.alloc(1024 * 1024);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const metadata = readSessionMetadata(buffer.subarray(0, bytesRead));
          if (metadata) ids.add(metadata.id);
        } finally {
          await handle.close();
        }
      } catch {
        // A damaged or concurrently removed session must not block other restores.
      }
    }
  }
  return ids;
}

async function readSessionMetadataFile(filePath: string): Promise<SessionMetadata | null> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return readSessionMetadata(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function readSessionRecord(
  filePath: string,
  archived: boolean,
): Promise<ConversationSessionRecord | null> {
  try {
    const stats = await fs.stat(filePath);
    const handle = await fs.open(filePath, "r");
    try {
      if (!stats.isFile() || stats.size <= 0) return null;
      const buffer = Buffer.alloc(Math.min(stats.size, MAX_SESSION_PREVIEW_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return readSessionRecordContents(buffer.subarray(0, bytesRead), archived, stats.mtime);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function readStableSession(
  filePath: string,
): Promise<{ contents: Buffer; stats: Awaited<ReturnType<typeof fs.stat>> } | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let before;
    try {
      before = await fs.stat(filePath);
    } catch {
      return null;
    }
    if (!before.isFile() || before.size <= 0 || before.size > MAX_SESSION_BYTES) return null;
    const contents = await fs.readFile(filePath);
    const after = await fs.stat(filePath).catch(() => null);
    if (after && before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return { contents, stats: after };
    }
  }
  throw new Error("A conversation changed while it was being backed up. Try again after the task finishes.");
}

function readSessionMetadata(contents: Buffer): SessionMetadata | null {
  const newline = contents.indexOf(0x0a);
  const firstLine = contents.subarray(0, newline >= 0 ? newline : contents.length)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r$/, "");
  if (!firstLine) return null;
  try {
    const record = JSON.parse(firstLine) as {
      type?: string;
      payload?: { id?: unknown; session_id?: unknown; cwd?: unknown };
    };
    const id = typeof record.payload?.id === "string"
      ? record.payload.id
      : typeof record.payload?.session_id === "string" ? record.payload.session_id : "";
    const cwd = typeof record.payload?.cwd === "string" ? record.payload.cwd : "";
    return record.type === "session_meta" && THREAD_ID_PATTERN.test(id) && cwd
      ? { id, cwd }
      : null;
  } catch {
    return null;
  }
}

function readSessionRecordContents(
  contents: Buffer,
  archived: boolean,
  fileModifiedAt: Date,
): ConversationSessionRecord | null {
  const metadata = readSessionMetadata(contents);
  if (!metadata) return null;

  let title = "Restored conversation";
  let model = "previous";
  const modifiedAt = fileModifiedAt.toISOString();
  for (const line of contents.toString("utf8").split(/\r?\n/)) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = asRecord(record.payload);
    if (record.type === "turn_context" && typeof payload.model === "string" && payload.model.trim()) {
      model = payload.model.trim();
    }
    if (title !== "Restored conversation") continue;
    const userText = extractUserText(record.type, payload);
    if (userText && !isInjectedContext(userText)) title = summarizeConversationTitle(userText);
  }
  return {
    threadId: metadata.id,
    projectPath: metadata.cwd,
    archived,
    title,
    model,
    modifiedAt,
  };
}

function extractUserText(recordType: unknown, payload: Record<string, unknown>): string | null {
  if (recordType === "event_msg" && payload.type === "user_message") {
    return typeof payload.message === "string" ? payload.message.trim() : null;
  }
  if (recordType !== "response_item" || payload.type !== "message" || payload.role !== "user") {
    return null;
  }
  if (typeof payload.text === "string") return payload.text.trim();
  if (!Array.isArray(payload.content)) return null;
  const text = payload.content.flatMap((entry) => {
    const item = asRecord(entry);
    return (item.type === "input_text" || item.type === "text") && typeof item.text === "string"
      ? [item.text]
      : [];
  }).join("\n").trim();
  return text || null;
}

function isInjectedContext(value: string): boolean {
  const normalized = value.trimStart();
  return normalized.startsWith("<environment_context>")
    || normalized.startsWith("<permissions instructions>")
    || normalized.startsWith("<collaboration_mode>")
    || normalized.startsWith("# AGENTS.md instructions");
}

function summarizeConversationTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length <= MAX_SESSION_COUNT) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function resolveBackupRelativePath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, ...relativePath.split("/"));
  const normalizedRoot = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(normalizedRoot)) throw new Error("Conversation backup contains an unsafe path.");
  return resolved;
}

async function availableSessionPath(preferredPath: string, root: string, threadId: string): Promise<string> {
  try {
    await fs.access(preferredPath);
  } catch {
    return preferredPath;
  }
  const day = new Date().toISOString().slice(0, 10).split("-");
  return path.join(root, ...day, `rollout-restored-${Date.now()}-${threadId}.jsonl`);
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\\")) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value
    && !path.posix.isAbsolute(value)
    && !value.startsWith("../")
    && value.toLowerCase().endsWith(".jsonl");
}

function toPortableRelativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function isCanonicalBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left).replace(/[\\/]+$/, "");
  const normalizedRight = path.resolve(right).replace(/[\\/]+$/, "");
  return process.platform === "linux"
    ? normalizedLeft === normalizedRight
    : normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function gzipBuffer(contents: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(contents, { level: 9 }, (error, result) => error ? reject(error) : resolve(result));
  });
}

function gunzipBuffer(contents: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(contents, { maxOutputLength: MAX_BACKUP_JSON_BYTES }, (error, result) => (
      error ? reject(error) : resolve(result)
    ));
  });
}

async function writeFileAtomically(filePath: string, contents: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents, { mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
