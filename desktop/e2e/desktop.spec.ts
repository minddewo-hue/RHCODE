import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = path.resolve(desktopDir, "..");
const projectDir = path.join(desktopDir, "e2e", "fixtures", "project");
const attachmentPath = path.join(projectDir, "notes.txt");
const electronExecutable = path.join(
  workspaceDir,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const packagedExecutable = process.env.RHZYCODE_E2E_EXECUTABLE?.trim();

let electronApp: ElectronApplication;
let page: Page;
let dataDir: string;
let emptyProjectDir: string;
const rendererErrors: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-playwright-"));
  emptyProjectDir = path.join(dataDir, "empty-project");
  fs.mkdirSync(emptyProjectDir);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete environment.ELECTRON_RUN_AS_NODE;

  electronApp = await electron.launch({
    executablePath: packagedExecutable || electronExecutable,
    args: packagedExecutable ? [] : ["."],
    cwd: packagedExecutable ? path.dirname(packagedExecutable) : desktopDir,
    env: {
      ...environment,
      RHZYCODE_USER_DATA_DIR: dataDir,
      RHZYCODE_CODEX_HOME: path.join(dataDir, "codex-home"),
      RHZYCODE_GATEWAY_HOME: path.join(workspaceDir, "desktop"),
      RHZYCODE_SYNC_HOST: "127.0.0.1",
      RHZYCODE_SYNC_PORT: "0",
      SUB2API_API_KEY: "",
    },
    timeout: 30_000,
  });
  page = await electronApp.firstWindow();
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });
  await page.locator(".app-shell").waitFor();
  await installDeterministicIpc(electronApp);
  await page.reload();
  await page.locator(".app-shell").waitFor();
  rendererErrors.length = 0;
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1040, 680);
  });
  await electronApp.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async (_window, options) => ({
      canceled: false,
      filePaths: options.properties?.includes("openDirectory")
        ? [paths.projectDir]
        : [paths.attachmentPath],
    })) as typeof dialog.showOpenDialog;
  }, { projectDir, attachmentPath });
});

test.afterAll(async () => {
  await electronApp?.close().catch(() => undefined);
  if (dataDir?.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("supports core desktop workflows at the minimum window size", async () => {
  await assertVisibleControlsHaveNames(page);
  await assertMinimumWindowLayout(page);
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toHaveCount(0);
  const modelSelect = page.getByRole("combobox", { name: "Model for next turn" });
  await modelSelect.selectOption("ui/second");
  await expect(modelSelect).toHaveValue("ui/second");
  await modelSelect.selectOption("ui/model");

  const closePanel = page.getByRole("button", { name: "Close side panel" });
  await expect(closePanel).toBeVisible();
  await closePanel.focus();
  await page.keyboard.press("Enter");
  await expect(closePanel).toBeHidden();
  const panelToggle = page.getByRole("button", { name: "Side panel", exact: true });
  await panelToggle.click();
  await expect(page.getByRole("tab", { name: "Gateway" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Activity" }).click();
  await panelToggle.click();
  await expect(closePanel).toBeHidden();

  await panelToggle.click();
  await assertSidePanelDoesNotCoverWorkspace(page);
  await expect(page).toHaveScreenshot("desktop-minimum-panel-open.png", {
    animations: "disabled",
    caret: "hide",
    maskColor: "#d8dcd6",
    mask: [page.locator(".model-select")],
  });
  await page.getByRole("button", { name: "Close side panel" }).click();
  await assertClosedPanelReleasesWorkspace(page);

  const projectPicker = page.getByRole("button", { name: /Select project/ });
  await projectPicker.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#project-menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /New project folder/i })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Open project folder" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open folder" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#project-menu")).toBeHidden();
  await expect(projectPicker).toBeFocused();
  await projectPicker.click();
  await expect(page.locator("#project-menu")).toBeVisible();
  await page.locator(".workspace-header").click();
  await expect(page.locator("#project-menu")).toBeHidden();
  await projectPicker.focus();
  await page.keyboard.press("Enter");
  const openFolder = page.getByRole("menuitem", { name: "Open project folder" });
  await openFolder.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /project.*fixtures.*project/i })).toBeVisible();
  const selectedProjectPicker = page.locator(".project-picker");
  await selectedProjectPicker.click();
  await page.locator("#project-menu .recent-project").getByRole("menuitem").click();
  await selectedProjectPicker.click();
  await page.getByRole("button", { name: "Remove project from recent projects" }).click();
  await expect(page.locator("#project-menu .recent-project")).toHaveCount(0);
  await selectedProjectPicker.click();

  await page.getByRole("button", { name: "Attach files or images" }).click();
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove notes.txt" }).click();
  await expect(page.getByText("notes.txt", { exact: true })).toBeHidden();
  const prompt = page.getByRole("textbox", { name: "Task prompt" });
  await pasteImage(prompt, "clipboard.png");
  await expect(page.getByText("clipboard.png", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove clipboard.png" }).click();
  await expect(page.getByText("clipboard.png", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Attach files or images" }).click();
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  await pasteImage(prompt, "clipboard-send.png");
  await expect(page.getByText("clipboard-send.png", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Sandbox policy" }).selectOption("read-only");
  await page.getByRole("combobox", { name: "Approval mode" }).selectOption("untrusted");
  await expect(page.getByRole("combobox", { name: "Sandbox policy" })).toHaveValue("read-only");
  await expect(page.getByRole("combobox", { name: "Approval mode" })).toHaveValue("untrusted");

  await expect(page).toHaveScreenshot("desktop-minimum-window.png", {
    animations: "disabled",
    caret: "hide",
    maskColor: "#d8dcd6",
    mask: [
      page.locator(".model-select"),
      page.locator(".project-picker small"),
    ],
  });

  await expect.poll(
    () => page.evaluate(() => window.rhzycode.getAgentStatus().then((status) => status.state)),
    { timeout: 20_000 },
  ).toBe("connected");
  const threadId = await page.evaluate((cwd) => window.rhzycode.startThread({ cwd })
    .then((result) => result.thread?.id || null), projectDir);
  expect(threadId).toBeTruthy();
  await sendSyncEvent(electronApp, {
    type: "thread.updated",
    sequence: 1,
    thread: {
      id: threadId!,
      hostId: "local-desktop",
      title: "UI automation thread",
      projectPath: projectDir,
      model: "default",
      status: "idle",
      updatedAt: new Date().toISOString(),
    },
  });

  const threadRow = getThreadRow(page, "UI automation thread");
  await expect(threadRow).toBeVisible();
  await sendSyncEvent(electronApp, {
    type: "thread.updated",
    sequence: 2,
    thread: {
      id: threadId!,
      hostId: "local-desktop",
      title: "UI automation thread",
      projectPath: projectDir,
      model: "default",
      status: "running",
      updatedAt: new Date().toISOString(),
    },
  });
  await expect(threadRow.locator(".thread-state")).toHaveClass(/running/);
  await expect.poll(() => threadRow.locator(".thread-state").evaluate((element) => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  })).toEqual({ name: "thread-state-pulse", duration: "1.1s" });
  const threadSearch = page.getByRole("textbox", { name: "Search threads" });
  await threadSearch.fill("missing thread");
  await expect(page.getByText("No matching threads", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(threadSearch).toHaveValue("");
  await expect(threadRow).toBeVisible();
  await threadRow.click();
  await expect(threadRow.locator("..")).toHaveClass(/active/);
  await expect.poll(() => ipcCalls(electronApp, "agent:thread:open").then((calls) => calls.length)).toBe(1);
  await expect(page.locator(".message-avatar")).toHaveCount(0);
  await expect(page.locator(".message-list .message-author")).toHaveCount(0);
  await assertClosedPanelReleasesWorkspace(page);
  await assertChatMessageLayout(page);
  await expect(page).toHaveScreenshot("desktop-chat-layout-lime.png", {
    animations: "disabled",
    caret: "hide",
    maskColor: "#d8dcd6",
    mask: [page.locator(".model-select"), page.locator(".project-picker small")],
  });

  const openCallsBeforeReload = await ipcCalls(electronApp, "agent:thread:open").then((calls) => calls.length);
  await page.reload();
  await page.locator(".app-shell").waitFor();
  await expect(page.locator(".project-picker")).toContainText("project");
  await expect(getThreadRow(page, "UI automation thread").locator("..")).toHaveClass(/active/);
  await expect.poll(() => ipcCalls(electronApp, "agent:thread:open").then((calls) => calls.length))
    .toBeGreaterThan(openCallsBeforeReload);
  if (await page.getByRole("button", { name: "Close side panel" }).isVisible()) {
    await page.getByRole("button", { name: "Close side panel" }).click();
  }

  await openThreadActions(page, "UI automation thread");
  const initialThreadMenu = page.getByRole("menu");
  await expect(initialThreadMenu).toBeVisible();
  await assertMenuInsideViewport(initialThreadMenu);
  await expect(page).toHaveScreenshot("desktop-thread-menu.png", {
    animations: "disabled",
    caret: "hide",
    maskColor: "#d8dcd6",
    mask: [page.locator(".model-select"), page.locator(".project-picker small")],
  });
  await page.locator(".workspace-header").click();
  await expect(initialThreadMenu).toBeHidden();
  await openThreadActions(page, "UI automation thread");
  const threadActionsTrigger = page.getByRole("button", { name: "Thread actions for UI automation thread" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(threadActionsTrigger).toBeFocused();
  await openThreadActions(page, "UI automation thread");
  await page.getByRole("menuitem", { name: "Rename task" }).click();
  let renameInput = page.getByRole("textbox", { name: "Rename UI automation thread" });
  await renameInput.fill("Canceled name");
  await page.getByRole("button", { name: "Cancel rename" }).click();
  await expect(getThreadRow(page, "UI automation thread")).toBeVisible();
  await openThreadActions(page, "UI automation thread");
  await page.getByRole("menuitem", { name: "Rename task" }).click();
  renameInput = page.getByRole("textbox", { name: "Rename UI automation thread" });
  await renameInput.fill("Renamed UI thread");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(getThreadRow(page, "Renamed UI thread")).toBeVisible();

  await sendSyncEvent(electronApp, {
    type: "thread.updated",
    sequence: 3,
    thread: {
      id: threadId!,
      hostId: "local-desktop",
      title: "Renamed UI thread",
      projectPath: projectDir,
      model: "default",
      status: "completed",
      updatedAt: new Date().toISOString(),
    },
  });
  await expect(getThreadRow(page, "Renamed UI thread").locator(".thread-state")).toHaveClass(/completed/);
  await sendAgentMessage(electronApp, {
    method: "turn/started",
    params: { threadId, turn: { id: "stale-ui-turn" } },
  });
  await expect(getThreadRow(page, "Renamed UI thread").locator(".thread-state")).toHaveClass(/completed/);
  const interruptsBeforeCompletedDelete = await ipcCalls(electronApp, "agent:turn:interrupt").then((calls) => calls.length);
  await openThreadActions(page, "Renamed UI thread");
  await Promise.all([
    page.waitForEvent("dialog").then((dialog) => {
      expect(dialog.message()).toContain("Renamed UI thread");
      return dialog.dismiss();
    }),
    page.getByRole("menuitem", { name: "Delete task permanently" }).click(),
  ]);
  await expect(getThreadRow(page, "Renamed UI thread")).toBeVisible();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Renamed UI thread");
    await dialog.accept();
  });
  await page.getByRole("menuitem", { name: "Delete task permanently" }).click();
  await expect(getThreadRow(page, "Renamed UI thread")).toBeHidden();
  await expect.poll(() => ipcCalls(electronApp, "agent:turn:interrupt").then((calls) => calls.length)).toBe(interruptsBeforeCompletedDelete);

  await sendSyncEvent(electronApp, {
    type: "approval.requested",
    sequence: 4,
    approval: {
      id: "ui-approval",
      threadId: "ui-thread",
      kind: "command",
      title: "Run verification command",
      detail: "npm test",
      createdAt: new Date().toISOString(),
    },
  });
  const approvalCard = page.locator(".approval-request").filter({ hasText: "Run verification command" });
  await expect(approvalCard).toBeVisible();
  await approvalCard.getByRole("button", { name: "Decline" }).click();
  await expect(approvalCard).toBeHidden();
  await expect.poll(() => ipcCalls(electronApp, "sync:approval:resolve").then((calls) => calls.at(-1)?.args)).toEqual([
    "ui-approval",
    "declined",
  ]);
  await sendSyncEvent(electronApp, {
    type: "approval.requested",
    sequence: 5,
    approval: {
      id: "ui-approval-approve",
      threadId: "ui-thread",
      kind: "file_change",
      title: "Apply verification fix",
      detail: "desktop/src/renderer/src/App.tsx",
      createdAt: new Date().toISOString(),
    },
  });
  const approvalAcceptCard = page.locator(".approval-request").filter({ hasText: "Apply verification fix" });
  await approvalAcceptCard.getByRole("button", { name: "Approve" }).click();
  await expect(approvalAcceptCard).toBeHidden();
  await expect.poll(() => ipcCalls(electronApp, "sync:approval:resolve").then((calls) => calls.at(-1)?.args)).toEqual([
    "ui-approval-approve",
    "approved",
  ]);

  await sendSyncEvent(electronApp, {
    type: "user_input.requested",
    sequence: 6,
    request: {
      id: "ui-input",
      threadId: "ui-thread",
      questions: [{
        id: "mode",
        header: "Mode",
        question: "Choose a verification mode",
        isOther: false,
        isSecret: false,
        options: [
          { label: "Focused", description: "Run focused checks" },
          { label: "Full", description: "Run every check" },
        ],
      }],
      autoResolutionMs: null,
      createdAt: new Date().toISOString(),
    },
  });
  const inputCard = page.locator(".user-input-request").filter({ hasText: "Choose a verification mode" });
  await inputCard.getByRole("button", { name: /Focused/ }).click();
  await inputCard.getByRole("button", { name: "Submit" }).click();
  await expect(inputCard).toBeHidden();
  await expect.poll(() => ipcCalls(electronApp, "sync:user-input:resolve").then((calls) => calls.at(-1)?.args)).toEqual([
    "ui-input",
    { mode: ["Focused"] },
  ]);

  await sendSyncEvent(electronApp, {
    type: "user_input.requested",
    sequence: 7,
    request: {
      id: "ui-input-skip",
      threadId: "ui-thread",
      questions: [{
        id: "detail",
        header: "Detail",
        question: "Add optional detail",
        isOther: false,
        isSecret: false,
        options: null,
      }],
      autoResolutionMs: null,
      createdAt: new Date().toISOString(),
    },
  });
  const skipCard = page.locator(".user-input-request").filter({ hasText: "Add optional detail" });
  await skipCard.getByRole("button", { name: "Skip" }).click();
  await expect(skipCard).toBeHidden();

  await page.getByRole("tab", { name: "Settings" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Mobile connection", { exact: true })).toBeVisible();
  await expect(page.getByText("Local state protection", { exact: true })).toHaveCount(0);
  await assertVisibleControlsHaveNames(page);
  const sub2apiCredential = page.locator(".credential-row").filter({ hasText: "Sub2API API key" });
  await expect(page.locator(".credential-row")).toHaveCount(1);
  await expect(sub2apiCredential).toContainText("model.rhzy.ai");
  await expect(sub2apiCredential).toContainText("KEY starts with sk-");
  await expect(page.getByLabel("Sub2API API key for model.rhzy.ai")).toHaveAttribute("placeholder", "Configured | paste new sk- KEY");
  const credentialInput = page.getByLabel("Sub2API API key for model.rhzy.ai");
  await credentialInput.fill("ui-test-key");
  await sub2apiCredential.getByRole("button", { name: "Save KEY", exact: true }).click();
  await expect.poll(() => ipcCalls(electronApp, "credentials:set").then((calls) => calls.at(-1)?.args)).toEqual([
    "sub2api",
    "ui-test-key",
  ]);
  await page.locator(".settings-view").evaluate((element) => { element.scrollTop = 0; });
  await expect(page).toHaveScreenshot("desktop-provider-credentials.png", {
    animations: "disabled",
    caret: "hide",
  });

  const deleteCredential = sub2apiCredential.getByRole("button", { name: "Delete", exact: true });
  const removeCallsBefore = (await ipcCalls(electronApp, "providers:remove")).length;
  await Promise.all([
    page.waitForEvent("dialog").then((dialog) => dialog.dismiss()),
    deleteCredential.click(),
  ]);
  expect((await ipcCalls(electronApp, "providers:remove")).length).toBe(removeCallsBefore);
  await Promise.all([
    page.waitForEvent("dialog").then((dialog) => dialog.accept()),
    deleteCredential.click(),
  ]);
  await expect(sub2apiCredential).toHaveCount(0);
  await expect.poll(() => ipcCalls(electronApp, "providers:remove").then((calls) => calls.at(-1)?.args)).toEqual(["sub2api"]);

  await page.getByRole("button", { name: "Add provider" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Claude relay");
  await page.getByLabel("URL", { exact: true }).fill("https://claude.example/v1/messages");
  await page.getByLabel("KEY", { exact: true }).fill("claude-ui-key");
  await page.locator(".provider-editor select").selectOption("anthropic_messages");
  await page.getByLabel("Models (optional)", { exact: true }).fill("claude-sonnet-test");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const claudeProvider = page.locator(".credential-row").filter({ hasText: "Claude relay API key" });
  await expect(claudeProvider).toContainText("anthropic_messages");
  await expect.poll(() => ipcCalls(electronApp, "providers:configure").then((calls) => calls.at(-1)?.args[0])).toMatchObject({
    providerId: "provider-1",
    baseUrl: "https://claude.example/v1/messages",
    protocol: "anthropic_messages",
    models: ["claude-sonnet-test"],
  });
  await Promise.all([
    page.waitForEvent("dialog").then((dialog) => dialog.accept()),
    claudeProvider.getByRole("button", { name: "Delete", exact: true }).click(),
  ]);
  await expect(claudeProvider).toHaveCount(0);
  await expect.poll(() => ipcCalls(electronApp, "providers:remove").then((calls) => calls.at(-1)?.args)).toEqual(["provider-1"]);

  await expect(page.getByText("192.168.1.25", { exact: true })).toBeVisible();
  const mobilePort = page.getByRole("textbox", { name: "Mobile connection port", exact: true });
  await expect(mobilePort).toHaveValue("8790");
  await mobilePort.fill("8912");
  await page.getByRole("button", { name: "Save mobile connection port" }).click();
  await expect(mobilePort).toHaveValue("8912");
  await expect.poll(() => ipcCalls(electronApp, "sync:port:set").then((calls) => calls.at(-1)?.args)).toEqual([8912]);
  await expect(page.locator(".settings-view")).toHaveScreenshot("desktop-settings-mobile-port.png", {
    animations: "disabled",
    caret: "hide",
  });
  await expect(page.getByText(/^rhzy_A{43}$/)).toBeVisible();
  const regenerateKey = page.getByRole("button", { name: "Regenerate key" });
  const rotationCallsBefore = (await ipcCalls(electronApp, "mobile-access:key:rotate")).length;
  await Promise.all([
    page.waitForEvent("dialog").then((dialog) => dialog.dismiss()),
    regenerateKey.click(),
  ]);
  expect((await ipcCalls(electronApp, "mobile-access:key:rotate")).length).toBe(rotationCallsBefore);
  await Promise.all([
    page.waitForEvent("dialog").then((dialog) => dialog.accept()),
    regenerateKey.click(),
  ]);
  await expect(page.getByText(/^rhzy_B{43}$/)).toBeVisible();
  await expect.poll(
    () => page.evaluate(() => window.rhzycode.getMobileAccessStatus()
      .then((status) => status.accessKey?.key || null)),
  ).toBe(`rhzy_${"B".repeat(43)}`);
  await expect(page).toHaveScreenshot("desktop-mobile-connection.png", {
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Copy access key" }).click();
  await expect.poll(() => ipcCalls(electronApp, "clipboard:write").then((calls) => calls.at(-1)?.args[0]))
    .toBe(`rhzy_${"B".repeat(43)}`);
  await installDeterministicUpdate(page);
  await expect.poll(() => ipcCalls(electronApp, "updates:check").then((calls) => calls.length)).toBeGreaterThan(0);
  await expect.poll(() => ipcCalls(electronApp, "updates:download").then((calls) => calls.length)).toBeGreaterThan(0);
  await expect.poll(() => ipcCalls(electronApp, "updates:install").then((calls) => calls.length)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Close side panel" }).click();

  const taskPrompt = page.getByRole("textbox", { name: "Task prompt" });
  await pasteImage(taskPrompt, "clipboard-turn.png");
  await expect(page.getByText("clipboard-turn.png", { exact: true })).toBeVisible();
  await taskPrompt.fill("Run deterministic verification");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => ipcCalls(electronApp, "agent:turn:start").then((calls) => {
    const params = calls.at(-1)?.args[0] as { attachments?: Array<{ name: string; kind: string }> } | undefined;
    return params?.attachments?.map(({ name, kind }) => ({ name, kind }));
  })).toEqual([
    { name: "clipboard-turn.png", kind: "image" },
  ]);
  await expect(page.locator(".send-button.stop")).toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toBeEnabled();
  await expect(page.locator(".project-picker")).toBeEnabled();
  await expect(modelSelect).toBeEnabled();

  await modelSelect.selectOption("ui/second");
  await page.getByRole("button", { name: "New task" }).click();
  await taskPrompt.fill("Run concurrent second task");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => ipcCalls(electronApp, "agent:turn:start").then((calls) => calls.length)).toBe(2);
  await expect(page.locator(".send-button.stop")).toBeVisible();
  await expect(getThreadRow(page, "Run deterministic verification")).toBeVisible();
  await expect(getThreadRow(page, "Run concurrent second task")).toBeVisible();

  await getThreadRow(page, "Run deterministic verification").click();
  await expect(page.locator(".send-button.stop")).toBeVisible();
  await expect(modelSelect).toBeEnabled();
  await taskPrompt.fill("Draft for the first task");
  await pasteImage(taskPrompt, "first-task-draft.png");
  await expect(page.getByText("first-task-draft.png", { exact: true })).toBeVisible();
  await getThreadRow(page, "Run concurrent second task").click();
  await expect(taskPrompt).toHaveValue("");
  await expect(page.getByText("first-task-draft.png", { exact: true })).toBeHidden();
  await getThreadRow(page, "Run deterministic verification").click();
  await expect(taskPrompt).toHaveValue("Draft for the first task");
  await expect(page.getByText("first-task-draft.png", { exact: true })).toBeVisible();
  await taskPrompt.fill("");
  await page.getByRole("button", { name: "Remove first-task-draft.png" }).click();
  await getThreadRow(page, "Run concurrent second task").click();
  await page.locator(".send-button.stop").click();
  await getThreadRow(page, "Run deterministic verification").click();
  await page.locator(".send-button.stop").click();
  await expect.poll(() => ipcCalls(electronApp, "agent:turn:interrupt").then((calls) => (
    calls.map((call) => call.args[0])
  ))).toEqual(["ui-thread-3", "ui-thread-2"]);

  await modelSelect.selectOption("ui/second");
  await failNextTurn(electronApp);
  await taskPrompt.fill("Fail once and retry");
  await page.getByRole("button", { name: "Send" }).click();
  const retryTurn = page.getByRole("button", { name: "Retry", exact: true });
  await expect(retryTurn).toBeVisible();
  await retryTurn.click();
  await expect(page.locator(".send-button.stop")).toBeVisible();
  await page.locator(".send-button.stop").click();
  await expect.poll(() => ipcCalls(electronApp, "agent:turn:start").then((calls) => calls.map((call) => (
    call.args[0] as { model?: string }
  ).model))).toEqual(["ui/model", "ui/second", "ui/second", "ui/second"]);
  await modelSelect.selectOption("ui/model");
  await taskPrompt.fill("Switch back to the first model");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => ipcCalls(electronApp, "agent:turn:start").then((calls) => (
    calls.at(-1)?.args[0] as { model?: string } | undefined
  )?.model)).toBe("ui/model");
  await page.locator(".send-button.stop").click();
  await page.getByRole("button", { name: "New task" }).click();
  await expect(taskPrompt).toHaveValue("");
  await expect(page.locator(".attachment-list")).toHaveCount(0);
  await expect(page.locator(".message-list")).toHaveCount(0);
  await expect(page.getByText("Start a new task", { exact: true })).toBeVisible();

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
  });
  await expect(page).toHaveScreenshot("desktop-standard-window.png", {
    animations: "disabled",
    caret: "hide",
    maskColor: "#d8dcd6",
    mask: [page.locator(".project-picker small")],
  });

  await modelSelect.selectOption("provider-2/gemma-4-31b-it-uncensored-bf16");
  await failNextTurn(electronApp);
  await taskPrompt.fill("Recover this prompt with another model");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  const failedCall = (await ipcCalls(electronApp, "agent:turn:start")).at(-1);
  await modelSelect.selectOption("ui/model");
  await expect(page.getByText("Start a new task", { exact: true })).toBeVisible();
  await expect(taskPrompt).toHaveValue("Recover this prompt with another model");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => ipcCalls(electronApp, "agent:turn:start").then((calls) => {
    const latest = calls.at(-1)?.args[0] as { threadId?: string; model?: string } | undefined;
    const failed = failedCall?.args[0] as { threadId?: string } | undefined;
    return { model: latest?.model, changedThread: latest?.threadId !== failed?.threadId };
  })).toEqual({ model: "ui/model", changedThread: true });
  await page.locator(".send-button.stop").click();

  await getThreadRow(page, "Run deterministic verification").click();
  const previousProjectMessage = page.getByText(
    "I will inspect the project structure, trace the main workflows, and report concrete findings.",
    { exact: true },
  );
  await expect(previousProjectMessage).toBeVisible();
  await electronApp.evaluate(({ dialog }, selectedDirectory) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [selectedDirectory],
    })) as typeof dialog.showOpenDialog;
  }, emptyProjectDir);
  await page.locator(".project-picker").click();
  await page.getByRole("menuitem", { name: "Open project folder" }).click();
  await expect(page.locator(".project-picker")).toContainText("empty-project");
  await expect(page.getByText("No tasks in this project", { exact: true })).toBeVisible();
  await expect(page.getByText("Start a new task", { exact: true })).toBeVisible();
  await expect(page.locator(".message-list")).toHaveCount(0);
  await expect(previousProjectMessage).toHaveCount(0);

  await sendAgentMessage(electronApp, {
    method: "item/agentMessage/delta",
    params: { itemId: "late-previous-project-message", delta: "This stale message must stay hidden." },
  });
  await expect(page.getByText("This stale message must stay hidden.", { exact: true })).toHaveCount(0);

  expect(rendererErrors).toEqual([]);
});

async function pasteImage(prompt: ReturnType<Page["getByRole"]>, name: string): Promise<void> {
  await prompt.evaluate((element, imageName) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    ], imageName, { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    }));
  }, name);
}

async function installDeterministicUpdate(activePage: Page): Promise<void> {
  const install = activePage.getByRole("button", { name: "Install and restart" });
  const download = activePage.getByRole("button", { name: "Download 0.2.0" });
  const check = activePage.getByRole("button", { name: "Check for updates" });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await install.isVisible()) {
      await install.click();
      return;
    }
    if (await download.isVisible()) await download.click();
    else if (await check.isVisible()) await check.click();
    await activePage.waitForTimeout(100);
  }
  throw new Error("The deterministic update did not reach the install state.");
}

async function assertVisibleControlsHaveNames(activePage: Page): Promise<void> {
  const unnamed = await activePage.locator("button:visible, input:visible, select:visible, textarea:visible")
    .evaluateAll((controls) => controls.flatMap((control) => {
      const ariaLabel = control.getAttribute("aria-label")?.trim();
      const title = control.getAttribute("title")?.trim();
      const text = control.textContent?.trim();
      const id = control.getAttribute("id");
      const explicitLabel = id
        ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim()
        : "";
      const wrappingLabel = control.closest("label")?.textContent?.trim();
      const placeholder = control.getAttribute("placeholder")?.trim();
      return ariaLabel || title || text || explicitLabel || wrappingLabel || placeholder
        ? []
        : [control.outerHTML.slice(0, 180)];
    }));
  expect(unnamed).toEqual([]);
}

async function assertMenuInsideViewport(menu: ReturnType<Page["getByRole"]>): Promise<void> {
  const bounds = await menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
}

async function assertMinimumWindowLayout(activePage: Page): Promise<void> {
  const layout = await activePage.evaluate(() => {
    const shell = document.querySelector(".app-shell")!.getBoundingClientRect();
    const workspace = document.querySelector(".workspace")!.getBoundingClientRect();
    const composer = document.querySelector(".composer-wrap")!.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      shell: { right: shell.right, bottom: shell.bottom },
      workspace: { right: workspace.right, bottom: workspace.bottom },
      composer: { top: composer.top, right: composer.right, bottom: composer.bottom },
    };
  });
  expect(layout.viewport.width).toBeGreaterThanOrEqual(1000);
  expect(layout.viewport.height).toBeGreaterThanOrEqual(620);
  expect(layout.shell.right).toBeLessThanOrEqual(layout.viewport.width + 1);
  expect(layout.shell.bottom).toBeLessThanOrEqual(layout.viewport.height + 1);
  expect(layout.workspace.bottom).toBeLessThanOrEqual(layout.viewport.height + 1);
  expect(layout.composer.top).toBeGreaterThan(0);
  expect(layout.composer.right).toBeLessThanOrEqual(layout.viewport.width + 1);
  expect(layout.composer.bottom).toBeLessThanOrEqual(layout.viewport.height + 1);
}

async function assertSidePanelDoesNotCoverWorkspace(activePage: Page): Promise<void> {
  const bounds = await activePage.evaluate(() => {
    const workspace = document.querySelector(".workspace")!.getBoundingClientRect();
    const panel = document.querySelector(".activity-panel")!.getBoundingClientRect();
    return { workspaceRight: workspace.right, panelLeft: panel.left };
  });
  expect(bounds.workspaceRight).toBeLessThanOrEqual(bounds.panelLeft + 1);
}

async function assertClosedPanelReleasesWorkspace(activePage: Page): Promise<void> {
  const layout = await activePage.evaluate(() => {
    const shell = document.querySelector(".app-shell")!;
    const workspace = document.querySelector(".workspace")!.getBoundingClientRect();
    return {
      className: shell.className,
      columns: getComputedStyle(shell).gridTemplateColumns,
      panelCount: document.querySelectorAll(".activity-panel").length,
      viewportWidth: window.innerWidth,
      workspaceRight: workspace.right,
    };
  });
  expect(layout.panelCount).toBe(0);
  expect(layout.className).not.toContain("with-panel");
  expect(layout.workspaceRight).toBeGreaterThanOrEqual(layout.viewportWidth - 1);
}

async function assertChatMessageLayout(activePage: Page): Promise<void> {
  const layout = await activePage.evaluate(() => {
    const user = document.querySelector<HTMLElement>(".message.user .message-content")!;
    const assistant = document.querySelector<HTMLElement>(".message.assistant .message-content")!;
    const userBounds = user.getBoundingClientRect();
    const assistantBounds = assistant.getBoundingClientRect();
    return {
      userLeft: userBounds.left,
      userRight: userBounds.right,
      assistantLeft: assistantBounds.left,
      assistantRight: assistantBounds.right,
      userBackground: getComputedStyle(user).backgroundColor,
      userBorderStyle: getComputedStyle(user).borderTopStyle,
      userColor: getComputedStyle(user).color,
    };
  });
  expect(layout.userLeft).toBeGreaterThan(layout.assistantLeft);
  expect(layout.userRight).toBeGreaterThan(layout.assistantRight - 2);
  expect(layout.userBackground).toBe("rgb(144, 221, 101)");
  expect(layout.userBorderStyle).toBe("none");
  expect(layout.userColor).toBe("rgb(17, 17, 17)");
}

async function openThreadActions(activePage: Page, title: string): Promise<void> {
  const wrapper = getThreadRow(activePage, title).locator("..");
  await wrapper.hover();
  await wrapper.getByRole("button", { name: `Thread actions for ${title}` }).click();
}

function getThreadRow(activePage: Page, title: string) {
  return activePage.locator(".thread-row").filter({ hasText: title });
}

async function sendSyncEvent(app: ElectronApplication, event: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("sync:event", value);
  }, event);
}

async function sendAgentMessage(app: ElectronApplication, message: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("agent:message", value);
  }, message);
}

async function ipcCalls(app: ElectronApplication, channel: string): Promise<Array<{ channel: string; args: unknown[] }>> {
  return app.evaluate((_electron, selectedChannel) => {
    const state = (globalThis as any).__rhzycodeUiTest as {
      calls?: Array<{ channel: string; args: unknown[] }>;
    } | undefined;
    return (state?.calls || []).filter((call) => call.channel === selectedChannel);
  }, channel);
}

async function failNextTurn(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const state = (globalThis as any).__rhzycodeUiTest as { failNextTurn?: boolean } | undefined;
    if (state) state.failNextTurn = true;
  });
}

async function installDeterministicIpc(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, fixture) => {
    const threads = new Map<string, Record<string, unknown>>();
    let threadSequence = 0;
    let terminal: Record<string, unknown> | null = null;
    let gatewayState = "running";
    let syncPort = 8790;
    let credentialStatus = {
      encryptionAvailable: true,
      providers: [
        {
          providerId: "sub2api",
          name: "sub2api",
          baseUrl: "https://model.rhzy.ai/v1",
          protocol: "responses",
          detectedProtocol: "responses",
          models: ["gpt-5.5"],
          custom: false,
          configured: true,
          source: "secure_store",
        },
      ],
    };
    let mobileAccessStatus = {
      accessKey: {
        key: `rhzy_${"A".repeat(43)}`,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      } as Record<string, unknown> | null,
      audit: [],
    };
    const testState = {
      calls: [] as Array<{ channel: string; args: unknown[] }>,
      failNextTurn: false,
    };
    (globalThis as any).__rhzycodeUiTest = testState;
    const record = (channel: string, ...args: unknown[]) => {
      testState.calls.push({ channel, args });
    };
    const gatewayStatus = () => ({
      state: gatewayState,
      transport: "internal",
      providerCount: 2,
      modelCount: 2,
      configSource: "ui-test",
      providers: [],
      models: [],
      error: null,
    });
    const syncStatus = () => ({
      state: "running",
      host: "192.168.1.25",
      port: syncPort,
      url: `http://192.168.1.25:${syncPort}`,
      error: null,
    });
    const replace = (channel: string, handler: (...args: any[]) => unknown) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };

    replace("agent:status", () => ({ state: "connected", error: null }));
    replace("agent:connect", () => {
      record("agent:connect");
      return { state: "connected", error: null };
    });
    replace("agent:models", () => ({
      data: [
        {
          id: "ui-model",
          model: "ui/model",
          displayName: "UI test model",
          description: "Deterministic renderer test model",
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
        {
          id: "ui-model-second",
          model: "ui/second",
          displayName: "UI second model",
          description: "Second model for selector coverage",
          defaultReasoningEffort: "low",
        },
        {
          id: "ui-gemma-model",
          model: "provider-2/gemma-4-31b-it-uncensored-bf16",
          displayName: "FakerModel - gemma-4-31b-it-uncensored-bf16",
          description: "Targeted Gemma recovery model",
          defaultReasoningEffort: "none",
        },
      ],
    }));
    replace("agent:threads", (_event, options = {}) => [...threads.values()]
      .filter((thread) => Boolean(thread.archived) === Boolean(options.archived))
      .filter((thread) => !options.cwd || thread.projectPath === options.cwd)
      .filter((thread) => !options.searchTerm
        || String(thread.title).toLowerCase().includes(String(options.searchTerm).toLowerCase()))
      .map(({ archived: _archived, ...thread }) => thread));
    replace("agent:thread:start", (_event, params) => {
      threadSequence += 1;
      const id = threadSequence === 1 ? "ui-thread" : `ui-thread-${threadSequence}`;
      threads.set(id, {
        id,
        hostId: "local-desktop",
        title: threadSequence === 1 ? "UI automation thread" : "New task",
        projectPath: params.cwd,
        model: params.model || "ui/model",
        status: "idle",
        updatedAt: new Date().toISOString(),
        archived: false,
      });
      return { thread: { id } };
    });
    replace("agent:thread:open", (_event, threadId) => {
      record("agent:thread:open", threadId);
      const thread = threads.get(threadId);
      if (!thread) throw new Error("Thread not found");
      const { archived: _archived, ...summary } = thread;
      return {
        thread: summary,
        messages: [
          { id: "history-user", role: "user", content: "Please review the current project and summarize the important risks." },
          { id: "history-assistant", role: "assistant", content: "I will inspect the project structure, trace the main workflows, and report concrete findings." },
        ],
        timeline: [],
      };
    });
    replace("agent:thread:rename", (_event, threadId, name) => {
      record("agent:thread:rename", threadId, name);
      const thread = threads.get(threadId);
      if (thread) threads.set(threadId, { ...thread, title: name });
    });
    replace("agent:thread:archive", (_event, threadId) => {
      record("agent:thread:archive", threadId);
      const thread = threads.get(threadId);
      if (thread) threads.set(threadId, { ...thread, archived: true });
    });
    replace("agent:thread:unarchive", (_event, threadId) => {
      record("agent:thread:unarchive", threadId);
      const thread = threads.get(threadId);
      if (thread) threads.set(threadId, { ...thread, archived: false });
    });
    replace("agent:thread:delete", (_event, threadId) => {
      record("agent:thread:delete", threadId);
      threads.delete(threadId);
    });
    replace("agent:turn:start", (_event, params) => {
      record("agent:turn:start", params);
      if (testState.failNextTurn) {
        testState.failNextTurn = false;
        throw new Error("Deterministic turn failure");
      }
      const thread = threads.get(params.threadId);
      if (thread) {
        const currentTitle = String(thread.title || "New task");
        threads.set(params.threadId, {
          ...thread,
          title: currentTitle === "New task" ? String(params.text).replace(/\s+/g, " ").slice(0, 60) : currentTitle,
          model: params.model || thread.model,
          status: "running",
          updatedAt: new Date().toISOString(),
        });
      }
      return { turn: { id: `ui-turn-${testState.calls.length}` } };
    });
    replace("agent:turn:interrupt", (_event, threadId) => {
      record("agent:turn:interrupt", threadId);
      const thread = threads.get(threadId);
      if (thread) threads.set(threadId, { ...thread, status: "interrupted", updatedAt: new Date().toISOString() });
      return {};
    });
    replace("gateway:status", () => gatewayStatus());
    replace("gateway:start", () => {
      record("gateway:start");
      gatewayState = "running";
      return gatewayStatus();
    });
    replace("gateway:stop", () => {
      record("gateway:stop");
      gatewayState = "stopped";
      return gatewayStatus();
    });
    replace("gateway:restart", () => {
      record("gateway:restart");
      gatewayState = "running";
      return gatewayStatus();
    });
    replace("gateway:probe", () => {
      record("gateway:probe");
      return gatewayStatus();
    });
    replace("credentials:status", () => credentialStatus);
    replace("credentials:set", (_event, providerId, apiKey) => {
      record("credentials:set", providerId, apiKey);
      credentialStatus = {
        encryptionAvailable: true,
        providers: credentialStatus.providers.map((provider) => provider.providerId === providerId
            ? {
              ...provider,
              configured: Boolean(apiKey),
              source: apiKey ? "secure_store" : "missing",
            }
          : provider),
      };
      return { credentials: credentialStatus, gateway: gatewayStatus(), gatewayError: null };
    });
    replace("providers:configure", (_event, input) => {
      record("providers:configure", input);
      const provider = {
        providerId: input.providerId,
        name: input.name,
        baseUrl: input.baseUrl,
        protocol: input.protocol,
        detectedProtocol: input.protocol === "auto" ? "responses" : input.protocol,
        models: input.models,
        custom: !credentialStatus.providers.some((entry) => entry.providerId === input.providerId && !entry.custom),
        configured: true,
        source: "secure_store",
      };
      credentialStatus = {
        ...credentialStatus,
        providers: [
          ...credentialStatus.providers.filter((entry) => entry.providerId !== input.providerId),
          provider,
        ],
      };
      return { credentials: credentialStatus, gateway: gatewayStatus(), gatewayError: null };
    });
    replace("providers:remove", (_event, providerId) => {
      record("providers:remove", providerId);
      credentialStatus = {
        ...credentialStatus,
        providers: credentialStatus.providers.filter((provider) => provider.providerId !== providerId),
      };
      return { credentials: credentialStatus, gateway: gatewayStatus(), gatewayError: null };
    });
    replace("updates:status", () => ({
      enabled: true,
      state: "idle",
      version: null,
      percent: null,
      error: null,
    }));
    replace("updates:check", () => {
      record("updates:check");
      return { enabled: true, state: "available", version: "0.2.0", percent: null, error: null };
    });
    replace("updates:download", () => {
      record("updates:download");
      return { enabled: true, state: "downloaded", version: "0.2.0", percent: 100, error: null };
    });
    replace("updates:install", () => {
      record("updates:install");
    });
    replace("storage:status", () => ({
      encryptionAvailable: true,
      controlState: "restored",
      mobileAccessState: "restored",
    }));
    replace("clipboard:write", (_event, value) => {
      record("clipboard:write", value);
    });
    replace("sync:status", () => syncStatus());
    replace("sync:port:set", (_event, value) => {
      record("sync:port:set", value);
      syncPort = value;
      return syncStatus();
    });
    replace("sync:snapshot", () => ({
      hosts: [],
      threads: [],
      timeline: [],
      approvals: [],
      userInputs: [],
      lastSequence: 0,
    }));
    replace("sync:approval:resolve", (_event, id, decision) => {
      record("sync:approval:resolve", id, decision);
      return { type: "approval.resolved", sequence: 1, approvalId: id, decision };
    });
    replace("sync:user-input:resolve", (_event, id, answers) => {
      record("sync:user-input:resolve", id, answers);
      return { type: "user_input.resolved", sequence: 1, requestId: id };
    });
    replace("mobile-access:status", () => mobileAccessStatus);
    replace("mobile-access:key:rotate", () => {
      record("mobile-access:key:rotate");
      const accessKey = {
        key: `rhzy_${"B".repeat(43)}`,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      mobileAccessStatus = { ...mobileAccessStatus, accessKey };
      return accessKey;
    });
    replace("terminal:status", () => terminal);
    replace("terminal:start", (event, params) => {
      record("terminal:start", params);
      terminal = {
        processId: "ui-terminal",
        cwd: params.cwd || fixture.projectDir,
        running: true,
        exitCode: null,
        output: "",
        error: null,
      };
      event.sender.send("terminal:status", terminal);
      return terminal;
    });
    replace("terminal:write", (_event, processId, data) => {
      record("terminal:write", processId, data);
      return {};
    });
    replace("terminal:resize", () => ({}));
    replace("terminal:stop", (event) => {
      record("terminal:stop", terminal?.processId);
      terminal = terminal ? { ...terminal, running: false, exitCode: 0 } : null;
      event.sender.send("terminal:status", terminal);
      return {};
    });
  }, { projectDir });
}
