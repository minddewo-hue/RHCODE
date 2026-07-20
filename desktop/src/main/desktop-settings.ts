import fs from "node:fs";
import path from "node:path";

export interface DesktopSettings {
  syncPort: number;
}

export class DesktopSettingsStore {
  constructor(private readonly filePath: string) {}

  load(fallbackPort: number): DesktopSettings {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
      if (isValidSyncPort(value.syncPort)) return { syncPort: value.syncPort };
    } catch {
      // Missing or invalid settings use the configured startup port.
    }
    return { syncPort: fallbackPort };
  }

  save(settings: DesktopSettings): void {
    if (!isValidSyncPort(settings.syncPort)) throw new Error("Sync port must be between 1 and 65535.");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}

export function isValidSyncPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}
