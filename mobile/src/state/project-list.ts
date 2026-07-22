export function registeredProjectPaths(paths: string[]): string[] {
  return [...new Set(paths.map((projectPath) => projectPath.trim()).filter(Boolean))].slice(0, 50);
}

export function isRegisteredProject(projectPath: string, registeredPaths: string[]): boolean {
  const normalized = projectPath.trim().toLocaleLowerCase();
  return registeredPaths.some((candidate) => candidate.trim().toLocaleLowerCase() === normalized);
}
