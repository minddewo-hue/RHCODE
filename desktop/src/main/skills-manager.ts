import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  SkillImportSource,
  SkillSourceStatus,
} from "../shared/desktop-api";

const MAX_SKILL_FILES = 1_000;
const MAX_SKILL_BYTES = 100 * 1024 * 1024;

export interface SkillImportSummary {
  importedCount: number;
  skippedCount: number;
  failedCount: number;
}

export class SkillsManager {
  private readonly destinationRoot: string;
  private readonly sourceRoots: Record<SkillImportSource, string>;

  constructor(
    destinationRoot: string,
    sourceRoots: Record<SkillImportSource, string>,
  ) {
    this.destinationRoot = path.resolve(destinationRoot);
    this.sourceRoots = {
      codex: path.resolve(sourceRoots.codex),
      claude: path.resolve(sourceRoots.claude),
    };
  }

  getSourceStatus(): Record<SkillImportSource, SkillSourceStatus> {
    return {
      codex: this.inspectSource("codex"),
      claude: this.inspectSource("claude"),
    };
  }

  install(sourceDirectory: string): string {
    const source = validateSkillDirectory(sourceDirectory);
    const name = path.basename(source);
    if (name.startsWith(".")) throw new Error("Hidden or system skill directories cannot be installed.");
    if (isSameOrInside(this.destinationRoot, source)) {
      throw new Error("The skill source cannot contain the RHZYCODE skills directory.");
    }
    fs.mkdirSync(this.destinationRoot, { recursive: true });
    const destination = path.join(this.destinationRoot, name);
    if (fs.existsSync(destination)) throw new Error(`A skill named ${name} is already installed.`);
    this.copyAtomically(source, destination);
    return name;
  }

  import(source: SkillImportSource): SkillImportSummary {
    const sourceRoot = this.sourceRoots[source];
    const directories = listSkillDirectories(sourceRoot);
    const summary: SkillImportSummary = {
      importedCount: 0,
      skippedCount: 0,
      failedCount: 0,
    };
    fs.mkdirSync(this.destinationRoot, { recursive: true });

    for (const sourceDirectory of directories) {
      const destination = path.join(this.destinationRoot, path.basename(sourceDirectory));
      if (fs.existsSync(destination) || comparablePath(sourceDirectory) === comparablePath(destination)) {
        summary.skippedCount += 1;
        continue;
      }
      try {
        this.copyAtomically(sourceDirectory, destination);
        summary.importedCount += 1;
      } catch {
        summary.failedCount += 1;
      }
    }
    return summary;
  }

  canRemove(skillPath: string): boolean {
    if (!path.isAbsolute(skillPath) || path.basename(skillPath).toLowerCase() !== "skill.md") {
      return false;
    }
    const skillDirectory = path.dirname(path.resolve(skillPath));
    return comparablePath(path.dirname(skillDirectory)) === comparablePath(this.destinationRoot)
      && !path.basename(skillDirectory).startsWith(".");
  }

  remove(skillPath: string): void {
    if (!this.canRemove(skillPath)) throw new Error("Only RHZYCODE user skills can be deleted.");
    const skillDirectory = path.dirname(path.resolve(skillPath));
    const stat = fs.lstatSync(skillDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("The selected skill directory is invalid.");
    }
    fs.rmSync(skillDirectory, { recursive: true, force: false });
  }

  private inspectSource(source: SkillImportSource): SkillSourceStatus {
    const sourceRoot = this.sourceRoots[source];
    return {
      available: isDirectory(sourceRoot),
      count: listSkillDirectories(sourceRoot).length,
    };
  }

  private copyAtomically(source: string, destination: string): void {
    const staging = path.join(this.destinationRoot, `.install-${randomUUID()}`);
    try {
      copySkillDirectory(source, staging);
      fs.renameSync(staging, destination);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
}

function listSkillDirectories(root: string): string[] {
  if (!isDirectory(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."))
    .map((entry) => path.join(root, entry.name))
    .filter((candidate) => isRegularFile(path.join(candidate, "SKILL.md")))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

function validateSkillDirectory(input: string): string {
  if (!input.trim() || !path.isAbsolute(input) || input.includes("\0")) {
    throw new Error("Choose an absolute skill directory.");
  }
  const source = path.resolve(input);
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The selected path must be a regular directory.");
  }
  if (!isRegularFile(path.join(source, "SKILL.md"))) {
    throw new Error("The selected directory does not contain SKILL.md.");
  }
  return source;
}

function copySkillDirectory(source: string, destination: string): void {
  const limits = { files: 0, bytes: 0 };
  fs.mkdirSync(destination, { recursive: false });
  copyEntries(source, destination, limits);
}

function copyEntries(
  source: string,
  destination: string,
  limits: { files: number; bytes: number },
): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) throw new Error("Skill packages cannot contain symbolic links.");
    if (stat.isDirectory()) {
      fs.mkdirSync(destinationPath);
      copyEntries(sourcePath, destinationPath, limits);
      continue;
    }
    if (!stat.isFile()) throw new Error("Skill packages can contain only files and directories.");
    limits.files += 1;
    limits.bytes += stat.size;
    if (limits.files > MAX_SKILL_FILES || limits.bytes > MAX_SKILL_BYTES) {
      throw new Error("The skill package is too large.");
    }
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  }
}

function isDirectory(candidate: string): boolean {
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isRegularFile(candidate: string): boolean {
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function comparablePath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
