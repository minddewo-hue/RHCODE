import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  importClaudeConversations,
  importCodexConversations,
  migrateCodexSessions,
  normalizeCodexSessionProviders,
  normalizeCodexSessionProvidersOnce,
  planCodexSessionMigration,
  runFirstLaunchEnvironmentMigrations,
  type EnvironmentMigrationSource,
} from "../src/main/environment-migration.js";

test("copies valid Codex conversations without overwriting local sessions", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-codex-migration-"));
  const sourceHome = path.join(root, "source");
  const destinationHome = path.join(root, "destination");
  const project = path.join(root, "project");
  const active = path.join(sourceHome, "sessions", "2026", "07", "22", "rollout-active.jsonl");
  const archived = path.join(sourceHome, "archived_sessions", "rollout-archived.jsonl");
  const invalid = path.join(sourceHome, "sessions", "invalid.jsonl");
  const existingSource = path.join(sourceHome, "sessions", "rollout-existing.jsonl");
  const existingDestination = path.join(destinationHome, "sessions", "rollout-existing.jsonl");
  const execSession = path.join(sourceHome, "sessions", "rollout-exec.jsonl");
  const subagentSession = path.join(sourceHome, "sessions", "rollout-subagent.jsonl");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(project, { recursive: true });
  writeSession(active, "active-id", project);
  writeSession(archived, "archived-id", project);
  fs.mkdirSync(path.dirname(invalid), { recursive: true });
  fs.writeFileSync(invalid, "not-json\n", "utf8");
  writeSession(existingSource, "existing-id", project);
  writeSession(execSession, "exec-id", project, "exec");
  writeSession(subagentSession, "subagent-id", project, { subagent: "child" });
  fs.mkdirSync(path.dirname(existingDestination), { recursive: true });
  fs.writeFileSync(existingDestination, "keep-local\n", "utf8");

  const plan = planCodexSessionMigration(sourceHome, destinationHome);
  assert.equal(plan.sessions.length, 2);
  assert.equal(plan.skippedCount, 1);
  assert.deepEqual(new Set(plan.sessions.map((session) => session.cwd)), new Set([project]));

  const result = migrateCodexSessions(plan);
  assert.deepEqual(result, {
    importedCount: 2,
    skippedCount: 0,
    failedCount: 0,
    projectPaths: [project],
  });
  assert.equal(fs.readFileSync(existingDestination, "utf8"), "keep-local\n");
  assert.equal(fs.existsSync(path.join(destinationHome, "sessions", "2026", "07", "22", "rollout-active.jsonl")), true);
  assert.equal(fs.existsSync(path.join(destinationHome, "archived_sessions", "rollout-archived.jsonl")), true);
  const migratedMetadata = JSON.parse(
    fs.readFileSync(path.join(destinationHome, "sessions", "2026", "07", "22", "rollout-active.jsonl"), "utf8")
      .split("\n", 1)[0]!,
  ) as { payload: { model_provider: string } };
  assert.equal(migratedMetadata.payload.model_provider, "rhzy_gateway");
  assert.equal(afterFirstLine(
    fs.readFileSync(path.join(destinationHome, "sessions", "2026", "07", "22", "rollout-active.jsonl")),
  ).equals(afterFirstLine(fs.readFileSync(active))), true);
});

test("reports Codex conversations skipped by stable thread ID", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-codex-manual-import-"));
  const sourceHome = path.join(root, "source");
  const destinationHome = path.join(root, "destination");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeSession(path.join(sourceHome, "sessions", "new.jsonl"), "new-id", root);
  writeSession(path.join(sourceHome, "sessions", "duplicate.jsonl"), "existing-id", root);
  writeSession(path.join(destinationHome, "archived_sessions", "elsewhere.jsonl"), "existing-id", root);

  assert.deepEqual(importCodexConversations(sourceHome, destinationHome), {
    source: "codex",
    discoveredCount: 2,
    importedCount: 1,
    skippedCount: 1,
    failedCount: 0,
    projectPaths: [root],
  });
});

test("filters Claude sessions already recorded in the destination", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-claude-manual-import-"));
  const codexHome = path.join(root, "codex-home");
  const existingSource = path.join(root, "claude", "existing.jsonl");
  const newSource = path.join(root, "claude", "new.jsonl");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeSession(path.join(codexHome, "sessions", "existing.jsonl"), "imported-existing-id", root);
  fs.writeFileSync(path.join(codexHome, "external_agent_session_imports.json"), JSON.stringify({
    records: [{
      source_path: process.platform === "win32" ? `\\\\?\\${existingSource}` : existingSource,
      imported_thread_id: "imported-existing-id",
    }],
  }), "utf8");
  const importedPath = path.join(codexHome, "sessions", "new-import.jsonl");
  const client = new FilteringClaudeMigrationClient(existingSource, newSource, root, importedPath);

  assert.deepEqual(await importClaudeConversations(client, codexHome), {
    source: "claude",
    discoveredCount: 2,
    importedCount: 1,
    skippedCount: 1,
    failedCount: 0,
    projectPaths: [root],
  });
  assert.deepEqual(client.importedPaths, [newSource]);
  const importedMetadata = JSON.parse(fs.readFileSync(importedPath, "utf8").split("\n", 1)[0]!) as {
    payload: { model_provider: string };
  };
  assert.equal(importedMetadata.payload.model_provider, "rhzy_gateway");
});

test("normalizes imported provider metadata without changing conversation text", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-provider-normalization-"));
  const active = path.join(root, "sessions", "2026", "07", "22", "rollout-provider.jsonl");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(active), { recursive: true });
  fs.writeFileSync(active, [
    JSON.stringify({
      timestamp: "2026-07-22T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "provider-id", session_id: "provider-id", source: "vscode", model_provider: "openai" },
    }),
    JSON.stringify({
      timestamp: "2026-07-22T00:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: { model_provider_id: "OpenAI", model: "gpt-test" },
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-22T00:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: 'Keep model_provider = "OpenAI" unchanged.' }],
      },
    }),
    "",
  ].join("\n"), "utf8");

  assert.deepEqual(normalizeCodexSessionProviders(root), {
    examinedCount: 1,
    normalizedCount: 1,
    failedCount: 0,
  });
  const records = fs.readFileSync(active, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records[0].payload.model_provider, "rhzy_gateway");
  assert.equal(records[1].payload.thread_settings.model_provider_id, "rhzy_gateway");
  assert.equal(records[2].payload.content[0].text, 'Keep model_provider = "OpenAI" unchanged.');
  assert.deepEqual(normalizeCodexSessionProviders(root), {
    examinedCount: 1,
    normalizedCount: 0,
    failedCount: 0,
  });
});

test("normalizes session providers once for the current marker version", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-provider-normalization-once-"));
  const codexHome = path.join(root, "codex-home");
  const statePath = path.join(root, "state", "session-provider-normalization.json");
  const initialSession = path.join(codexHome, "sessions", "rollout-initial.jsonl");
  const laterSession = path.join(codexHome, "sessions", "rollout-later.jsonl");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeSession(initialSession, "initial-id", root);

  assert.deepEqual(normalizeCodexSessionProvidersOnce(codexHome, statePath), {
    examinedCount: 1,
    normalizedCount: 1,
    failedCount: 0,
  });
  const marker = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    version?: unknown;
    completedAt?: unknown;
  };
  assert.equal(marker.version, 1);
  assert.equal(typeof marker.completedAt, "string");
  assert.equal(Number.isFinite(Date.parse(String(marker.completedAt))), true);

  writeSession(laterSession, "later-id", root);
  assert.deepEqual(normalizeCodexSessionProvidersOnce(codexHome, statePath), {
    examinedCount: 0,
    normalizedCount: 0,
    failedCount: 0,
  });
  const laterMetadata = JSON.parse(fs.readFileSync(laterSession, "utf8").split("\n", 1)[0]!) as {
    payload: { model_provider: string };
  };
  assert.equal(laterMetadata.payload.model_provider, "OpenAI");
});

test("retries provider normalization after invalid markers and failed runs", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-provider-normalization-retry-"));
  const codexHome = path.join(root, "codex-home");
  const statePath = path.join(root, "state", "session-provider-normalization.json");
  const sessionPath = path.join(codexHome, "sessions", "rollout-retry.jsonl");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "not-json model_provider\n", "utf8");

  assert.deepEqual(normalizeCodexSessionProvidersOnce(codexHome, statePath), {
    examinedCount: 1,
    normalizedCount: 0,
    failedCount: 1,
  });
  assert.equal(fs.existsSync(statePath), false);

  writeSession(sessionPath, "retry-id", root);
  assert.deepEqual(normalizeCodexSessionProvidersOnce(codexHome, statePath), {
    examinedCount: 1,
    normalizedCount: 1,
    failedCount: 0,
  });
  assert.equal(
    (JSON.parse(fs.readFileSync(statePath, "utf8")) as { version: number }).version,
    1,
  );

  writeSession(sessionPath, "outdated-marker-id", root);
  fs.writeFileSync(statePath, JSON.stringify({ version: 0, completedAt: new Date().toISOString() }), "utf8");
  assert.equal(normalizeCodexSessionProvidersOnce(codexHome, statePath).normalizedCount, 1);

  writeSession(sessionPath, "invalid-marker-id", root);
  fs.writeFileSync(statePath, "not-json\n", "utf8");
  assert.equal(normalizeCodexSessionProvidersOnce(codexHome, statePath).normalizedCount, 1);
});

test("prompts for Codex and Claude separately and records the first-launch decision", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-first-launch-migration-"));
  const sourceHome = path.join(root, "source");
  const destinationHome = path.join(root, "destination");
  const codexProject = path.join(root, "codex-project");
  const claudeProject = path.join(root, "claude-project");
  const statePath = path.join(root, "state", "environment-migration.json");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(codexProject, { recursive: true });
  fs.mkdirSync(claudeProject, { recursive: true });
  writeSession(
    path.join(sourceHome, "sessions", "2026", "07", "22", "rollout-import.jsonl"),
    "import-id",
    codexProject,
  );

  const client = new FakeClaudeMigrationClient(claudeProject);
  const prompts: Array<{ source: EnvironmentMigrationSource; count: number }> = [];
  const remembered: string[] = [];
  const results = await runFirstLaunchEnvironmentMigrations({
    statePath,
    codexSourceHome: sourceHome,
    codexDestinationHome: destinationHome,
    createClaudeClient: () => client,
    confirm: async (source, count) => {
      prompts.push({ source, count });
      return true;
    },
    rememberProject: (projectPath) => remembered.push(projectPath),
  });

  assert.deepEqual(prompts, [
    { source: "codex", count: 1 },
    { source: "claude", count: 1 },
  ]);
  assert.deepEqual(results.map((result) => ({ source: result.source, status: result.status, imported: result.importedCount })), [
    { source: "codex", status: "migrated", imported: 1 },
    { source: "claude", status: "migrated", imported: 1 },
  ]);
  assert.deepEqual(new Set(remembered), new Set([codexProject, claudeProject]));
  assert.equal(client.stopped, true);

  const repeated = await runFirstLaunchEnvironmentMigrations({
    statePath,
    codexSourceHome: sourceHome,
    codexDestinationHome: destinationHome,
    createClaudeClient: () => {
      throw new Error("Claude detection should not run again.");
    },
    confirm: async () => {
      throw new Error("Completed sources should not prompt again.");
    },
    rememberProject: () => undefined,
  });
  assert.deepEqual(repeated, []);
});

class FakeClaudeMigrationClient extends EventEmitter {
  stopped = false;

  constructor(private readonly projectPath: string) {
    super();
  }

  async start(): Promise<void> {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
  }

  async request<T>(method: string): Promise<T> {
    if (method === "externalAgentConfig/detect") {
      return {
        items: [{
          itemType: "SESSIONS",
          description: "Claude sessions",
          details: {
            sessions: [{ cwd: this.projectPath, path: "claude-session.jsonl", title: "Imported" }],
          },
        }],
      } as T;
    }
    if (method === "externalAgentConfig/import") {
      queueMicrotask(() => this.emit("message", {
        method: "externalAgentConfig/import/completed",
        params: {
          importId: "import-1",
          itemTypeResults: [{
            itemType: "SESSIONS",
            successes: [{ itemType: "SESSIONS", cwd: this.projectPath }],
            failures: [],
          }],
        },
      }));
      return { importId: "import-1" } as T;
    }
    throw new Error(`Unexpected request: ${method}`);
  }
}

class FilteringClaudeMigrationClient extends EventEmitter {
  importedPaths: string[] = [];

  constructor(
    private readonly existingSource: string,
    private readonly newSource: string,
    private readonly projectPath: string,
    private readonly importedPath: string,
  ) {
    super();
  }

  async start(): Promise<void> {}

  stop(): void {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (method === "externalAgentConfig/detect") {
      return {
        items: [{
          itemType: "SESSIONS",
          description: "Claude sessions",
          details: {
            sessions: [
              { cwd: this.projectPath, path: this.existingSource, title: "Existing" },
              { cwd: this.projectPath, path: this.newSource, title: "New" },
            ],
          },
        }],
      } as T;
    }
    if (method === "externalAgentConfig/import") {
      const request = params as { migrationItems: Array<{ details?: { sessions?: ExternalSession[] } }> };
      this.importedPaths = request.migrationItems[0]?.details?.sessions?.map((session) => session.path) || [];
      writeSession(this.importedPath, "new-imported-id", this.projectPath);
      queueMicrotask(() => this.emit("message", {
        method: "externalAgentConfig/import/completed",
        params: {
          importId: "filtered-import",
          itemTypeResults: [{
            itemType: "SESSIONS",
            successes: [{ itemType: "SESSIONS", cwd: this.projectPath }],
            failures: [],
          }],
        },
      }));
      return { importId: "filtered-import" } as T;
    }
    throw new Error(`Unexpected request: ${method}`);
  }
}

interface ExternalSession {
  path: string;
}

function writeSession(filePath: string, id: string, cwd: string, source: unknown = "cli"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    JSON.stringify({
      timestamp: "2026-07-22T00:00:00.000Z",
      type: "session_meta",
      payload: { id, session_id: id, cwd, source, model_provider: "OpenAI" },
    }),
    JSON.stringify({
      timestamp: "2026-07-22T00:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    }),
    "",
  ].join("\n"), "utf8");
}

function afterFirstLine(value: Buffer): Buffer {
  const newline = value.indexOf(0x0a);
  return newline >= 0 ? value.subarray(newline + 1) : Buffer.alloc(0);
}
