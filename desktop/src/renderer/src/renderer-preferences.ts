import type { ApprovalPolicy, ReasoningEffort, SandboxMode } from "../../shared/desktop-api";
import { isSameProjectPath } from "./app-utils";

export type ThemeMode = "light" | "dark";
export type ThemePreset = "forest" | "studio" | "glass" | "noir" | "rose" | "ocean";

const MAX_PROJECT_ENTRIES = 50;
const THEME_PRESETS = new Set<ThemePreset>(["forest", "studio", "glass", "noir", "rose", "ocean"]);
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);

const keys = {
  approvalPolicy: "rhzycode.approvalPolicy",
  collapsedProjects: "rhzycode.collapsedProjects",
  forgottenProjects: "rhzycode.forgottenProjects",
  lastProject: "rhzycode.lastProject",
  lastThreads: "rhzycode.lastThreads",
  reasoningEffort: "rhzycode.reasoningEffort",
  recentProjects: "rhzycode.recentProjects",
  sandboxMode: "rhzycode.sandboxMode",
  selectedModel: "rhzycode.selectedModel",
  themeMode: "rhzycode.themeMode",
  themePreset: "rhzycode.themePreset",
} as const;

export function storedThemeMode(): ThemeMode {
  return read(keys.themeMode) === "light" ? "light" : "dark";
}

export function storeThemeMode(value: ThemeMode): void {
  write(keys.themeMode, value);
}

export function storedThemePreset(): ThemePreset {
  const value = read(keys.themePreset);
  return THEME_PRESETS.has(value as ThemePreset) ? value as ThemePreset : "forest";
}

export function storeThemePreset(value: ThemePreset): void {
  write(keys.themePreset, value);
}

export function storedApprovalPolicy(): ApprovalPolicy {
  const value = read(keys.approvalPolicy);
  return value === "untrusted" || value === "never" ? value : "on-request";
}

export function storeApprovalPolicy(value: ApprovalPolicy): void {
  write(keys.approvalPolicy, value);
}

export function storedSelectedModel(): string {
  return read(keys.selectedModel) || "";
}

export function storeSelectedModel(value: string): void {
  write(keys.selectedModel, value);
}

export function storedReasoningEffort(): ReasoningEffort {
  const value = read(keys.reasoningEffort);
  return REASONING_EFFORTS.has(value as ReasoningEffort) ? value as ReasoningEffort : "high";
}

export function storeReasoningEffort(value: ReasoningEffort): void {
  write(keys.reasoningEffort, value);
}

export function storedSandboxMode(): SandboxMode {
  const value = read(keys.sandboxMode);
  return value === "read-only" || value === "danger-full-access" ? value : "workspace-write";
}

export function storeSandboxMode(value: SandboxMode): void {
  write(keys.sandboxMode, value);
}

export function storedLastProject(): string {
  return read(keys.lastProject) || "";
}

export function storeLastProject(value: string): void {
  if (value) write(keys.lastProject, value);
  else remove(keys.lastProject);
}

export function storedLastThread(projectPath: string): string | null {
  const match = readLastThreadEntries().find(([path]) => isSameProjectPath(path, projectPath));
  return match?.[1] || null;
}

export function storeLastThread(projectPath: string, threadId: string): void {
  const entries = readLastThreadEntries()
    .filter(([path]) => !isSameProjectPath(path, projectPath));
  entries.push([projectPath, threadId]);
  write(keys.lastThreads, JSON.stringify(Object.fromEntries(entries.slice(-MAX_PROJECT_ENTRIES))));
}

export function removeStoredLastThread(projectPath: string): void {
  const raw = read(keys.lastThreads);
  if (!raw) return;
  const entries = parseLastThreadEntries(raw);
  if (!entries) {
    remove(keys.lastThreads);
    return;
  }
  const remaining = entries.filter(([path]) => !isSameProjectPath(path, projectPath));
  if (remaining.length) write(keys.lastThreads, JSON.stringify(Object.fromEntries(remaining)));
  else remove(keys.lastThreads);
}

export function storedRecentProjects(): string[] {
  return readProjectPaths(keys.recentProjects);
}

export function storeRecentProjects(paths: Iterable<string>): void {
  storeProjectPaths(keys.recentProjects, paths);
}

export function storedForgottenProjects(): string[] {
  return readProjectPaths(keys.forgottenProjects);
}

export function storeForgottenProjects(paths: Iterable<string>): void {
  storeProjectPaths(keys.forgottenProjects, paths);
}

export function storedCollapsedProjectPaths(): string[] {
  return readProjectPaths(keys.collapsedProjects);
}

export function storeCollapsedProjectPaths(paths: Iterable<string>): void {
  storeProjectPaths(keys.collapsedProjects, paths);
}

function readProjectPaths(key: string): string[] {
  const value = parseJson(read(key));
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    if (!paths.some((path) => isSameProjectPath(path, entry))) paths.push(entry);
  }
  return paths.slice(0, MAX_PROJECT_ENTRIES);
}

function storeProjectPaths(key: string, paths: Iterable<string>): void {
  const normalized: string[] = [];
  for (const path of paths) {
    if (!path.trim() || normalized.some((entry) => isSameProjectPath(entry, path))) continue;
    normalized.push(path);
    if (normalized.length === MAX_PROJECT_ENTRIES) break;
  }
  write(key, JSON.stringify(normalized));
}

function readLastThreadEntries(): Array<[string, string]> {
  return parseLastThreadEntries(read(keys.lastThreads)) || [];
}

function parseLastThreadEntries(raw: string | null): Array<[string, string]> | null {
  const value = parseJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.entries(value).filter((entry): entry is [string, string] => (
    Boolean(entry[0].trim()) && typeof entry[1] === "string" && Boolean(entry[1])
  ));
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are best-effort; the desktop must remain usable without web storage.
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Preferences are best-effort; the desktop must remain usable without web storage.
  }
}
