import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  migrateCodexSessions,
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
