import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = path.resolve(desktopDir, "..");
const electronExecutable = path.join(
  workspaceDir,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const options = parseArguments(process.argv.slice(2));
const projectDir = path.resolve(options.project);
const prompt = fs.readFileSync(path.resolve(options.promptFile), "utf8").trim();

if (!fs.statSync(projectDir).isDirectory()) throw new Error(`Project directory is missing: ${projectDir}`);
if (!prompt) throw new Error("Task prompt must not be empty.");

const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => entry[1] !== undefined),
);
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_RENDERER_URL;

const startedAt = Date.now();
const errors = [];
let app;

try {
  app = await electron.launch({
    executablePath: electronExecutable,
    args: ["."],
    cwd: desktopDir,
    env: {
      ...environment,
      RHZYCODE_GATEWAY_HOME: path.join(workspaceDir, "desktop", "model-gateway"),
      RHZYCODE_SYNC_HOST: "127.0.0.1",
      RHZYCODE_SYNC_PORT: "0",
    },
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.locator(".app-shell").waitFor({ timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
  });
  await app.evaluate(({ dialog }, selectedProject) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [selectedProject],
    })) ;
  }, projectDir);

  await waitForDesktop(page, options.model, options.timeoutMs);
  await page.locator(".project-picker").click();
  await page.getByRole("menuitem", { name: /Open folder/i }).click();
  await page.locator(".project-picker")
    .filter({ hasText: path.basename(projectDir) })
    .waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "New task" }).click();

  const modelSelect = page.getByRole("combobox", { name: "Model" });
  const modelValues = await modelSelect.locator("option").evaluateAll((nodes) =>
    nodes.map((node) => ({ value: node.value, label: node.textContent || "" })),
  );
  if (!modelValues.some((entry) => entry.value === options.model)) {
    throw new Error(`Requested model is unavailable: ${options.model}`);
  }
  await modelSelect.selectOption(options.model);
  await page.getByRole("combobox", { name: "Sandbox policy" }).selectOption(options.sandbox);
  await page.getByRole("combobox", { name: "Approval mode" }).selectOption("never");

  const before = await page.evaluate(() => window.rhzycode.getSyncSnapshot());
  await page.getByRole("textbox", { name: "Task prompt" }).fill(prompt);
  await page.locator("button.send-button").click();

  const result = await waitForTask(page, projectDir, before.threads.map((thread) => thread.id), options.timeoutMs);
  const screenshotPath = path.join(projectDir, "desktop-task-result.png");
  let screenshotError = null;
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 10_000 });
  } catch (error) {
    screenshotError = error instanceof Error ? error.message : String(error);
  }
  const assistantMessages = await page.locator(".message.assistant .message-content").allTextContents();
  const lastAssistantMessage = assistantMessages.at(-1)?.trim() || "";
  const fatalErrors = errors.filter((error) => !/favicon|DevTools/i.test(error));
  if (fatalErrors.length > 0) throw new Error(`Renderer errors: ${fatalErrors.join(" | ")}`);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    threadId: result.thread.id,
    status: result.thread.status,
    model: result.thread.model,
    sandbox: options.sandbox,
    elapsedMs: Date.now() - startedAt,
    screenshotPath: screenshotError ? null : screenshotPath,
    screenshotError,
    assistant: lastAssistantMessage.slice(0, 2_000),
  }, null, 2)}\n`);
} finally {
  await app?.close().catch(() => undefined);
}

async function waitForDesktop(page, model, timeoutMs) {
  await page.waitForFunction(async (requestedModel) => {
    const [agent, gateway, models] = await Promise.all([
      window.rhzycode.getAgentStatus(),
      window.rhzycode.getGatewayStatus(),
      window.rhzycode.listModels(),
    ]);
    return agent.state === "connected"
      && gateway.state === "running"
      && Boolean(models.data?.some((entry) => entry.model === requestedModel));
  }, model, { timeout: Math.min(timeoutMs, 120_000), polling: 1_000 });
}

async function waitForTask(page, selectedProject, previousThreadIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const previous = new Set(previousThreadIds);
  let thread = null;
  let observedActive = false;

  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => window.rhzycode.getSyncSnapshot());
    for (const approval of snapshot.approvals) {
      await page.evaluate((id) => window.rhzycode.resolveApproval(id, "approved"), approval.id);
    }
    for (const request of snapshot.userInputs) {
      await page.evaluate((id) => window.rhzycode.resolveUserInput(id, {}), request.id);
    }

    const candidates = snapshot.threads
      .filter((entry) => comparablePath(entry.projectPath) === comparablePath(selectedProject))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    thread = candidates.find((entry) => !previous.has(entry.id)) || candidates[0] || thread;
    if (thread) {
      observedActive ||= ["running", "waiting_for_approval", "waiting_for_input"].includes(thread.status);
      if (observedActive && ["completed", "failed", "interrupted", "idle"].includes(thread.status)) {
        if (thread.status !== "completed" && thread.status !== "idle") {
          throw new Error(`Desktop task ended with status ${thread.status}.`);
        }
        return { thread };
      }
    }
    await delay(1_000);
  }
  throw new Error(`Desktop task timed out after ${timeoutMs}ms${thread ? ` (last status: ${thread.status})` : ""}.`);
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key || "end"}.`);
    values.set(key.slice(2), value);
  }
  const project = values.get("project");
  const promptFile = values.get("prompt-file");
  if (!project || !promptFile) throw new Error("--project and --prompt-file are required.");
  const timeoutMinutes = Number(values.get("timeout-minutes") || "20");
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || timeoutMinutes > 60) {
    throw new Error("--timeout-minutes must be from 1 to 60.");
  }
  return {
    project,
    promptFile,
    model: values.get("model") || "sub2api/gpt-5.6-terra",
    sandbox: parseSandbox(values.get("sandbox") || "workspace-write"),
    timeoutMs: timeoutMinutes * 60_000,
  };
}

function parseSandbox(value) {
  if (!["read-only", "workspace-write", "danger-full-access"].includes(value)) {
    throw new Error("--sandbox must be read-only, workspace-write, or danger-full-access.");
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
