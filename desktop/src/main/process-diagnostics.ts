import fs from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { ProcessMetric } from "electron";

const DMI_IDENTITY_PATHS = [
  "/sys/class/dmi/id/sys_vendor",
  "/sys/class/dmi/id/product_name",
  "/sys/class/dmi/id/board_vendor",
];
const DEFAULT_RESOURCE_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const EVENT_LOOP_WATCHDOG_MS = 10_000;
const WINDOWS_HANDLE_PRESSURE_THRESHOLD = 10_000;
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
  handleCount: number | null;
  privateBytes: number | null;
  virtualBytes: number | null;
  fileDescriptors: FileDescriptorUsage;
}

export interface WindowsProcessResources {
  processes: Record<string, {
    handleCount: number | null;
    privateBytes: number | null;
    virtualBytes: number | null;
  }>;
  system?: {
    committedBytes: number | null;
    commitLimitBytes: number | null;
  };
}

export interface ProcessDiagnosticsOptions {
  paths: ProcessDiagnosticPaths;
  getAppMetrics?: () => ProcessMetric[];
  platform?: NodeJS.Platform;
  procRoot?: string;
  readWindowsProcessResources?: (pids: readonly number[])
    => Promise<WindowsProcessResources | null>;
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
  private readonly platform?: NodeJS.Platform;
  private readonly procRoot: string;
  private readonly readWindowsProcessResources: (pids: readonly number[])
    => Promise<WindowsProcessResources | null>;
  private readonly sampleIntervalMs: number;
  private readonly now: () => Date;
  private readonly canSampleProc: boolean;
  private processMetrics = new Map<number, ProcessMetric>();
  private sampleTimer: NodeJS.Timeout | null = null;
  private eventLoopWatchdogTimer: NodeJS.Timeout | null = null;
  private windowsResourceQueryInFlight = false;
  private writeFailureReported = false;

  constructor(options: ProcessDiagnosticsOptions) {
    this.paths = options.paths;
    this.getAppMetrics = options.getAppMetrics;
    this.platform = options.platform;
    this.procRoot = options.procRoot || "/proc";
    this.readWindowsProcessResources = options.readWindowsProcessResources
      || ((pids) => (this.platform === "win32"
        ? queryWindowsProcessResources(pids)
        : Promise.resolve(null)));
    this.sampleIntervalMs = options.sampleIntervalMs || DEFAULT_RESOURCE_SAMPLE_INTERVAL_MS;
    this.now = options.now || (() => new Date());
    this.canSampleProc = fs.existsSync(this.procRoot);
    try {
      fs.mkdirSync(this.paths.crashDumps, { recursive: true });
    } catch {
      // Recording remains best-effort when the configured user data path is read-only.
    }
  }

  async start(details: Record<string, unknown>): Promise<void> {
    this.record("diagnostics_started", {
      ...details,
      eventLog: this.paths.eventLog,
      crashDumps: this.paths.crashDumps,
      existingCrashDumps: listCrashDumps(this.paths.crashDumps),
    });
    if (!this.sampleTimer) {
      this.sampleTimer = setInterval(
        () => {
          void this.recordResourceSnapshot("periodic");
          this.probeEventLoopLag();
        },
        this.sampleIntervalMs,
      );
      this.sampleTimer.unref();
    }
    await this.recordResourceSnapshot("startup");
    this.probeEventLoopLag();
  }

  stop(): void {
    if (!this.sampleTimer) return;
    clearInterval(this.sampleTimer);
    this.sampleTimer = null;
    if (this.eventLoopWatchdogTimer) {
      clearTimeout(this.eventLoopWatchdogTimer);
      this.eventLoopWatchdogTimer = null;
    }
  }

  recordProcessGone(kind: "renderer" | "child", details: Record<string, unknown>): void {
    const resources = this.captureResources(true);
    this.record(`${kind}_process_gone`, { ...details, resources });
    void this.recordWindowsResourceSnapshot(`${kind}_process_gone`, resources.processes);
    console.error(
      `[Diagnostics] ${kind} process gone; details written to ${this.paths.eventLog}`,
    );
  }

  async recordResourceSnapshot(
    trigger: "startup" | "renderer-ready" | "periodic" | "shutdown" | "manual",
  ): Promise<void> {
    // Avoid polling Electron's process monitor during periodic Windows sampling.
    // Windows resource data is collected independently; reusing the cached
    // process inventory prevents Chromium handle growth in the main process.
    const refreshProcessInventory = trigger !== "periodic" || (this.platform !== "win32" && !this.canSampleProc);
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
    await this.recordWindowsResourceSnapshot(trigger, resources.processes);
  }

  recordRendererResponsiveness(
    state: "unresponsive" | "responsive",
    details: Record<string, unknown>,
  ): void {
    this.record(`renderer_${state}`, details);
  }

  recordRelayForwardFailure(details: {
    method: string;
    path: string;
    localOrigin: string;
    errorName: string;
    errorCode: string | null;
    errorMessage: string;
    timedOut: boolean;
  }): void {
    this.record("relay_forward_failed", details);
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
          handleCount: null,
          privateBytes: null,
          virtualBytes: null,
          fileDescriptors: readFileDescriptorUsage(metric.pid, this.procRoot),
        };
      }),
    };
  }

  private async recordWindowsResourceSnapshot(
    trigger: string,
    processes: readonly DiagnosticProcessMetric[],
  ): Promise<void> {
    if (this.platform !== "win32" || this.windowsResourceQueryInFlight) return;
    this.windowsResourceQueryInFlight = true;
    try {
      const windows = await this.readWindowsProcessResources(
        processes.map((process) => process.pid),
      );
      if (!windows) return;
      this.record("windows_resource_snapshot", { trigger, ...windows });
      const pressured = Object.entries(windows.processes)
        .filter(([, value]) => (value.handleCount ?? 0) >= WINDOWS_HANDLE_PRESSURE_THRESHOLD)
        .map(([pid, value]) => ({ pid: Number(pid), ...value }));
      if (pressured.length > 0) {
        this.record("windows_handle_pressure", {
          trigger,
          threshold: WINDOWS_HANDLE_PRESSURE_THRESHOLD,
          processes: pressured,
        });
        console.warn(
          `[Diagnostics] Windows process handle count reached ${WINDOWS_HANDLE_PRESSURE_THRESHOLD}; details written to ${this.paths.eventLog}`,
        );
      }
    } catch {
      // Windows metadata is supplementary and must not affect application diagnostics.
    } finally {
      this.windowsResourceQueryInFlight = false;
    }
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

  private probeEventLoopLag(): void {
    const scheduledAt = process.hrtime.bigint();
    const watchdog = setTimeout(() => {
      this.eventLoopWatchdogTimer = null;
      this.record("event_loop_watchdog_fired", { thresholdMs: EVENT_LOOP_WATCHDOG_MS });
    }, EVENT_LOOP_WATCHDOG_MS);
    watchdog.unref();
    this.eventLoopWatchdogTimer = watchdog;
    setImmediate(() => {
      clearTimeout(watchdog);
      if (this.eventLoopWatchdogTimer === watchdog) this.eventLoopWatchdogTimer = null;
      const lagMs = Number(process.hrtime.bigint() - scheduledAt) / 1_000_000;
      if (lagMs >= 500) this.record("event_loop_lag", { durationMilliseconds: lagMs });
    });
  }
}

export function parseWindowsProcessResources(value: string): WindowsProcessResources | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const source = parsed as {
    processes?: Record<string, unknown>;
    system?: Record<string, unknown>;
  };
  if (typeof source.processes !== "object" || source.processes === null) return null;
  const processes: WindowsProcessResources["processes"] = {};
  for (const [pid, value] of Object.entries(source.processes)) {
    if (typeof value !== "object" || value === null) continue;
    const metric = value as Record<string, unknown>;
    processes[pid] = {
      handleCount: parseNullableFiniteNumber(metric.handleCount),
      privateBytes: parseNullableFiniteNumber(metric.privateBytes),
      virtualBytes: parseNullableFiniteNumber(metric.virtualBytes),
    };
  }
  return {
    processes,
    ...(source.system ? {
      system: {
        committedBytes: parseNullableFiniteNumber(source.system.committedBytes),
        commitLimitBytes: parseNullableFiniteNumber(source.system.commitLimitBytes),
      },
    } : {}),
  };
}

function parseNullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function queryWindowsProcessResources(
  pids: readonly number[],
): Promise<WindowsProcessResources | null> {
  const uniquePids = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (uniquePids.length === 0) return Promise.resolve(null);
  const idList = uniquePids.join(",");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$resources = @{}",
    `foreach ($id in @(${idList})) {`,
    "  $process = Get-Process -Id $id -ErrorAction SilentlyContinue",
    "  if ($process) { $resources[[string]$id] = @{ handleCount = $process.HandleCount; privateBytes = $process.PrivateMemorySize64; virtualBytes = $process.VirtualMemorySize64 } }",
    "}",
    "$os = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1",
    "$committed = if ($os) { ($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) * 1KB } else { $null }",
    "$limit = if ($os) { $os.TotalVirtualMemorySize * 1KB } else { $null }",
    "[pscustomobject]@{ processes = $resources; system = @{ committedBytes = $committed; commitLimitBytes = $limit } } | ConvertTo-Json -Depth 4 -Compress",
  ].join("\n");
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    const timeout = setTimeout(() => child.kill(), 10_000);
    const finish = (result: WindowsProcessResources | null) => {
      clearTimeout(timeout);
      resolve(result);
    };
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      finish(code === 0 ? parseWindowsProcessResources(stdout) : null);
    });
  });
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
