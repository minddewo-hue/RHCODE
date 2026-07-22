import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { SkillsManager } from "../src/main/skills-manager.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-skills-"));
  temporaryRoots.push(root);
  return root;
}

function createSkill(root: string, name: string, contents = "# Skill\n"): string {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), contents);
  return directory;
}

test("discovers only user skill directories in Codex and Claude roots", () => {
  const root = temporaryDirectory();
  const destination = path.join(root, "destination");
  const codex = path.join(root, "codex");
  const claude = path.join(root, "claude");
  createSkill(codex, "reviewer");
  createSkill(codex, ".system");
  fs.mkdirSync(path.join(codex, "missing-manifest"), { recursive: true });

  const manager = new SkillsManager(destination, { codex, claude });
  assert.deepEqual(manager.getSourceStatus(), {
    codex: { available: true, count: 1 },
    claude: { available: false, count: 0 },
  });
});

test("installs a local skill atomically and refuses to overwrite it", () => {
  const root = temporaryDirectory();
  const destination = path.join(root, "destination");
  const source = createSkill(path.join(root, "packages"), "release-notes", "# Release notes\n");
  fs.mkdirSync(path.join(source, "references"));
  fs.writeFileSync(path.join(source, "references", "format.md"), "format");
  const manager = new SkillsManager(destination, {
    codex: path.join(root, "codex"),
    claude: path.join(root, "claude"),
  });

  assert.equal(manager.install(source), "release-notes");
  assert.equal(
    fs.readFileSync(path.join(destination, "release-notes", "references", "format.md"), "utf8"),
    "format",
  );
  assert.throws(() => manager.install(source), /already installed/);
  assert.equal(
    fs.readdirSync(destination).some((entry) => entry.startsWith(".install-")),
    false,
  );
});

test("rejects a source that contains the managed destination", () => {
  const root = temporaryDirectory();
  const source = createSkill(root, "source");
  const destination = path.join(source, "managed-skills");
  const manager = new SkillsManager(destination, {
    codex: path.join(root, "codex"),
    claude: path.join(root, "claude"),
  });

  assert.throws(() => manager.install(source), /cannot contain the RHZYCODE skills directory/);
  assert.equal(fs.existsSync(destination), false);
});

test("imports available skills without replacing existing destinations", () => {
  const root = temporaryDirectory();
  const destination = path.join(root, "destination");
  const codex = path.join(root, "codex");
  createSkill(codex, "existing", "source");
  createSkill(codex, "new-skill", "new");
  createSkill(destination, "existing", "destination");
  const manager = new SkillsManager(destination, {
    codex,
    claude: path.join(root, "claude"),
  });

  assert.deepEqual(manager.import("codex"), {
    importedCount: 1,
    skippedCount: 1,
    failedCount: 0,
  });
  assert.equal(fs.readFileSync(path.join(destination, "existing", "SKILL.md"), "utf8"), "destination");
  assert.equal(fs.readFileSync(path.join(destination, "new-skill", "SKILL.md"), "utf8"), "new");
});

test("deletes only direct user skills from the managed destination", () => {
  const root = temporaryDirectory();
  const destination = path.join(root, "destination");
  const managed = createSkill(destination, "managed");
  const system = createSkill(destination, ".system");
  const outside = createSkill(path.join(root, "outside"), "external");
  const manager = new SkillsManager(destination, {
    codex: path.join(root, "codex"),
    claude: path.join(root, "claude"),
  });

  assert.equal(manager.canRemove(path.join(managed, "SKILL.md")), true);
  assert.equal(manager.canRemove(path.join(system, "SKILL.md")), false);
  assert.equal(manager.canRemove(path.join(outside, "SKILL.md")), false);
  assert.throws(() => manager.remove(path.join(outside, "SKILL.md")), /Only RHZYCODE user skills/);
  manager.remove(path.join(managed, "SKILL.md"));
  assert.equal(fs.existsSync(managed), false);
  assert.equal(fs.existsSync(system), true);
});
