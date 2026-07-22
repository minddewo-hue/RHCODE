import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ComposerAttachment } from "../shared/desktop-api";

const INDEX_VERSION = 1;
const MAX_MANAGED_FILE_BYTES = 100 * 1024 * 1024;
const ARTIFACT_EXTENSIONS = new Set([
  ".7z", ".csv", ".doc", ".docx", ".epub", ".gz", ".html", ".json", ".md",
  ".odf", ".ods", ".odt", ".pdf", ".ppt", ".pptx", ".rar", ".rtf", ".tar",
  ".tex", ".tsv", ".txt", ".xls", ".xlsx", ".xml", ".yaml", ".yml", ".zip",
  ".gif", ".jpg", ".jpeg", ".png", ".webp",
]);
const IMAGE_ARTIFACT_EXTENSIONS = new Set([".gif", ".jpg", ".jpeg", ".png", ".webp"]);

export type ManagedFileSource = "upload" | "generated";

export interface ManagedFileRecord {
  id: string;
  threadId: string;
  turnId: string | null;
  name: string;
  size: number;
  mimeType: string;
  kind: "file" | "image";
  source: ManagedFileSource;
  path: string;
  originalPath: string;
  createdAt: string;
}

interface ManagedFileIndex {
  version: 1;
  files: ManagedFileRecord[];
}

export interface ManagedFileContents {
  bytes: Buffer;
  name: string;
  mimeType: string;
}

export class ManagedFileStore {
  private readonly filesDirectory: string;
  private readonly indexPath: string;
  private records: ManagedFileRecord[];

  constructor(private readonly directory: string) {
    this.filesDirectory = path.join(directory, "files");
    this.indexPath = path.join(directory, "index.json");
    this.records = this.loadIndex();
  }

  registerUploads(threadId: string, attachments: ComposerAttachment[]): ManagedFileRecord[] {
    const records = attachments.map((attachment) => this.registerUpload(threadId, attachment));
    this.records.push(...records);
    return records;
  }

  storeGenerated(threadId: string, turnId: string | null, filePath: string): ManagedFileRecord | null {
    if (!isDocumentArtifact(filePath)) return null;
    const resolved = path.resolve(filePath);
    const existing = this.records.find((record) =>
      record.threadId === threadId
      && record.turnId === turnId
      && record.source === "generated"
      && comparablePath(record.originalPath) === comparablePath(resolved));
    if (existing) return existing;
    try {
      const kind = IMAGE_ARTIFACT_EXTENSIONS.has(path.extname(resolved).toLowerCase()) ? "image" : "file";
      return this.storeFile(threadId, turnId, resolved, path.basename(resolved), kind, "generated");
    } catch {
      return null;
    }
  }

  bindTurn(recordIds: string[], turnId: string): void {
    const ids = new Set(recordIds);
    let changed = false;
    let persistentChanged = false;
    this.records = this.records.map((record) => {
      if (!ids.has(record.id) || record.turnId === turnId) return record;
      changed = true;
      if (record.source === "generated") persistentChanged = true;
      return { ...record, turnId };
    });
    if (changed && persistentChanged) this.saveIndex();
  }

  removeRecords(recordIds: string[]): void {
    const ids = new Set(recordIds);
    if (!this.records.some((record) => ids.has(record.id))) return;
    const removed = this.records.filter((record) => ids.has(record.id));
    const removedPaths = removed.map((record) => record.path);
    this.records = this.records.filter((record) => !ids.has(record.id));
    if (removed.some((record) => record.source === "generated")) this.saveIndex();
    this.removeUnreferencedFiles(removedPaths);
  }

  removeThread(threadId: string): void {
    this.removeRecords(this.records.filter((record) => record.threadId === threadId).map((record) => record.id));
  }

  listThread(threadId: string): ManagedFileRecord[] {
    return this.records.filter((record) => record.threadId === threadId && isManagedRecord(this.directory, record));
  }

  read(id: string): ManagedFileContents | null {
    const record = this.records.find((entry) => entry.id === id);
    if (!record || !isManagedRecord(this.directory, record)) return null;
    try {
      return {
        bytes: fs.readFileSync(record.path),
        name: record.name,
        mimeType: record.mimeType,
      };
    } catch {
      return null;
    }
  }

  private storeFile(
    threadId: string,
    turnId: string | null,
    sourcePath: string,
    requestedName: string,
    kind: "file" | "image",
    source: ManagedFileSource,
  ): ManagedFileRecord {
    const resolved = path.resolve(sourcePath);
    const stats = fs.statSync(resolved);
    if (!stats.isFile() || stats.size <= 0) throw new Error(`Attachment is not a readable file: ${sourcePath}`);
    if (stats.size > MAX_MANAGED_FILE_BYTES) throw new Error(`Attachment exceeds 100 MB: ${requestedName}`);
    const bytes = fs.readFileSync(resolved);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const name = safeFileName(requestedName || path.basename(resolved));
    const storedName = `${digest.slice(0, 24)}-${name}`;
    const storedPath = path.join(this.filesDirectory, storedName);
    fs.mkdirSync(this.filesDirectory, { recursive: true });
    if (!fs.existsSync(storedPath)) writeAtomically(storedPath, bytes);
    const record: ManagedFileRecord = {
      id: `file-${randomUUID()}`,
      threadId,
      turnId,
      name,
      size: bytes.byteLength,
      mimeType: mimeTypeFor(name),
      kind,
      source,
      path: storedPath,
      originalPath: resolved,
      createdAt: new Date().toISOString(),
    };
    this.records.push(record);
    this.saveIndex();
    return record;
  }

  private registerUpload(threadId: string, attachment: ComposerAttachment): ManagedFileRecord {
    const resolved = path.resolve(attachment.path);
    const stats = fs.statSync(resolved);
    if (!stats.isFile() || stats.size <= 0) throw new Error(`Attachment is not a readable file: ${attachment.path}`);
    if (stats.size > MAX_MANAGED_FILE_BYTES) throw new Error(`Attachment exceeds 100 MB: ${attachment.name}`);
    const name = safeFileName(attachment.name || path.basename(resolved));
    return {
      id: `upload-${randomUUID()}`,
      threadId,
      turnId: null,
      name,
      size: stats.size,
      mimeType: mimeTypeFor(name),
      kind: attachment.kind,
      source: "upload",
      path: resolved,
      originalPath: resolved,
      createdAt: new Date().toISOString(),
    };
  }

  private loadIndex(): ManagedFileRecord[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf8")) as Partial<ManagedFileIndex>;
      if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.files)) return [];
      return parsed.files.filter((record): record is ManagedFileRecord =>
        isRecordShape(record) && record.source === "generated");
    } catch {
      return [];
    }
  }

  private saveIndex(): void {
    fs.mkdirSync(this.directory, { recursive: true });
    const temporaryPath = path.join(this.directory, `.index.${randomUUID()}.tmp`);
    try {
      const generatedFiles = this.records.filter((record) => record.source === "generated");
      fs.writeFileSync(temporaryPath, JSON.stringify({ version: INDEX_VERSION, files: generatedFiles }, null, 2), "utf8");
      fs.renameSync(temporaryPath, this.indexPath);
    } finally {
      try { fs.unlinkSync(temporaryPath); } catch { /* The rename succeeded. */ }
    }
  }

  private removeUnreferencedFiles(filePaths: string[]): void {
    const referenced = new Set(this.records.map((record) => comparablePath(record.path)));
    for (const filePath of new Set(filePaths)) {
      if (referenced.has(comparablePath(filePath)) || !isWithin(this.filesDirectory, path.resolve(filePath))) continue;
      try { fs.unlinkSync(filePath); } catch { /* The file is already unavailable. */ }
    }
  }
}

export function isDocumentArtifact(filePath: string): boolean {
  return ARTIFACT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function resolveArtifactPaths(
  projectPath: string,
  values: unknown[],
): string[] {
  const candidates = values.flatMap((value) => artifactCandidates(value));
  const projectRoot = path.resolve(projectPath);
  const resolved = candidates.flatMap((candidate) => {
    const clean = candidate.trim().replace(/^file:\/\//i, "");
    const absolute = path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(projectRoot, clean);
    if (!isWithin(projectRoot, absolute) || !isDocumentArtifact(absolute)) return [];
    try {
      const stats = fs.statSync(absolute);
      return stats.isFile() && stats.size > 0 && stats.size <= MAX_MANAGED_FILE_BYTES ? [absolute] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(resolved.map(comparablePath))].map((key) => resolved.find((value) => comparablePath(value) === key)!);
}

function artifactCandidates(value: unknown): string[] {
  if (typeof value === "string") {
    const quoted = [...value.matchAll(/(?:`([^`\r\n]+)`|\[[^\]]*\]\(([^)]+)\))/g)]
      .flatMap((match) => [match[1], match[2]].filter((entry): entry is string => Boolean(entry)));
    return quoted.length ? quoted : [value];
  }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record.path, record.filePath, record.savedPath].flatMap((entry) => typeof entry === "string" ? [entry] : []);
}

function isRecordShape(value: unknown): value is ManagedFileRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ManagedFileRecord>;
  return typeof record.id === "string"
    && typeof record.threadId === "string"
    && (record.turnId === null || typeof record.turnId === "string")
    && typeof record.name === "string"
    && typeof record.size === "number"
    && typeof record.mimeType === "string"
    && (record.kind === "file" || record.kind === "image")
    && (record.source === "upload" || record.source === "generated")
    && typeof record.path === "string"
    && typeof record.originalPath === "string"
    && typeof record.createdAt === "string";
}

function isManagedRecord(directory: string, record: ManagedFileRecord): boolean {
  if (record.source === "generated" && !isWithin(path.resolve(directory, "files"), path.resolve(record.path))) return false;
  if (record.source === "upload" && comparablePath(record.path) !== comparablePath(record.originalPath)) return false;
  try {
    const stats = fs.lstatSync(record.path);
    return stats.isFile() && !stats.isSymbolicLink() && stats.size === record.size;
  } catch {
    return false;
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function safeFileName(value: string): string {
  const base = path.basename(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim();
  return (base || "attachment").slice(0, 180);
}

function mimeTypeFor(fileName: string): string {
  return new Map<string, string>([
    [".csv", "text/csv"], [".doc", "application/msword"],
    [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [".html", "text/html"], [".json", "application/json"], [".md", "text/markdown"],
    [".pdf", "application/pdf"], [".ppt", "application/vnd.ms-powerpoint"],
    [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    [".txt", "text/plain"], [".xls", "application/vnd.ms-excel"],
    [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    [".xml", "application/xml"], [".zip", "application/zip"],
    [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
    [".gif", "image/gif"], [".webp", "image/webp"],
  ]).get(path.extname(fileName).toLowerCase()) || "application/octet-stream";
}

function writeAtomically(filePath: string, bytes: Buffer): void {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, bytes, { flag: "wx" });
    try { fs.renameSync(temporaryPath, filePath); } catch (error) {
      if (!fs.existsSync(filePath)) throw error;
    }
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch { /* The rename succeeded. */ }
  }
}
