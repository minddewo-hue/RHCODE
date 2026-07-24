import type { ThreadSummary } from "@rhzycode/protocol";

export interface MobileProjectThreadGroup {
  key: string;
  path: string;
  threads: ThreadSummary[];
}

export function registeredProjectPaths(paths: string[]): string[] {
  const registered = new Map<string, string>();
  for (const projectPath of paths) {
    const trimmed = projectPath.trim();
    if (!trimmed) continue;
    const key = comparableProjectPath(trimmed);
    if (!registered.has(key)) registered.set(key, trimmed);
  }
  return [...registered.values()].slice(0, 50);
}

export function isRegisteredProject(projectPath: string, registeredPaths: string[]): boolean {
  return registeredPaths.some((candidate) => isSameProjectPath(candidate, projectPath));
}

export function isSameProjectPath(left: string, right: string): boolean {
  return comparableProjectPath(left) === comparableProjectPath(right);
}

export function filterThreadsInOrder(threads: ThreadSummary[], search: string): ThreadSummary[] {
  const term = search.trim().toLocaleLowerCase();
  return threads.filter((thread) =>
    !term || `${thread.title} ${thread.projectPath}`.toLocaleLowerCase().includes(term));
}

export function groupThreadsByProject(
  projectPaths: string[],
  threads: ThreadSummary[],
  search: string,
): MobileProjectThreadGroup[] {
  const term = search.trim().toLocaleLowerCase();
  return registeredProjectPaths(projectPaths).flatMap((projectPath) => {
    const key = projectPathKey(projectPath);
    const projectMatches = !term || `${projectName(projectPath)} ${projectPath}`.toLocaleLowerCase().includes(term);
    const projectThreads = threads
      .filter((thread) => projectPathKey(thread.projectPath) === key)
      .filter((thread) => projectMatches || `${thread.title} ${thread.model}`.toLocaleLowerCase().includes(term));
    if (term && !projectMatches && projectThreads.length === 0) return [];
    return [{ key, path: projectPath, threads: projectThreads }];
  });
}

export function projectPathKey(projectPath: string): string {
  return comparableProjectPath(projectPath);
}

function comparableProjectPath(projectPath: string): string {
  const normalized = projectPath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
}

function projectName(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) || projectPath;
}
