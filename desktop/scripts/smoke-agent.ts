import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopRuntime } from "../src/main/runtime.js";

type SmokeMode = "catalog" | "history" | "live" | "model-switch" | "command" | "interrupt" | "terminal";

interface AgentMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(desktopRoot, "..");
const gatewayRoot = process.env.RHZYCODE_GATEWAY_HOME || path.join(workspaceRoot, "transfer");
const codexHome = process.env.RHZYCODE_SMOKE_CODEX_HOME ||
  path.join(os.tmpdir(), "rhzycode-smoke-codex-home");
const model = process.env.RHZYCODE_SMOKE_MODEL || "faker/kimi-for-coding";
const switchFromModel = process.env.RHZYCODE_SMOKE_FROM_MODEL || "sub2api/gpt-5.6-terra";
const switchToModel = process.env.RHZYCODE_SMOKE_TO_MODEL || "faker/kimi-for-coding";
const mode = parseMode(process.argv.slice(2));

const runtime = new DesktopRuntime(gatewayRoot, codexHome, "127.0.0.1", 0);

try {
  await runtime.start();
  const catalog = await runtime.listModels<{ data?: Array<{ model?: string }> }>();
  const models = catalog.data || [];
  const requiredModels = mode === "model-switch" ? [switchFromModel, switchToModel] : [model];
  for (const requiredModel of requiredModels) {
    if (!models.some((entry) => entry.model === requiredModel)) {
      throw new Error(`Smoke model ${requiredModel} is missing from the ${models.length}-model catalog.`);
    }
  }

  if (mode === "catalog") {
    report({ ok: true, mode, modelCount: models.length, model });
  } else if (mode === "history") {
    const result = await runHistory(runtime);
    report({ ok: true, mode, modelCount: models.length, model, ...result });
  } else if (mode === "live") {
    const result = await runLiveTurn(runtime);
    report({ ok: true, mode, modelCount: models.length, model, ...result });
  } else if (mode === "model-switch") {
    const result = await runModelSwitch(runtime);
    report({ ok: true, mode, modelCount: models.length, ...result });
  } else if (mode === "command") {
    const result = await runCommand(runtime);
    report({ ok: true, mode, modelCount: models.length, model, ...result });
  } else if (mode === "terminal") {
    const result = await runTerminal(runtime);
    report({ ok: true, mode, modelCount: models.length, model, ...result });
  } else {
    const result = await runInterrupt(runtime);
    report({ ok: true, mode, modelCount: models.length, model, ...result });
  }
} finally {
  await runtime.stop();
}

async function runTerminal(activeRuntime: DesktopRuntime) {
  let output = "";
  const onOutput = (event: { delta?: string }) => {
    output += event.delta || "";
  };
  activeRuntime.on("terminal:output", onOutput);
  try {
    const session = activeRuntime.startTerminal({ cwd: workspaceRoot, cols: 100, rows: 30 });
    await delay(600);
    await activeRuntime.writeTerminal(
      session.processId,
      "Write-Output (('RHZY_' + 'TERMINAL_OK'))\r\n",
    );
    await waitUntil(() => output.includes("RHZY_TERMINAL_OK"), 15_000, "terminal output");
    await activeRuntime.stopTerminal(session.processId);
    await waitUntil(
      () => activeRuntime.getTerminalStatus()?.running === false,
      10_000,
      "terminal exit status",
    );
    return { processId: session.processId, outputMatched: true };
  } finally {
    activeRuntime.off("terminal:output", onOutput);
  }
}

async function runCommand(activeRuntime: DesktopRuntime) {
  const threadId = await startSmokeThread(activeRuntime);
  const completed = waitForMessage(activeRuntime, "turn/completed", 120_000);
  activeRuntime.on("sync:event", (event) => {
    const approvalEvent = event as { type?: string; approval?: { id?: string } };
    if (approvalEvent.type === "approval.requested" && approvalEvent.approval?.id) {
      activeRuntime.resolveApproval(approvalEvent.approval.id, "approved");
    }
  });
  await activeRuntime.startTurn({
    threadId,
    text: "Use the shell to run Write-Output RHZY_COMMAND_OK. Do not modify any files. Then reply with the command output.",
  });
  const notification = await completed;
  const turn = (notification.params?.turn || {}) as Record<string, unknown>;
  if (String(turn.status).toLowerCase().includes("fail")) {
    throw new Error(`Command turn failed: ${JSON.stringify(turn.error || turn)}`);
  }
  const commandItems = activeRuntime.getSnapshot().timeline.filter(
    (item) => item.threadId === threadId && item.kind === "command",
  );
  if (!commandItems.some((item) => item.content.includes("RHZY_COMMAND_OK"))) {
    throw new Error("Command output was not persisted in the activity timeline.");
  }
  return { threadId, turnId: String(turn.id || ""), commandItemCount: commandItems.length };
}

async function runHistory(activeRuntime: DesktopRuntime) {
  const liveResult = await runLiveTurn(activeRuntime);
  const threadId = liveResult.threadId;
  const threads = await activeRuntime.listThreads({ cwd: workspaceRoot });
  const listed = threads.find((thread) => thread.id === threadId);
  if (!listed) throw new Error("New thread was not returned by thread/list.");
  const detail = await activeRuntime.openThread(threadId);
  if (detail.thread.projectPath !== workspaceRoot) {
    throw new Error(`Unexpected resumed cwd: ${detail.thread.projectPath}`);
  }
  return {
    threadId,
    listedThreadCount: threads.length,
    resumedModel: detail.thread.model,
    restoredMessageCount: detail.messages.length,
  };
}

async function runLiveTurn(activeRuntime: DesktopRuntime) {
  let assistantText = "";
  const completed = waitForMessage(activeRuntime, "turn/completed", 180_000);
  const onMessage = (raw: unknown) => {
    const message = raw as AgentMessage;
    if (message.method === "item/agentMessage/delta") {
      assistantText += String(message.params?.delta || "");
    }
  };
  activeRuntime.on("agent:message", onMessage);
  declineUnexpectedApprovals(activeRuntime);

  try {
    const threadId = await startSmokeThread(activeRuntime);
    await activeRuntime.startTurn({
      threadId,
      text: "Do not use tools. Reply with exactly RHZYCODE_SMOKE_OK and nothing else.",
    });
    const completion = await completed;
    const turn = (completion.params?.turn || {}) as Record<string, unknown>;
    if (String(turn.status).toLowerCase().includes("fail")) {
      throw new Error(`Live turn failed: ${JSON.stringify(turn.error || turn)}`);
    }
    if (!assistantText.includes("RHZYCODE_SMOKE_OK")) {
      throw new Error(`Unexpected assistant output: ${assistantText}`);
    }
    return {
      threadId,
      turnId: String(turn.id || ""),
      assistantText: assistantText.trim(),
    };
  } finally {
    activeRuntime.off("agent:message", onMessage);
  }
}

async function runModelSwitch(activeRuntime: DesktopRuntime) {
  const response = await activeRuntime.startThread({ cwd: workspaceRoot, model: switchFromModel });
  const threadId = String(response.thread?.id || "");
  if (!threadId) throw new Error("thread/start returned no thread id.");

  const first = await runMarkerTurn(
    activeRuntime,
    threadId,
    switchFromModel,
    "Do not use tools. Reply with exactly RHZY_MODEL_SWITCH_FIRST_OK and nothing else.",
  );
  if (!first.includes("RHZY_MODEL_SWITCH_FIRST_OK")) {
    throw new Error(`Unexpected first model output: ${first}`);
  }

  const second = await runMarkerTurn(
    activeRuntime,
    threadId,
    switchToModel,
    `Do not use tools. State the active model by replying with exactly ACTIVE_MODEL=${switchToModel}.`,
  );
  if (!second.includes(`ACTIVE_MODEL=${switchToModel}`)) {
    throw new Error(`Unexpected switched model output: ${second}`);
  }
  if (/GPT-5(?:\.|\b)/i.test(second)) {
    throw new Error(`Switched non-OpenAI model still claimed a GPT identity: ${second}`);
  }

  const snapshotModel = activeRuntime.getSnapshot().threads.find((thread) => thread.id === threadId)?.model;
  if (snapshotModel !== switchToModel) {
    throw new Error(`Thread snapshot kept ${snapshotModel || "no model"} after switching to ${switchToModel}.`);
  }
  return {
    threadId,
    fromModel: switchFromModel,
    toModel: switchToModel,
    firstOutput: first,
    secondOutput: second,
    snapshotModel,
  };
}

async function runMarkerTurn(
  activeRuntime: DesktopRuntime,
  threadId: string,
  selectedModel: string,
  text: string,
): Promise<string> {
  let assistantText = "";
  const completed = waitForMessage(activeRuntime, "turn/completed", 180_000);
  const onMessage = (raw: unknown) => {
    const message = raw as AgentMessage;
    if (message.method === "item/agentMessage/delta") {
      assistantText += String(message.params?.delta || "");
    }
  };
  activeRuntime.on("agent:message", onMessage);
  try {
    await activeRuntime.startTurn({ threadId, text, model: selectedModel });
    const completion = await completed;
    const turn = (completion.params?.turn || {}) as Record<string, unknown>;
    if (String(turn.status).toLowerCase().includes("fail")) {
      throw new Error(`Model switch turn failed: ${JSON.stringify(turn.error || turn)}`);
    }
    return assistantText.trim();
  } finally {
    activeRuntime.off("agent:message", onMessage);
  }
}

async function runInterrupt(activeRuntime: DesktopRuntime) {
  const threadId = await startSmokeThread(activeRuntime);
  const started = waitForMessage(activeRuntime, "turn/started", 30_000);
  const turnRequest = activeRuntime.startTurn({
    threadId,
    text: "Do not use tools. Write the word running on 500 separate lines.",
  });
  const notification = await started;
  const turn = (notification.params?.turn || {}) as Record<string, unknown>;
  const turnId = String(turn.id || "");
  if (!turnId) throw new Error("turn/started returned no turn id.");
  await activeRuntime.interruptTurn(threadId);
  await turnRequest;
  return { threadId, turnId, status: "interrupted" };
}

async function startSmokeThread(activeRuntime: DesktopRuntime): Promise<string> {
  const response = await activeRuntime.startThread({ cwd: workspaceRoot, model }) as {
    thread?: { id?: string };
  };
  const threadId = String(response.thread?.id || "");
  if (!threadId) throw new Error("thread/start returned no thread id.");
  return threadId;
}

function waitForMessage(
  activeRuntime: DesktopRuntime,
  method: string,
  timeoutMs: number,
): Promise<AgentMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      activeRuntime.off("agent:message", listener);
      reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    const listener = (raw: unknown) => {
      const message = raw as AgentMessage;
      if (message.method !== method) return;
      clearTimeout(timer);
      activeRuntime.off("agent:message", listener);
      resolve(message);
    };
    activeRuntime.on("agent:message", listener);
  });
}

function declineUnexpectedApprovals(activeRuntime: DesktopRuntime): void {
  activeRuntime.on("sync:event", (event) => {
    const approvalEvent = event as { type?: string; approval?: { id?: string } };
    if (approvalEvent.type === "approval.requested" && approvalEvent.approval?.id) {
      activeRuntime.resolveApproval(approvalEvent.approval.id, "declined");
    }
  });
}

function parseMode(args: string[]): SmokeMode {
  if (args.includes("--model-switch")) return "model-switch";
  if (args.includes("--history")) return "history";
  if (args.includes("--live")) return "live";
  if (args.includes("--command")) return "command";
  if (args.includes("--terminal")) return "terminal";
  if (args.includes("--interrupt")) return "interrupt";
  return "catalog";
}

function report(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) resolve();
      else if (Date.now() >= deadline) reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
      else setTimeout(check, 50);
    };
    check();
  });
}
