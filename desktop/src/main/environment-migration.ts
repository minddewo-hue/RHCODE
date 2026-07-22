import fs from "node:fs";
import path from "node:path";
import type { AppServerClient } from "./app-server";

export type EnvironmentMigrationSource = "codex" | "claude";
export type EnvironmentMigrationStatus = "migrated" | "skipped" | "none";

interface StoredMigrationResult {
  status: EnvironmentMigrationStatus;
  completedAt: string;
  importedCount: number;
}

interface StoredMigrationState {
  version: 1;
  sources: Partial<Record<EnvironmentMigrationSource, StoredMigrationResult>>;
}

export interface CodexSessionCandidate {
  sourcePath: string;
  destinationPath: string;
  cwd: string | null;
}

export interface CodexMigrationPlan {
  sessions: CodexSessionCandidate[];
}

export interface SessionMigrationResult {
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  projectPaths: string[];
}

export interface SessionProviderNormalizationResult {
  examinedCount: number;
  normalizedCount: number;
  failedCount: number;
}

export interface MigrationRunResult {
  source: EnvironmentMigrationSource;
  status: EnvironmentMigrationStatus | "failed";
  discoveredCount: number;
  importedCount: number;
}

type ExternalMigrationClient = Pick<AppServerClient, "start" | "stop" | "request" | "on" | "off">;

interface ExternalSessionMigration {
  cwd: string;
  path: string;
  title?: string | null;
}

interface ExternalMigrationItem {
  itemType: string;
  description: string;
  cwd?: string | null;
  details?: {
    sessions?: ExternalSessionMigration[];
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

interface ExternalMigrationSuccess {
  itemType: string;
  cwd?: string | null;
}

interface ExternalMigrationFailure {
  itemType: string;
  message: string;
}

interface ExternalMigrationTypeResult {
  itemType: string;
  successes: ExternalMigrationSuccess[];
  failures: ExternalMigrationFailure[];
}

interface ExternalMigrationCompleted {
  importId: string;
  itemTypeResults: ExternalMigrationTypeResult[];
}

interface ClaudeMigrationPlan {
  item: ExternalMigrationItem;
  sessionCount: number;
}

export interface FirstLaunchMigrationOptions {
  statePath: string;
  codexSourceHome: string;
  codexDestinationHome: string;
  createClaudeClient: () => ExternalMigrationClient;
  confirm: (source: EnvironmentMigrationSource, count: number) => Promise<boolean>;
  rememberProject: (projectPath: string) => void;
  onProgress?: (source: EnvironmentMigrationSource, active: boolean) => void;
  onError?: (source: EnvironmentMigrationSource, error: Error) => void | Promise<void>;
}

export class EnvironmentMigrationStateStore {
  private readonly state: StoredMigrationState;

  constructor(private readonly filePath: string) {
    this.state = readMigrationState(filePath);
  }

  isPending(source: EnvironmentMigrationSource): boolean {
    return !this.state.sources[source];
  }

  complete(
    source: EnvironmentMigrationSource,
    status: EnvironmentMigrationStatus,
    importedCount = 0,
  ): void {
    this.state.sources[source] = {
      status,
      completedAt: new Date().toISOString(),
      importedCount,
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, this.filePath);
  }
}

export function planCodexSessionMigration(
  sourceHome: string,
  destinationHome: string,
): CodexMigrationPlan {
  if (samePath(sourceHome, destinationHome)) return { sessions: [] };

  const sessions: CodexSessionCandidate[] = [];
  for (const directoryName of ["sessions", "archived_sessions"]) {
    const sourceRoot = path.join(sourceHome, directoryName);
    const destinationRoot = path.join(destinationHome, directoryName);
    for (const sourcePath of listJsonlFiles(sourceRoot)) {
      const relativePath = path.relative(sourceRoot, sourcePath);
      if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) continue;
      const destinationPath = path.join(destinationRoot, relativePath);
      if (fs.existsSync(destinationPath)) continue;
      const metadata = readCodexSessionMetadata(sourcePath);
      if (!metadata) continue;
      sessions.push({ sourcePath, destinationPath, cwd: metadata.cwd });
    }
  }
  return { sessions };
}

export function migrateCodexSessions(plan: CodexMigrationPlan): SessionMigrationResult {
  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const projectPaths = new Set<string>();

  for (const session of plan.sessions) {
    try {
      fs.mkdirSync(path.dirname(session.destinationPath), { recursive: true });
      copyCodexSession(session.sourcePath, session.destinationPath);
      const sourceStat = fs.statSync(session.sourcePath);
      fs.utimesSync(session.destinationPath, sourceStat.atime, sourceStat.mtime);
      importedCount += 1;
      if (session.cwd) projectPaths.add(session.cwd);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code || "")
        : "";
      if (code === "EEXIST") skippedCount += 1;
      else failedCount += 1;
    }
  }

  return { importedCount, skippedCount, failedCount, projectPaths: [...projectPaths] };
}

export function normalizeCodexSessionProviders(
  codexHome: string,
): SessionProviderNormalizationResult {
  let examinedCount = 0;
  let normalizedCount = 0;
  let failedCount = 0;

  for (const directoryName of ["sessions", "archived_sessions"]) {
    for (const filePath of listJsonlFiles(path.join(codexHome, directoryName))) {
      examinedCount += 1;
      try {
        if (normalizeCodexSessionProvider(filePath)) normalizedCount += 1;
      } catch {
        failedCount += 1;
      }
    }
  }

  return { examinedCount, normalizedCount, failedCount };
}

export async function runFirstLaunchEnvironmentMigrations(
  options: FirstLaunchMigrationOptions,
): Promise<MigrationRunResult[]> {
  const state = new EnvironmentMigrationStateStore(options.statePath);
  const results: MigrationRunResult[] = [];

  if (state.isPending("codex")) {
    const result = await runCodexMigration(state, options);
    results.push(result);
  }
  if (state.isPending("claude")) {
    const result = await runClaudeMigration(state, options);
    results.push(result);
  }

  return results;
}

async function runCodexMigration(
  state: EnvironmentMigrationStateStore,
  options: FirstLaunchMigrationOptions,
): Promise<MigrationRunResult> {
  try {
    const plan = planCodexSessionMigration(options.codexSourceHome, options.codexDestinationHome);
    const discoveredCount = plan.sessions.length;
    if (discoveredCount === 0) {
      state.complete("codex", "none");
      return { source: "codex", status: "none", discoveredCount, importedCount: 0 };
    }
    if (!await options.confirm("codex", discoveredCount)) {
      state.complete("codex", "skipped");
      return { source: "codex", status: "skipped", discoveredCount, importedCount: 0 };
    }

    options.onProgress?.("codex", true);
    let migration: SessionMigrationResult;
    try {
      migration = migrateCodexSessions(plan);
    } finally {
      options.onProgress?.("codex", false);
    }
    rememberProjects(options.rememberProject, migration.projectPaths);
    if (migration.failedCount > 0) {
      const error = new Error(`${migration.failedCount} Codex conversation(s) could not be copied.`);
      await options.onError?.("codex", error);
      return {
        source: "codex",
        status: "failed",
        discoveredCount,
        importedCount: migration.importedCount,
      };
    }
    state.complete("codex", "migrated", migration.importedCount);
    return {
      source: "codex",
      status: "migrated",
      discoveredCount,
      importedCount: migration.importedCount,
    };
  } catch (error) {
    const normalized = toError(error);
    await options.onError?.("codex", normalized);
    return { source: "codex", status: "failed", discoveredCount: 0, importedCount: 0 };
  }
}

async function runClaudeMigration(
  state: EnvironmentMigrationStateStore,
  options: FirstLaunchMigrationOptions,
): Promise<MigrationRunResult> {
  const client = options.createClaudeClient();
  try {
    await client.start({ codexHome: options.codexDestinationHome });
    const plan = await detectClaudeMigration(client);
    if (!plan) {
      state.complete("claude", "none");
      return { source: "claude", status: "none", discoveredCount: 0, importedCount: 0 };
    }
    if (!await options.confirm("claude", plan.sessionCount)) {
      state.complete("claude", "skipped");
      return {
        source: "claude",
        status: "skipped",
        discoveredCount: plan.sessionCount,
        importedCount: 0,
      };
    }

    options.onProgress?.("claude", true);
    let migration: SessionMigrationResult;
    try {
      migration = await importClaudeSessions(client, plan);
    } finally {
      options.onProgress?.("claude", false);
    }
    rememberProjects(options.rememberProject, migration.projectPaths);
    if (migration.failedCount > 0) {
      const error = new Error(`${migration.failedCount} Claude conversation(s) could not be imported.`);
      await options.onError?.("claude", error);
      return {
        source: "claude",
        status: "failed",
        discoveredCount: plan.sessionCount,
        importedCount: migration.importedCount,
      };
    }
    state.complete("claude", "migrated", migration.importedCount);
    return {
      source: "claude",
      status: "migrated",
      discoveredCount: plan.sessionCount,
      importedCount: migration.importedCount,
    };
  } catch (error) {
    const normalized = toError(error);
    await options.onError?.("claude", normalized);
    return { source: "claude", status: "failed", discoveredCount: 0, importedCount: 0 };
  } finally {
    client.stop();
  }
}

async function detectClaudeMigration(client: ExternalMigrationClient): Promise<ClaudeMigrationPlan | null> {
  const response = await client.request<{ items?: ExternalMigrationItem[] }>(
    "externalAgentConfig/detect",
    { includeHome: true, cwds: [] },
  );
  const item = (response.items || []).find((candidate) =>
    candidate.itemType === "SESSIONS" && (candidate.details?.sessions?.length || 0) > 0,
  );
  if (!item) return null;
  return { item, sessionCount: item.details?.sessions?.length || 0 };
}

async function importClaudeSessions(
  client: ExternalMigrationClient,
  plan: ClaudeMigrationPlan,
): Promise<SessionMigrationResult> {
  const waiter = createImportCompletionWaiter(client);
  try {
    const started = await client.request<{ importId: string }>("externalAgentConfig/import", {
      migrationItems: [plan.item],
      source: "claude",
    });
    const completed = await waiter.promise;
    if (completed.importId !== started.importId) {
      throw new Error("Claude conversation import returned an unexpected operation ID.");
    }
    const sessionResults = completed.itemTypeResults.filter((result) => result.itemType === "SESSIONS");
    const successes = sessionResults.flatMap((result) => result.successes);
    const failures = sessionResults.flatMap((result) => result.failures);
    return {
      importedCount: successes.length,
      skippedCount: 0,
      failedCount: failures.length,
      projectPaths: successes.flatMap((success) => success.cwd ? [success.cwd] : []),
    };
  } finally {
    waiter.cancel();
  }
}

function createImportCompletionWaiter(client: ExternalMigrationClient): {
  promise: Promise<ExternalMigrationCompleted>;
  cancel: () => void;
} {
  let timer: NodeJS.Timeout | undefined;
  let listener: ((message: unknown) => void) | undefined;
  const promise = new Promise<ExternalMigrationCompleted>((resolve, reject) => {
    listener = (rawMessage) => {
      if (!rawMessage || typeof rawMessage !== "object") return;
      const message = rawMessage as { method?: string; params?: unknown };
      if (message.method !== "externalAgentConfig/import/completed") return;
      const params = message.params as ExternalMigrationCompleted | undefined;
      if (!params || typeof params.importId !== "string" || !Array.isArray(params.itemTypeResults)) return;
      resolve(params);
    };
    client.on("message", listener);
    timer = setTimeout(() => reject(new Error("Claude conversation import timed out.")), 120_000);
  });

  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
      if (listener) client.off("message", listener);
    },
  };
}

function readMigrationState(filePath: string): StoredMigrationState {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<StoredMigrationState>;
    if (parsed.version === 1 && parsed.sources && typeof parsed.sources === "object") {
      return { version: 1, sources: parsed.sources };
    }
  } catch {
    // Missing or invalid state means this installation has not completed the migration check.
  }
  return { version: 1, sources: {} };
}

function listJsonlFiles(root: string): string[] {
  if (!isDirectory(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function readCodexSessionMetadata(filePath: string): { cwd: string | null } | null {
  const firstLine = readFirstJsonLine(filePath);
  if (!firstLine || firstLine.nextOffset >= fs.statSync(filePath).size) return null;
  const record = firstLine.value as {
    type?: string;
    payload?: { id?: string; session_id?: string; cwd?: string; source?: unknown };
  };
  if (record.type !== "session_meta" || !(record.payload?.id || record.payload?.session_id)) return null;
  const source = record.payload.source;
  if (typeof source === "string" && !new Set(["cli", "vscode", "appServer", "unknown"]).has(source)) {
    return null;
  }
  if (source && typeof source === "object") return null;
  return { cwd: typeof record.payload.cwd === "string" ? record.payload.cwd : null };
}

function copyCodexSession(sourcePath: string, destinationPath: string): void {
  let copied = false;
  let completed = false;
  try {
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    copied = true;
    normalizeCodexSessionProvider(destinationPath);
    completed = true;
  } finally {
    if (!completed && copied) fs.rmSync(destinationPath, { force: true });
  }
}

function normalizeCodexSessionProvider(filePath: string): boolean {
  const contents = fs.readFileSync(filePath, "utf8");
  const lines = contents.split("\n");
  let changed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const originalLine = lines[index]!;
    const hasCarriageReturn = originalLine.endsWith("\r");
    const line = (hasCarriageReturn ? originalLine.slice(0, -1) : originalLine)
      .replace(/^\uFEFF/, "");
    if (!line || (!line.includes("model_provider") && !line.includes("modelProvider"))) continue;

    const record = JSON.parse(line) as {
      type?: string;
      payload?: Record<string, unknown>;
    };
    if (!normalizeCodexProviderFields(record)) continue;
    lines[index] = `${JSON.stringify(record)}${hasCarriageReturn ? "\r" : ""}`;
    changed = true;
  }

  if (!changed) return false;

  const stat = fs.statSync(filePath);
  const temporaryPath = `${filePath}.provider-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, lines.join("\n"), { encoding: "utf8", mode: stat.mode });
    fs.utimesSync(temporaryPath, stat.atime, stat.mtime);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  return true;
}

function normalizeCodexProviderFields(record: {
  type?: string;
  payload?: Record<string, unknown>;
}): boolean {
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  let changed = false;
  if (record.type === "session_meta" && payload.model_provider !== "rhzy_gateway") {
    payload.model_provider = "rhzy_gateway";
    changed = true;
  }

  const threadSettings = payload.thread_settings;
  if (
    record.type === "event_msg"
    && payload.type === "thread_settings_applied"
    && threadSettings
    && typeof threadSettings === "object"
    && !Array.isArray(threadSettings)
    && "model_provider_id" in threadSettings
    && (threadSettings as Record<string, unknown>).model_provider_id !== "rhzy_gateway"
  ) {
    (threadSettings as Record<string, unknown>).model_provider_id = "rhzy_gateway";
    changed = true;
  }
  return changed;
}

function readFirstJsonLine(filePath: string): { value: unknown; nextOffset: number } | null {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    let fileOffset = 0;
    let nextOffset = 0;
    while (length < 1024 * 1024) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, fileOffset);
      if (bytesRead === 0) break;
      const value = chunk.subarray(0, bytesRead);
      const newline = value.indexOf(0x0a);
      chunks.push(newline >= 0 ? value.subarray(0, newline) : value);
      length += newline >= 0 ? newline : bytesRead;
      if (newline >= 0) {
        nextOffset = fileOffset + newline + 1;
        break;
      }
      fileOffset += bytesRead;
      nextOffset = fileOffset;
    }
    if (chunks.length === 0) return null;
    const firstLine = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").trim();
    if (!firstLine) return null;
    return { value: JSON.parse(firstLine), nextOffset };
  } catch {
    return null;
  } finally {
    fs.closeSync(descriptor);
  }
}

function rememberProjects(remember: (projectPath: string) => void, projectPaths: string[]): void {
  const seen = new Set<string>();
  for (const projectPath of projectPaths) {
    const key = process.platform === "win32" ? projectPath.toLowerCase() : projectPath;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      remember(projectPath);
    } catch {
      // Conversations remain available even when the original project directory was moved.
    }
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
