import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProcessMetric } from "electron";
import {
  ProcessDiagnostics,
  parseOpenFileLimits,
  parseProcMemoryStatus,
  parseWindowsProcessResources,
  processDiagnosticPaths,
  readLinuxHostIdentity,
} from "../src/main/process-diagnostics.js";

test("reads Linux DMI identity without failing on missing fields", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-dmi-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vendor = path.join(root, "sys_vendor");
  const product = path.join(root, "product_name");
  fs.writeFileSync(vendor, "VMware, Inc.\n");
  fs.writeFileSync(product, "VMware Virtual Platform\n");

  assert.equal(
    readLinuxHostIdentity("linux", [vendor, product, path.join(root, "missing")]),
    "VMware, Inc. VMware Virtual Platform",
  );
  assert.equal(readLinuxHostIdentity("win32", [vendor]), "");
});

test("parses Linux open file limits", () => {
  assert.deepEqual(parseOpenFileLimits([
    "Limit                     Soft Limit           Hard Limit           Units",
    "Max open files            1024                 1048576              files",
  ].join("\n")), { softLimit: 1024, hardLimit: 1048576 });
  assert.equal(parseOpenFileLimits("Max processes 100 100 processes"), null);
});

test("parses Linux process resident memory", () => {
  assert.deepEqual(parseProcMemoryStatus([
    "Name:\telectron",
    "VmHWM:\t  256000 kB",
    "VmRSS:\t  128000 kB",
  ].join("\n")), {
    workingSetSizeKb: 128000,
    peakWorkingSetSizeKb: 256000,
  });
  assert.equal(parseProcMemoryStatus("Name:\telectron"), null);
});

test("parses Windows process handles and system commit metrics", () => {
  assert.deepEqual(parseWindowsProcessResources([
    "{\"processes\":{\"40908\":{\"handleCount\":17777,\"privateBytes\":536870912,",
    "\"virtualBytes\":1073741824}},\"system\":{\"committedBytes\":46386606080,",
    "\"commitLimitBytes\":75598614528}}",
  ].join("")), {
    processes: {
      40908: { handleCount: 17777, privateBytes: 536870912, virtualBytes: 1073741824 },
    },
    system: { committedBytes: 46386606080, commitLimitBytes: 75598614528 },
  });
  assert.equal(parseWindowsProcessResources("not-json"), null);
});

test("persists resource, process-gone, and crash dump inventory records", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-diagnostics-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = processDiagnosticPaths(path.join(root, "user-data"));
  const procRoot = path.join(root, "proc");
  const childPid = 4242;
  createProcessFixture(procRoot, process.pid, 4, 1024);
  createProcessFixture(procRoot, childPid, 3, 256);

  const metric: ProcessMetric = {
    pid: childPid,
    type: "Utility",
    name: "Network Service",
    creationTime: Date.now(),
    cpu: { percentCPUUsage: 1.5, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize: 128, peakWorkingSetSize: 256 },
  };
  const diagnostics = new ProcessDiagnostics({
    paths,
    procRoot,
    getAppMetrics: () => [metric],
    sampleIntervalMs: 60_000,
    now: () => new Date("2026-08-26T07:30:00.000Z"),
  });
  const dump = path.join(paths.crashDumps, "pending", "renderer.dmp");
  fs.mkdirSync(path.dirname(dump), { recursive: true });
  fs.writeFileSync(dump, "dump");

  diagnostics.start({ crashReporterStarted: true });
  diagnostics.recordProcessGone("child", {
    type: "GPU",
    reason: "crashed",
    exitCode: 5,
  });
  diagnostics.recordRendererResponsiveness("responsive", { webContentsId: 17 });
  diagnostics.stop();

  const records = fs.readFileSync(paths.eventLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, any>);
  assert.deepEqual(records.map((record) => record.event), [
    "diagnostics_started",
    "resource_snapshot",
    "child_process_gone",
    "renderer_responsive",
  ]);
  assert.equal(records[0].existingCrashDumps[0].path, dump);
  const processes = records[1].resources.processes as Array<Record<string, any>>;
  assert.equal(processes.find((process) => process.pid === childPid)?.fileDescriptors.count, 3);
  assert.equal(processes.find((process) => process.pid === childPid)?.fileDescriptors.softLimit, 256);
  assert.equal(records[2].reason, "crashed");
  assert.equal(records[2].exitCode, 5);
  assert.equal(records[3].webContentsId, 17);
});

test("does not refresh Electron metrics during periodic Windows sampling", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-diagnostics-windows-periodic-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = processDiagnosticPaths(path.join(root, "user-data"));
  let metricReads = 0;
  const diagnostics = new ProcessDiagnostics({
    paths,
    platform: "win32",
    procRoot: path.join(root, "missing-proc"),
    getAppMetrics: () => {
      metricReads += 1;
      return [{
        pid: process.pid,
        type: "Browser",
        creationTime: Date.now(),
        cpu: { percentCPUUsage: 1, idleWakeupsPerSecond: 0 },
        memory: { workingSetSize: 128, peakWorkingSetSize: 256 },
      }];
    },
    readWindowsProcessResources: async () => ({
      processes: {
        [String(process.pid)]: {
          handleCount: 100,
          privateBytes: 200,
          virtualBytes: 300,
        },
      },
    }),
  });

  await diagnostics.start({});
  await diagnostics.recordResourceSnapshot("periodic");
  await diagnostics.recordResourceSnapshot("periodic");
  diagnostics.stop();

  assert.equal(metricReads, 1);
  const records = fs.readFileSync(paths.eventLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, any>);
  assert.equal(records.filter((record) => record.event === "windows_resource_snapshot").length, 3);
});

test("records Windows handles, private memory, and commit pressure", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-diagnostics-windows-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = processDiagnosticPaths(path.join(root, "user-data"));
  const diagnostics = new ProcessDiagnostics({
    paths,
    platform: "win32",
    getAppMetrics: () => [],
    readWindowsProcessResources: async (pids) => {
      if (!pids.includes(process.pid)) return null;
      return {
        processes: {
          [String(process.pid)]: {
            handleCount: 1370,
            privateBytes: 152530944,
            virtualBytes: 220200960,
          },
        },
        system: { committedBytes: 46386606080, commitLimitBytes: 75598614528 },
      };
    },
    sampleIntervalMs: 60_000,
  });

  await diagnostics.start({});
  diagnostics.stop();
  const records = fs.readFileSync(paths.eventLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, any>);
  const resource = records.find((candidate) => candidate.event === "resource_snapshot");
  const windows = records.find((candidate) => candidate.event === "windows_resource_snapshot");
  const main = (resource.resources.processes as Array<Record<string, any>>)[0];
  assert.equal(main.handleCount, null);
  assert.equal(windows.processes[String(process.pid)].handleCount, 1370);
  assert.equal(windows.processes[String(process.pid)].privateBytes, 152530944);
  assert.equal(windows.processes[String(process.pid)].virtualBytes, 220200960);
  assert.deepEqual(windows.system, {
    committedBytes: 46386606080,
    commitLimitBytes: 75598614528,
  });
});

test("keeps diagnostics best-effort when its directory is not writable", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-diagnostics-readonly-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blockingFile = path.join(root, "not-a-directory");
  fs.writeFileSync(blockingFile, "blocked");
  const paths = {
    directory: blockingFile,
    eventLog: path.join(blockingFile, "process-events.jsonl"),
    crashDumps: path.join(blockingFile, "crash-dumps"),
  };

  const diagnostics = new ProcessDiagnostics({ paths, sampleIntervalMs: 60_000 });
  assert.doesNotThrow(() => diagnostics.start({ crashReporterStarted: false }));
  diagnostics.stop();
  assert.equal(fs.readFileSync(blockingFile, "utf8"), "blocked");
});

test("does not refresh Electron metrics during periodic procfs sampling", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-diagnostics-periodic-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = processDiagnosticPaths(path.join(root, "user-data"));
  const procRoot = path.join(root, "proc");
  createProcessFixture(procRoot, process.pid, 4, 1024, 300, 500);
  let metricReads = 0;
  const diagnostics = new ProcessDiagnostics({
    paths,
    procRoot,
    sampleIntervalMs: 60_000,
    getAppMetrics: () => {
      metricReads += 1;
      return [];
    },
  });

  diagnostics.start({});
  diagnostics.recordResourceSnapshot("periodic");
  diagnostics.recordResourceSnapshot("periodic");
  diagnostics.stop();

  assert.equal(metricReads, 1);
  const records = fs.readFileSync(paths.eventLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, any>);
  const periodic = records.filter((record) => record.trigger === "periodic");
  assert.equal(periodic.length, 2);
  assert.equal(periodic[1].resources.processes[0].cpuPercent, null);
  assert.equal(periodic[1].resources.processes[0].workingSetSizeKb, 300);
  assert.equal(periodic[1].resources.processes[0].peakWorkingSetSizeKb, 500);
});

function createProcessFixture(
  procRoot: string,
  pid: number,
  descriptorCount: number,
  softLimit: number,
  workingSetSizeKb = 128,
  peakWorkingSetSizeKb = 256,
): void {
  const directory = path.join(procRoot, String(pid));
  const descriptors = path.join(directory, "fd");
  fs.mkdirSync(descriptors, { recursive: true });
  for (let index = 0; index < descriptorCount; index += 1) {
    fs.writeFileSync(path.join(descriptors, String(index)), "");
  }
  fs.writeFileSync(
    path.join(directory, "limits"),
    `Max open files            ${softLimit}                 1048576              files\n`,
  );
  fs.writeFileSync(
    path.join(directory, "status"),
    `Name:\telectron\nVmHWM:\t${peakWorkingSetSizeKb} kB\nVmRSS:\t${workingSetSizeKb} kB\n`,
  );
}
