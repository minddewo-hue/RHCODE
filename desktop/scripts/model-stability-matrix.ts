import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DesktopRuntime } from "../src/main/runtime.js";

interface AgentMessage {
  method?: string;
  params?: Record<string, unknown>;
}

interface TurnResult {
  ok: boolean;
  elapsedMs: number;
  output: string;
  error?: string;
}

interface ModelResult {
  model: string;
  round1?: TurnResult;
  round2?: TurnResult;
  projectTool?: TurnResult;
  codeEdit?: TurnResult;
  verdict?: "stable" | "coding-failed" | "chat-only" | "unstable" | "unavailable";
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(desktopRoot, "..");
const projectRoot = path.join(workspaceRoot, "validation", "a-share-compute-assistant");
const outputRoot = path.join(workspaceRoot, "validation", "model-stability");
const gatewayRoot = process.env.RHZYCODE_GATEWAY_HOME || path.join(workspaceRoot, "transfer");
const codexHome = process.env.RHZYCODE_MATRIX_CODEX_HOME ||
  path.join(os.tmpdir(), `rhzycode-model-matrix-${process.pid}`);
const responseTimeoutMs = readTimeout("RHZYCODE_MATRIX_RESPONSE_TIMEOUT_MS", 60_000);
const toolTimeoutMs = readTimeout("RHZYCODE_MATRIX_TOOL_TIMEOUT_MS", 120_000);
const codeEditEnabled = process.argv.includes("--code-edit");
const selectedModels = new Set(process.argv.slice(2).filter((value) => !value.startsWith("--")));

if (!fs.statSync(projectRoot).isDirectory()) {
  throw new Error(`Validation project is missing: ${projectRoot}`);
}
fs.mkdirSync(outputRoot, { recursive: true });

const runtime = new DesktopRuntime(gatewayRoot, codexHome, "127.0.0.1", 0);
const startedAt = new Date().toISOString();
const results: ModelResult[] = [];

try {
  await runtime.start();
  const catalog = await runtime.listModels<{ data?: Array<{ model?: string }> }>();
  const catalogModels = (catalog.data || [])
    .map((entry) => String(entry.model || ""))
    .filter(Boolean);
  const models = selectedModels.size > 0
    ? catalogModels.filter((model) => selectedModels.has(model))
    : catalogModels;
  const missing = [...selectedModels].filter((model) => !catalogModels.includes(model));
  if (missing.length > 0) throw new Error(`Models missing from catalog: ${missing.join(", ")}`);

  for (const model of models) {
    const result: ModelResult = { model };
    results.push(result);
    result.round1 = await runMarkerTurn(model, "RHZY_MATRIX_R1_OK", responseTimeoutMs);
    printProgress(model, "round1", result.round1);
    saveResults(startedAt, results, models.length);
  }

  for (const result of results.filter((entry) => entry.round1?.ok)) {
    result.round2 = await runMarkerTurn(result.model, "RHZY_MATRIX_R2_OK", responseTimeoutMs);
    printProgress(result.model, "round2", result.round2);
    saveResults(startedAt, results, models.length);
  }

  for (const result of results.filter((entry) => entry.round1?.ok && entry.round2?.ok)) {
    result.projectTool = await runProjectToolTurn(result.model, toolTimeoutMs);
    printProgress(result.model, "projectTool", result.projectTool);
    saveResults(startedAt, results, models.length);
  }

  if (codeEditEnabled) {
    for (const result of results.filter((entry) => entry.projectTool?.ok)) {
      result.codeEdit = await runCodeEditTurn(result.model, toolTimeoutMs);
      printProgress(result.model, "codeEdit", result.codeEdit);
      saveResults(startedAt, results, models.length);
    }
  }

  for (const result of results) result.verdict = classify(result);
  saveResults(startedAt, results, models.length, true);
  console.log(JSON.stringify(summarize(results), null, 2));
} finally {
  await runtime.stop();
}

async function runMarkerTurn(model: string, marker: string, timeoutMs: number): Promise<TurnResult> {
  return runTurn({
    model,
    prompt: `Do not use tools. Reply with exactly ${marker} and nothing else.`,
    timeoutMs,
    validate: (output) => finalAnswer(output) === marker,
    invalidMessage: `Expected exact marker ${marker}.`,
  });
}

function finalAnswer(output: string): string {
  return output.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

async function runProjectToolTurn(model: string, timeoutMs: number): Promise<TurnResult> {
  return runTurn({
    model,
    prompt: "Use the shell to run Get-Content package.json in the current project. Do not modify files. Confirm the package name from the command output, then reply with exactly RHZY_PROJECT_TOOL_OK and nothing else.",
    timeoutMs,
    validate: (output, threadId) => {
      const commandItems = runtime.getSnapshot().timeline.filter(
        (item) => item.threadId === threadId && item.kind === "command",
      );
      return output.includes("RHZY_PROJECT_TOOL_OK") &&
        commandItems.some((item) => /Get-Content\s+package\.json/i.test(item.content)) &&
        commandItems.some((item) => item.content.includes("a-share-compute-assistant"));
    },
    invalidMessage: "The model did not read package.json through a shell tool and report the expected marker.",
  });
}

async function runCodeEditTurn(model: string, timeoutMs: number): Promise<TurnResult> {
  const workspace = prepareModelWorkspace(model);
  return runTurn({
    model,
    cwd: workspace,
    sandboxMode: "danger-full-access",
    prompt: "Create src/model-smoke.js exporting function normalizeTicker(value) that trims the value and converts it to uppercase. Create test/model-smoke.test.js with a node:test assertion that normalizeTicker('  sh600000 ') equals 'SH600000'. Do not modify existing files. Run node --test test/model-smoke.test.js. After it passes, reply with exactly RHZY_CODE_EDIT_OK and nothing else.",
    timeoutMs,
    validate: (output) => finalAnswer(output).includes("RHZY_CODE_EDIT_OK") && verifyModelWorkspace(workspace),
    invalidMessage: "The model did not create and pass the isolated coding fixture.",
  });
}

async function runTurn(options: {
  model: string;
  prompt: string;
  timeoutMs: number;
  cwd?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  validate: (output: string, threadId: string) => boolean;
  invalidMessage: string;
}): Promise<TurnResult> {
  const start = Date.now();
  let threadId = "";
  let assistantText = "";
  let listener: ((raw: unknown) => void) | undefined;

  try {
    const response = await withTimeout(runtime.startThread({
      cwd: options.cwd || projectRoot,
      model: options.model,
      approvalPolicy: "never",
      sandboxMode: options.sandboxMode || "read-only",
    }), 20_000, "thread/start");
    threadId = String(response.thread?.id || "");
    if (!threadId) throw new Error("thread/start returned no thread id.");

    const completion = new Promise<Record<string, unknown>>((resolve) => {
      listener = (raw: unknown) => {
        const message = raw as AgentMessage;
        if (String(message.params?.threadId || "") !== threadId) return;
        if (message.method === "item/agentMessage/delta") {
          assistantText += String(message.params?.delta || "");
        }
        if (message.method === "turn/completed") {
          resolve((message.params?.turn || {}) as Record<string, unknown>);
        }
      };
      runtime.on("agent:message", listener);
    });

    await withTimeout(runtime.startTurn({
      threadId,
      text: options.prompt,
      model: options.model,
      approvalPolicy: "never",
      sandboxMode: options.sandboxMode || "read-only",
    }), 20_000, "turn/start");
    const turn = await withTimeout(completion, options.timeoutMs, "turn/completed");
    const status = String(turn.status || "completed").toLowerCase();
    if (status.includes("fail")) throw new Error(cleanError(turn.error || turn));
    const output = assistantText.trim();
    if (!options.validate(output, threadId)) throw new Error(options.invalidMessage);
    return { ok: true, elapsedMs: Date.now() - start, output: output.slice(0, 500) };
  } catch (error) {
    if (threadId) {
      await withTimeout(runtime.interruptTurn(threadId), 10_000, "turn/interrupt").catch(() => undefined);
    }
    return {
      ok: false,
      elapsedMs: Date.now() - start,
      output: assistantText.trim().slice(0, 500),
      error: cleanError(error),
    };
  } finally {
    if (listener) runtime.off("agent:message", listener);
  }
}

function classify(result: ModelResult): ModelResult["verdict"] {
  if (!result.round1?.ok) return "unavailable";
  if (!result.round2?.ok) return "unstable";
  if (!result.projectTool?.ok) return "chat-only";
  if (codeEditEnabled && !result.codeEdit?.ok) return "coding-failed";
  return "stable";
}

function summarize(modelResults: ModelResult[]) {
  const verdicts = ["stable", "coding-failed", "chat-only", "unstable", "unavailable"] as const;
  return Object.fromEntries(verdicts.map((verdict) => [
    verdict,
    modelResults.filter((result) => result.verdict === verdict).map((result) => result.model),
  ]));
}

function saveResults(start: string, modelResults: ModelResult[], catalogCount: number, complete = false) {
  const report = {
    startedAt: start,
    finishedAt: complete ? new Date().toISOString() : null,
    projectRoot,
    catalogCount,
    responseTimeoutMs,
    toolTimeoutMs,
    codeEditEnabled,
    complete,
    summary: summarize(modelResults),
    results: modelResults,
  };
  fs.writeFileSync(path.join(outputRoot, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
}

function prepareModelWorkspace(model: string): string {
  const workspacesRoot = path.resolve(outputRoot, "workspaces");
  const workspace = path.resolve(workspacesRoot, model.replace(/[^A-Za-z0-9._-]+/g, "__"));
  if (!workspace.startsWith(`${workspacesRoot}${path.sep}`)) {
    throw new Error(`Unsafe model workspace path: ${workspace}`);
  }
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.cpSync(projectRoot, workspace, {
    recursive: true,
    filter: (source) => !/\.(?:log|png)$/i.test(source),
  });
  return workspace;
}

function verifyModelWorkspace(workspace: string): boolean {
  const implementation = path.join(workspace, "src", "model-smoke.js");
  const testFile = path.join(workspace, "test", "model-smoke.test.js");
  if (!fs.existsSync(implementation) || !fs.existsSync(testFile)) return false;
  const result = spawnSync(process.execPath, ["--test", testFile], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  return result.status === 0 && /pass 1/i.test(`${result.stdout}\n${result.stderr}`);
}

function printProgress(model: string, stage: string, result: TurnResult) {
  console.log(`${result.ok ? "PASS" : "FAIL"}\t${stage}\t${result.elapsedMs}ms\t${model}${result.error ? `\t${result.error}` : ""}`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function cleanError(value: unknown): string {
  const text = value instanceof Error ? value.message : JSON.stringify(value);
  return String(text || "Unknown error")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(?:sk|fm)_[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 1_000);
}

function readTimeout(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 5_000 || parsed > 600_000) {
    throw new Error(`${name} must be from 5000 to 600000 milliseconds.`);
  }
  return parsed;
}
