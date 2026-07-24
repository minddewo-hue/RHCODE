import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  backupProjectConversations,
  deleteConversationSessionFiles,
  listConversationSessions,
  listProjectConversationThreadIds,
  restoreProjectConversations,
} from "../src/main/conversation-backup.js";

test("backs up active and archived project conversations and restores them", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-conversation-backup-"));
  const sourceHome = path.join(root, "source");
  const destinationHome = path.join(root, "destination");
  const projectPath = path.join(root, "project");
  const otherProject = path.join(root, "other-project");
  const backupPath = path.join(root, "project.rhzycode-backup");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeSession(path.join(sourceHome, "sessions", "2026", "07", "24", "rollout-active-id.jsonl"), "active-id", projectPath, "active");
  writeSession(path.join(sourceHome, "archived_sessions", "rollout-archived-id.jsonl"), "archived-id", projectPath, "archived");
  writeSession(path.join(sourceHome, "sessions", "rollout-other-id.jsonl"), "other-id", otherProject, "other");

  const backup = await backupProjectConversations(sourceHome, projectPath, backupPath);
  assert.equal(backup.conversationCount, 2);
  assert.equal(backup.filePath, backupPath);
  assert.ok(backup.size > 0);

  const restored = await restoreProjectConversations(destinationHome, backupPath);
  assert.deepEqual(restored, {
    filePath: backupPath,
    importedCount: 2,
    skippedCount: 0,
    projectPaths: [projectPath],
  });
  assert.match(findSession(destinationHome, "active-id"), /"text":"active"/);
  assert.match(findSession(destinationHome, "archived-id"), /"text":"archived"/);
  assert.equal(findOptionalSession(destinationHome, "other-id"), null);

  const sessions = await listConversationSessions(destinationHome);
  assert.deepEqual(
    sessions.map((session) => ({
      id: session.threadId,
      archived: session.archived,
      title: session.title,
      projectPath: session.projectPath,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    [
      { id: "active-id", archived: false, title: "active", projectPath },
      { id: "archived-id", archived: true, title: "archived", projectPath },
    ],
  );
});

test("skips a restored conversation when its thread id already exists", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-conversation-duplicate-"));
  const sourceHome = path.join(root, "source");
  const destinationHome = path.join(root, "destination");
  const projectPath = path.join(root, "project");
  const backupPath = path.join(root, "project.rhzycode-backup");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeSession(path.join(sourceHome, "sessions", "rollout-duplicate-id.jsonl"), "duplicate-id", projectPath, "backup");
  writeSession(path.join(destinationHome, "sessions", "rollout-duplicate-id.jsonl"), "duplicate-id", projectPath, "existing");
  await backupProjectConversations(sourceHome, projectPath, backupPath);

  const result = await restoreProjectConversations(destinationHome, backupPath);
  assert.equal(result.importedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.match(findSession(destinationHome, "duplicate-id"), /"text":"existing"/);
});

test("rejects damaged backups before restoring any conversation", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-conversation-damaged-"));
  const sourceHome = path.join(root, "source");
  const destinationHome = path.join(root, "destination");
  const projectPath = path.join(root, "project");
  const backupPath = path.join(root, "project.rhzycode-backup");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeSession(path.join(sourceHome, "sessions", "rollout-damaged-id.jsonl"), "damaged-id", projectPath, "original");
  await backupProjectConversations(sourceHome, projectPath, backupPath);
  const manifest = JSON.parse(gunzipSync(fs.readFileSync(backupPath)).toString("utf8"));
  manifest.sessions[0].content = Buffer.from("changed").toString("base64");
  fs.writeFileSync(backupPath, gzipSync(JSON.stringify(manifest)));

  await assert.rejects(
    restoreProjectConversations(destinationHome, backupPath),
    /invalid or damaged/,
  );
  assert.equal(findOptionalSession(destinationHome, "damaged-id"), null);
});

test("reports projects with no conversations instead of creating an empty backup", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-conversation-empty-"));
  const backupPath = path.join(root, "empty.rhzycode-backup");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    backupProjectConversations(path.join(root, "home"), path.join(root, "project"), backupPath),
    /No conversations were found/,
  );
  assert.equal(fs.existsSync(backupPath), false);
});

test("finds project conversations and permanently deletes active and archived files", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-conversation-delete-"));
  const codexHome = path.join(root, "home");
  const projectPath = path.join(root, "project");
  const otherProject = path.join(root, "other-project");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeSession(path.join(codexHome, "sessions", "rollout-active-id.jsonl"), "active-id", projectPath, "active");
  writeSession(path.join(codexHome, "archived_sessions", "rollout-archived-id.jsonl"), "archived-id", projectPath, "archived");
  writeSession(path.join(codexHome, "sessions", "rollout-other-id.jsonl"), "other-id", otherProject, "other");

  assert.deepEqual(
    new Set(await listProjectConversationThreadIds(codexHome, projectPath)),
    new Set(["active-id", "archived-id"]),
  );
  assert.equal(await deleteConversationSessionFiles(codexHome, ["active-id", "archived-id"]), 2);
  assert.equal(findOptionalSession(codexHome, "active-id"), null);
  assert.equal(findOptionalSession(codexHome, "archived-id"), null);
  assert.match(findSession(codexHome, "other-id"), /"text":"other"/);
});

test("deletes an empty rollout by its thread id suffix", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-empty-rollout-delete-"));
  const codexHome = path.join(root, "home");
  const rolloutPath = path.join(codexHome, "sessions", "rollout-empty-thread.jsonl");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
  fs.writeFileSync(rolloutPath, "", "utf8");

  assert.equal(await deleteConversationSessionFiles(codexHome, ["empty-thread"]), 1);
  assert.equal(fs.existsSync(rolloutPath), false);
});

function writeSession(filePath: string, id: string, cwd: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    JSON.stringify({
      timestamp: "2026-07-24T00:00:00.000Z",
      type: "session_meta",
      payload: { id, session_id: id, cwd, source: "appServer", model_provider: "rhzy_gateway" },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T00:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", text },
    }),
    "",
  ].join("\n"), "utf8");
}

function findSession(codexHome: string, id: string): string {
  const result = findOptionalSession(codexHome, id);
  assert.ok(result, `Expected session ${id}`);
  return result;
}

function findOptionalSession(codexHome: string, id: string): string | null {
  for (const directoryName of ["sessions", "archived_sessions"]) {
    const root = path.join(codexHome, directoryName);
    if (!fs.existsSync(root)) continue;
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (entry.isFile() && entry.name.endsWith(`-${id}.jsonl`)) {
          return fs.readFileSync(entryPath, "utf8");
        }
      }
    }
  }
  return null;
}
