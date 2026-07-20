import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ProjectDirectory } from "@rhzycode/protocol";

export interface ProjectDirectoryState {
  paths: string[];
}

export type ProjectDirectoryErrorCode = "invalid" | "not_found" | "conflict" | "unavailable";

export class ProjectDirectoryError extends Error {
  constructor(readonly code: ProjectDirectoryErrorCode, message: string) {
    super(message);
    this.name = "ProjectDirectoryError";
  }
}

export class ProjectDirectoryRegistry extends EventEmitter {
  private readonly paths = new Map<string, string>();

  constructor(
    state?: ProjectDirectoryState | null,
    private readonly saveState?: (state: ProjectDirectoryState) => void,
  ) {
    super();
    for (const candidate of state?.paths || []) {
      try {
        const normalized = normalizeProjectPath(candidate);
        this.paths.set(comparablePath(normalized), normalized);
      } catch {
        continue;
      }
    }
  }

  list(): ProjectDirectory[] {
    return [...this.paths.values()]
      .filter(isDirectory)
      .map(toProjectDirectory)
      .sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
  }

  remember(input: string): ProjectDirectory {
    const normalized = normalizeProjectPath(input);
    if (!fs.existsSync(normalized)) {
      throw new ProjectDirectoryError("not_found", "The project directory does not exist on this computer.");
    }
    if (!isDirectory(normalized)) {
      throw new ProjectDirectoryError("conflict", "The project path points to a file, not a directory.");
    }
    this.add(normalized);
    return toProjectDirectory(normalized);
  }

  create(input: string): { project: ProjectDirectory; created: boolean } {
    const normalized = normalizeProjectPath(input);
    if (fs.existsSync(normalized)) {
      if (!isDirectory(normalized)) {
        throw new ProjectDirectoryError("conflict", "The project path points to a file, not a directory.");
      }
      this.add(normalized);
      return { project: toProjectDirectory(normalized), created: false };
    }
    try {
      fs.mkdirSync(normalized, { recursive: true });
    } catch {
      throw new ProjectDirectoryError("unavailable", "The project directory could not be created on this computer.");
    }
    this.add(normalized);
    return { project: toProjectDirectory(normalized), created: true };
  }

  forget(input: string): void {
    const normalized = normalizeProjectPath(input);
    const key = comparablePath(normalized);
    if (!this.paths.delete(key)) return;
    this.persist();
    this.emit("changed", this.list());
  }

  exportState(): ProjectDirectoryState {
    return { paths: [...this.paths.values()] };
  }

  private add(normalized: string): void {
    const key = comparablePath(normalized);
    if (this.paths.has(key)) return;
    this.paths.set(key, normalized);
    try {
      this.persist();
    } catch (error) {
      this.paths.delete(key);
      throw error;
    }
    this.emit("changed", this.list());
  }

  private persist(): void {
    this.saveState?.(this.exportState());
  }
}

export function normalizeProjectDirectoryState(value: unknown): ProjectDirectoryState | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.paths)) return null;
  const paths = input.paths
    .filter((candidate): candidate is string => typeof candidate === "string")
    .slice(0, 500);
  return { paths };
}

function normalizeProjectPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 32_768 || !path.isAbsolute(trimmed)) {
    throw new ProjectDirectoryError("invalid", "Enter an absolute project directory path from this computer.");
  }
  const normalized = path.resolve(trimmed);
  if (normalized === path.parse(normalized).root) {
    throw new ProjectDirectoryError("invalid", "A drive or filesystem root cannot be used as a project directory.");
  }
  return normalized;
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function toProjectDirectory(projectPath: string): ProjectDirectory {
  return { path: projectPath, name: path.basename(projectPath) };
}

function comparablePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
