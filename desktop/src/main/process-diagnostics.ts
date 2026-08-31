import fs from "node:fs";
import { dirname, join } from "node:path";
import type { ProcessMetric } from "electron";

const DMI_IDENTITY_PATHS = [
  "/sys/class/dmi/id/sys_vendor",
  "/sys/class/dmi/id/product_name",
  "/sys/class/dmi/id/board_vendor",
];
const DEFAULT_RESOURCE_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_CRASH_DUMPS_IN_INVENTORY = 20;

export interface ProcessDiagnosticPaths {
  directory: string;
  eventLog: string;
  crashDumps: string;
}

interface FileDescriptorUsage {
  count: number | null;
  softLimit: number | null;
  hardLimit: number | null;
  utilization: number | null;
}

interface DiagnosticProcessMetric {
  pid: number;
  type: ProcessMetric["type"];
  name?: string;
  serviceName?: string;
  cpuPercent: number | null;
  workingSetSizeKb: number;
  peakWorkingSetSizeKb: number;
  fileDescriptors: FileDescriptorUsage;
}

export interface ProcessDiagnosticsOptions {
  paths: ProcessDiagnosticPaths;
  getAppMetrics?: () => ProcessMetric[];
  procRoot?: string;
  sampleIntervalMs?: number;
  now?: () => Date;
}

export function processDiagnosticPaths(userDataDirectory: string): ProcessDiagnosticPaths {
  const directory = join(userDataDirectory, "diagnostics");
  return {
    directory,
    eventLog: join(directory, "process-events.jsonl"),
    crashDumps: join(directory, "crash-dumps"),
  };
}

export function readLinuxHostIdentity(
  platform: NodeJS.Platform = process.platform,
  paths: readonly string[] = DMI_IDENTITY_PATHS,
): string {
  if (platform !== "linux") return "";
  return paths.flatMap((path) => {
    try {
      const value = fs.readFileSync(path, "utf8").trim();
      return value ? [value] : [];
    } catch {
      return [];
    }
  }).join(" ");
}

export function parseOpenFileLimits(value: string): { softLimit: number; hardLimit: number } | null {
  const line = value.split(/\r?\n/).find((candidate) => candidate.startsWith("Max open files"));
  if (!line) return null;
  const match = /^Max open files\s+(\d+)\s+(\d+)\s+files\s*$/.exec(line);
  if (!match) return null;
  return { softLimit: Number(match[1]), hardLimit: Number(match[2]) };
}

export class ProcessDiagnostics {
  private readonly paths: ProcessDiagnosticPaths;
  private readonly getAppMetrics?: () => ProcessMetric[];
  private readonly procRoot: string;
  private readonly sampleIntervalMs: number;
  private readonly now: () => Date;
  private readonly canSampleProc: boolean;
  private processMetrics = new Map<number, ProcessMetric>();
  private sampleTimer: NodeJS.Timeout | null = null;
  private writeFailureReported = false;

  constructor(options: ProcessDiagnosticsOptions) {
    this.paths = options.paths;
    this.getAppMetrics = options.getAppMetrics;
    this.procRoot = options.procRoot || "/proc";
    this.sampleIntervalMs = options.sampleIntervalMs || DEFAULT_RESOURCE_SAMPLE_INTERVAL_MS;
    this.now = options.now || (() => new Date());
    this.canSampleProc = fs.existsSync(this.procRoot);
    try {
      fs.mkdirSync(this.paths.crashDumps, { recursive: true });
    } catch {
      // Recording remains best-effort when the configured user data path is read-only.
    }
  }

  start(details: Record<string, unknown>): void {
    this.record("diagnostics_started", {
      ...details,
      eventLog: this.paths.eventLog,
      crashDumps: this.paths.crashDumps,
      existingCrashDumps: listCrashDumps(this.paths.crashDumps),
    });
    this.recordResourceSnapshot("startup");
    if (this.sampleTimer) return;
    this.sampleTimer = setInterval(
      () => this.recordResourceSnapshot("periodic"),
      this.sampleIntervalMs,
    );
    this.sampleTimer.unref();
  }

  stop(): void {
    if (!this.sampleTimer) return;
    clearInterval(this.sampleTimer);
    this.sampleTimer = null;
  }

  recordProcessGone(kind: "renderer" | "child", details: Record<string, unknown>): void {
    const resources = this.captureResources(true);
    this.record(`${kind}_process_gone`, { ...details, resources });
    console.error(
      `[Diagnostics] ${kind} process gone; details written to ${this.paths.eventLog}`,
    );
  }

  recordResourceSnapshot(
    trigger: "startup" | "renderer-ready" | "periodic" | "shutdown" | "manual",
  ): void {
    // Avoid polling Electron's process monitor. On Linux, repeated refreshes can
    // retain Chromium shared-memory handles; procfs still supplies fresh RSS/FD data.
    const refreshProcessInventory = trigger !== "periodic" || !this.canSampleProc;
    const resources = this.captureResources(refreshProcessInventory);
    this.record("resource_snapshot", { trigger, resources });
    const pressured = resources.processes.filter((metric) =>
      metric.fileDescriptors.utilization !== null && metric.fileDescriptors.utilization >= 0.75);
    if (pressured.length > 0) {
      this.record("file_descriptor_pressure", { trigger, processes: pressured });
      console.warn(
        `[Diagnostics] File descriptor utilization is at least 75%; details written to ${this.paths.eventLog}`,
      );
    }
  }

  private captureResources(refreshProcessInventory: boolean): {
    uptimeSeconds: number;
    mainMemory: NodeJS.MemoryUsage;
    processes: DiagnosticProcessMetric[];
  } {
    if (refreshProcessInventory) {
      try {
        const metrics = this.getAppMetrics?.() || [];
        if (metrics.length > 0) {
          this.processMetrics = new Map(metrics.map((metric) => [metric.pid, metric]));
        }
      } catch {
        // Metrics can be unavailable during early startup or process teardown.
      }
    }
    if (!this.processMetrics.has(process.pid)) {
      const memory = process.memoryUsage();
      this.processMetrics.set(process.pid, {
        pid: process.pid,
        type: "Browser",
        creationTime: Date.now() - process.uptime() * 1000,
        cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
        memory: {
          workingSetSize: Math.round(memory.rss / 1024),
          peakWorkingSetSize: Math.round(memory.rss / 1024),
        },
      });
    }
    const metrics = [...this.processMetrics.values()];
    return {
      uptimeSeconds: Math.round(process.uptime()),
      mainMemory: process.memoryUsage(),
      processes: metrics.map((metric) => {
        const procMemory = readProcMemoryUsage(metric.pid, this.procRoot);
        return {
          pid: metric.pid,
          type: metric.type,
          ...(metric.name ? { name: metric.name } : {}),
          ...(metric.serviceName ? { serviceName: metric.serviceName } : {}),
          cpuPercent: refreshProcessInventory ? metric.cpu.percentCPUUsage : null,
          workingSetSizeKb: procMemory?.workingSetSizeKb ?? metric.memory.workingSetSize,
          peakWorkingSetSizeKb: procMemory?.peakWorkingSetSizeKb
            ?? metric.memory.peakWorkingSetSize,
          fileDescriptors: readFileDescriptorUsage(metric.pid, this.procRoot),
        };
      }),
    };
  }

  private record(event: string, details: Record<string, unknown>): void {
    try {
      fs.mkdirSync(dirname(this.paths.eventLog), { recursive: true });
      fs.appendFileSync(this.paths.eventLog, `${JSON.stringify({
        time: this.now().toISOString(),
        event,
        pid: process.pid,
        ...details,
      })}\n`, "utf8");
    } catch (error) {
      if (this.writeFailureReported) return;
      this.writeFailureReported = true;
      console.error(`[Diagnostics] Could not write process diagnostics: ${String(error)}`);
    }
  }
}

function readFileDescriptorUsage(pid: number, procRoot: string): FileDescriptorUsage {
  let count: number | null = null;
  let limits: { softLimit: number; hardLimit: number } | null = null;
  try {
    count = fs.readdirSync(join(procRoot, String(pid), "fd")).length;
  } catch {
    // /proc is Linux-specific and a child can exit while metrics are collected.
  }
  try {
    limits = parseOpenFileLimits(
      fs.readFileSync(join(procRoot, String(pid), "limits"), "utf8"),
    );
  } catch {
    // Limits are unavailable off Linux or after the process exits.
  }
  return {
    count,
    softLimit: limits?.softLimit ?? null,
    hardLimit: limits?.hardLimit ?? null,
    utilization: count !== null && limits?.softLimit
      ? Number((count / limits.softLimit).toFixed(4))
      : null,
  };
}

export function parseProcMemoryStatus(value: string): {
  workingSetSizeKb: number;
  peakWorkingSetSizeKb: number;
} | null {
  const workingSetSizeKb = parseProcStatusKilobytes(value, "VmRSS");
  if (workingSetSizeKb === null) return null;
  return {
    workingSetSizeKb,
    peakWorkingSetSizeKb: parseProcStatusKilobytes(value, "VmHWM") ?? workingSetSizeKb,
  };
}

function parseProcStatusKilobytes(value: string, field: string): number | null {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "m").exec(value);
  return match ? Number(match[1]) : null;
}

function readProcMemoryUsage(pid: number, procRoot: string): {
  workingSetSizeKb: number;
  peakWorkingSetSizeKb: number;
} | null {
  try {
    return parseProcMemoryStatus(
      fs.readFileSync(join(procRoot, String(pid), "status"), "utf8"),
    );
  } catch {
    return null;
  }
}

function listCrashDumps(directory: string): Array<{ path: string; size: number; modifiedAt: string }> {
  const dumps: Array<{ path: string; size: number; modifiedAt: string }> = [];
  const pending = [directory];
  while (pending.length > 0 && dumps.length < MAX_CRASH_DUMPS_IN_INVENTORY) {
    const current = pending.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".dmp")) {
        try {
          const stat = fs.statSync(path);
          dumps.push({ path, size: stat.size, modifiedAt: stat.mtime.toISOString() });
        } catch {
          // A dump can be moved by Crashpad while the inventory is collected.
        }
      }
      if (dumps.length >= MAX_CRASH_DUMPS_IN_INVENTORY) break;
    }
  }
  return dumps.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}
