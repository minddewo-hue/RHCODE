import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
  type PageAssertionsToHaveScreenshotOptions,
} from "@playwright/test";
import { _electron as electron } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

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
let generatedImagePath: string;
const rendererErrors: string[] = [];

async function expectScreenshot(
  target: Page | Locator,
  name: string,
  options: PageAssertionsToHaveScreenshotOptions,
): Promise<void> {
  const pageOptions = target === page
    ? {
        ...options,
        clip: name === "desktop-standard-window.png"
          ? { x: 0, y: 0, width: 1428, height: 843 }
          : { x: 0, y: 0, width: 1028, height: 623 },
      }
    : options;
  await expect(target as Page).toHaveScreenshot(name, pageOptions);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-playwright-"));
  emptyProjectDir = path.join(dataDir, "empty-project");
  generatedImagePath = path.join(dataDir, "generated-image.png");
  fs.mkdirSync(emptyProjectDir);
  writeGeneratedImageFixture(generatedImagePath);
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
      RHZYCODE_SKIP_ENVIRONMENT_MIGRATION: "1",
      RHZYCODE_OZONE_PLATFORM: process.platform === "linux" ? "x11" : "",
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
  await expect.poll(() => page.evaluate(() => window.rhzycode.getMobileAccessStatus()
    .then((status) => status.accessKey))).toBeNull();
  await installDeterministicIpc(electronApp);
  await page.reload();
  await page.locator(".app-shell").waitFor();
  rendererErrors.length = 0;
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setMinimumSize(1, 1);
    window?.setContentSize(1027, 622);
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

test("shows a complete empty state on a fresh install", async () => {
  await expect(page.getByText("Select a project", { exact: true })).toBeVisible();
  await expect(page.locator(".project-group")).toHaveCount(0);
  await expect(page.locator(".thread-row")).toHaveCount(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("No providers configured", { exact: true })).toBeVisible();
  await expect(page.locator(".credential-row")).toHaveCount(0);
  await expect(page.locator(".settings-view input, .settings-view select, .settings-view textarea")).toHaveCount(0);
  await expect(page.getByText("Not generated", { exact: true })).toBeVisible();
  await expect(page.locator(".connection-field > div")).toHaveCSS("border-top-style", "none");
  await expect(page.locator(".connection-field > div")).toHaveCSS("background-color", "rgb(29, 37, 55)");
  await expect(page.getByRole("button", { name: "Generate key", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add provider" }).click();
  await expect(page.getByText("New provider", { exact: true })).toBeVisible();
  await expect(page.getByLabel("ID", { exact: true })).toBeEditable();
  await expect(page.getByLabel("Name", { exact: true })).toBeEditable();
  await expect(page.getByLabel("URL", { exact: true })).toBeEditable();
  await expect(page.getByLabel("KEY", { exact: true })).toBeEditable();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".settings-view input, .settings-view select, .settings-view textarea")).toHaveCount(0);
  await expect(page.locator(".model-select option").first()).toHaveCSS("background-color", "rgb(21, 28, 43)");
  await page.getByRole("radio", { name: "Day", exact: true }).click();
  await page.getByRole("button", { name: "Close Settings" }).click();
});

test("keeps the composer mouse-editable when starting blank tasks", async () => {
  await page.getByRole("button", { name: "Open project folder" }).click();
  const taskPrompt = page.getByRole("textbox", { name: "Task prompt" });
  for (let index = 0; index < 12; index += 1) {
    await clickSelectedProjectNewTask(page);
    await expect(taskPrompt).toBeEditable();
    await taskPrompt.click();
    await page.keyboard.type(`responsive-${index}`);
    await expect(taskPrompt).toHaveValue(`responsive-${index}`);
  }

  await taskPrompt.fill("");
  expect(rendererErrors.filter((message) => /same key|maximum update depth/i.test(message))).toEqual([]);
});

test("keeps the composer mouse-editable across focus transitions", async () => {
  const taskPrompt = page.getByRole("textbox", { name: "Task prompt" });

  await test.step("after closing a modal with Escape", async () => {
    await clickSelectedProjectNewTask(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await typeAndClearComposer(page, taskPrompt, "Typed after closing settings");
  });

  await test.step("after returning from the terminal", async () => {
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(taskPrompt).toHaveCount(0);
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await typeAndClearComposer(page, taskPrompt, "Typed after returning from terminal");
  });

  await test.step("after sidebar search held focus", async () => {
    const search = page.getByPlaceholder("Search projects and tasks");
    await search.focus();
    await expect(search).toBeFocused();
    await clickSelectedProjectNewTask(page);
    await typeAndClearComposer(page, taskPrompt, "Typed after sidebar search");
  });

  await test.step("after the Electron window is reactivated", async () => {
    await taskPrompt.evaluate((element) => element.blur());
    await expect(taskPrompt).not.toBeFocused();
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      const focusWindow = new BrowserWindow({
        width: 100,
        height: 100,
        x: -10_000,
        y: -10_000,
        show: true,
        skipTaskbar: true,
      });
      await focusWindow.loadURL("data:text/html,<title>Focus handoff</title>");
      focusWindow.focus();
      await new Promise((resolve) => setTimeout(resolve, 100));
      focusWindow.close();
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.focus();
      if (process.platform === "linux" && !mainWindow?.isFocused()) mainWindow?.emit("focus");
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await typeAndClearComposer(page, taskPrompt, "Typed after window reactivation");
  });

  await test.step("with Chinese and multiline input", async () => {
    await clickSelectedProjectNewTask(page);
    await taskPrompt.click();
    await page.keyboard.insertText("中文输入测试");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.insertText("第二行");
    await expect(taskPrompt).toHaveValue("中文输入测试\n第二行");
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await expect(taskPrompt).toHaveValue("");
  });
});

test("supports core desktop workflows at the minimum window size", async () => {
  await assertVisibleControlsHaveNames(page);
  await assertMinimumWindowLayout(page);
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  const modelSelect = page.getByRole("combobox", { name: "Model for next turn" });
  await modelSelect.selectOption("ui/second");
  await expect(modelSelect).toHaveValue("ui/second");
  await modelSelect.selectOption("ui/model");

  const activityToggle = page.getByRole("button", { name: "Activity", exact: true });
  await expect(activityToggle).toHaveAttribute("aria-pressed", "true");
  await activityToggle.focus();
  await page.keyboard.press("Enter");
  await expect(activityToggle).toHaveAttribute("aria-pressed", "false");
  await activityToggle.click();
  await expect(activityToggle).toHaveAttribute("aria-pressed", "true");
  await assertSidePanelDoesNotCoverWorkspace(page);
  await expectScreenshot(page, "desktop-minimum-panel-open.png", {
    animations: "disabled",
    caret: "hide",
    maskColor: "#d8dcd6",
    mask: [page.locator(".model-select")],
  });
  await activityToggle.click();
  await expect(activityToggle).toHaveAttribute("aria-pressed", "false");
  await assertClosedPanelReleasesWorkspace(page);

  await expect(page.getByRole("button", { name: "Show archived tasks" })).toHaveCount(0);
  const openProjectFolder = page.getByRole("button", { name: "Open project folder" });
  await openProjectFolder.focus();
  await page.keyboard.press("Enter");
  const projectMenu = page.locator(".project-group-main").filter({
    has: page.getByText("project", { exact: true }),
  });
  await expect(projectMenu).toBeVisible();
  const differentlyCasedProjectDir = projectDir.replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
  if (differentlyCasedProjectDir !== projectDir) {
    await electronApp.evaluate(({ BrowserWindow }, projectPath) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("projects:changed", [{ path: projectPath, name: "project" }]);
    }, differentlyCasedProjectDir);
    await expect(page.locator(".project-group.selected")).toContainText("project");
  }
  await expect(projectMenu).toHaveAttribute("aria-expanded", "true");
  await projectMenu.click();
  await expect(projectMenu).toHaveAttribute("aria-expanded", "false");
  await projectMenu.click();
  await expect(projectMenu).toHaveAttribute("aria-expanded", "true");

  await page.getByRole("button", { name: "Attach files or images" }).click();
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove notes.txt" }).click();
  await expect(page.getByText("notes.txt", { exact: true })).toBeHidden();
  const prompt = page.getByRole("textbox", { name: "Task prompt" });
  await pasteImage(prompt, "clipboard.png");
  await expect(page.getByText("clipboard.png", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove clipboard.png" }).click();
  await expect(page.getByText("clipboard.png", { exact: true })).toBeHidden();
  await dropFilesOnComposer(page, [attachmentPath, generatedImagePath]);
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  await expect(page.getByText("generated-image.png", { exact: true })).toBeVisible();
  await expect(page.locator(".attachment-chip.image").getByText("generated-image.png", { exact: true })).toBeVisible();
  await expect.poll(() => ipcCalls(electronApp, "project:resolve-dropped-files").then((calls) => calls.at(-1)?.args)).toEqual([
    [attachmentPath, generatedImagePath],
  ]);
  await page.getByRole("button", { name: "Remove notes.txt" }).click();
  await page.getByRole("button", { name: "Remove generated-image.png" }).click();
  await page.getByRole("button", { name: "Attach files or images" }).click();
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  await pasteImage(prompt, "clipboard-send.png");
  await expect(page.getByText("clipboard-send.png", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Sandbox policy" }).selectOption("read-only");
  await page.getByRole("combobox", { name: "Approval mode" }).selectOption("untrusted");
  await expect(page.getByRole("combobox", { name: "Sandbox policy" })).toHaveValue("read-only");
  await expect(page.getByRole("combobox", { name: "Approval mode" })).toHaveValue("untrusted");

  await expectScreenshot(page, "desktop-minimum-window.png", {
    animations: "disabled",
    caret: "hide",
    maskColor: "#d8dcd6",
    mask: [
      page.locator(".model-select"),
      page.locator(".project-group-main small"),
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
  const threadSearch = page.getByRole("textbox", { name: "Search projects and tasks" });
  await threadSearch.fill("missing thread");
  await expect(page.getByText("No matching projects or tasks", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(threadSearch).toHaveValue("");
  await expect(threadRow).toBeVisible();
  await threadRow.click();
  await expect(threadRow.locator("..")).toHaveClass(/active/);
  await expect(page.locator(".project-group.selected")).toContainText("project");
  await expect.poll(() => ipcCalls(electronApp, "agent:thread:open").then((calls) => calls.length)).toBe(1);
  await expect(page.locator(".message-avatar")).toHaveCount(0);
  await expect(page.locator(".message-list .message-author")).toHaveCount(0);
  await assertClosedPanelReleasesWorkspace(page);
  await assertChatMessageLayout(page);
  await threadRow.click();
  await expect(page.getByText("Please review the current project and summarize the important risks.", { exact: true })).toBeVisible();
  await expect(page.getByText("I will inspect the project structure, trace the main workflows, and report concrete findings.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open notes.txt" }).click();
  await expect.poll(() => ipcCalls(electronApp, "project:open-local-file").then((calls) => calls.at(-1)?.args)).toEqual([attachmentPath]);
  await page.getByRole("button", { name: "Show notes.txt in folder" }).click();
  await expect.poll(() => ipcCalls(electronApp, "project:reveal-local-file").then((calls) => calls.at(-1)?.args)).toEqual([attachmentPath]);
  expect(await ipcCalls(electronApp, "agent:thread:open")).toHaveLength(1);
  await expectScreenshot(page, "desktop-chat-layout-lime.png", {
    animations: "disabled",
    caret: "hide",
    maskColor: "#d8dcd6",
    mask: [page.locator(".model-select"), page.locator(".project-group-main small")],
  });

  await sendAgentMessage(electronApp, {
    method: "item/completed",
    params: {
      threadId,
      item: {
        id: "ui-generated-image",
        type: "imageGeneration",
        status: "completed",
        savedPath: generatedImagePath,
        name: "generated-image.png",
      },
    },
  });
  const generatedImage = page.locator(".message-image-wrap.generated .message-image");
  await expect(generatedImage).toBeVisible();
  await expect.poll(() => generatedImage.locator("img").evaluate((image: HTMLImageElement) => ({
    width: image.naturalWidth,
    height: image.naturalHeight,
  }))).toEqual({ width: 320, height: 240 });
  const generatedImageLayout = await generatedImage.evaluate((element) => {
    const wrapper = element.parentElement!.getBoundingClientRect();
    const button = element.getBoundingClientRect();
    const image = element.querySelector("img")!.getBoundingClientRect();
    return {
      wrapper: { width: wrapper.width, height: wrapper.height },
      button: { width: button.width, height: button.height },
      image: { width: image.width, height: image.height },
    };
  });
  expect(generatedImageLayout.wrapper.width / generatedImageLayout.wrapper.height).toBeCloseTo(4 / 3, 2);
  expect(generatedImageLayout.button).toEqual(generatedImageLayout.wrapper);
  expect(generatedImageLayout.wrapper.width - generatedImageLayout.image.width).toBeGreaterThanOrEqual(1);
  expect(generatedImageLayout.wrapper.width - generatedImageLayout.image.width).toBeLessThanOrEqual(2);
  expect(generatedImageLayout.wrapper.height - generatedImageLayout.image.height).toBeGreaterThanOrEqual(1);
  expect(generatedImageLayout.wrapper.height - generatedImageLayout.image.height).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: "Save generated-image.png" })).toHaveCount(0);
  await generatedImage.click({ button: "right" });
  await expect.poll(() => ipcCalls(electronApp, "project:show-image-context-menu").then((calls) => calls.at(-1)?.args)).toEqual([
    generatedImagePath,
    "generated-image.png",
  ]);
  await page.locator(".conversation").evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(() => page.locator(".conversation").evaluate((element) => element.scrollTop)).toBe(0);
  await expectScreenshot(page, "desktop-generated-image.png", {
    animations: "disabled",
    caret: "hide",
    maskColor: "#d8dcd6",
    mask: [page.locator(".model-select"), page.locator(".project-group-main small")],
  });
  await generatedImage.click();
  const closeImagePreview = page.getByRole("button", { name: "Close image preview" });
  await expect(closeImagePreview).toBeVisible();
  await closeImagePreview.click({ position: { x: 5, y: 5 } });
  await expect(closeImagePreview).toBeHidden();

  await sendAgentMessage(electronApp, {
    method: "item/completed",
    params: {
      threadId,
      item: {
        id: "ui-sent-image",
        type: "userMessage",
        content: [{ type: "text", text: "Sent image" }],
        files: [{
          id: "ui-sent-image-file",
          path: generatedImagePath,
          name: "sent-image.png",
          size: 68,
          mimeType: "image/png",
          source: "upload",
        }],
      },
    },
  });
  const sentImage = page.locator(".message.user .message-image").last();
  await expect(sentImage).toBeVisible();
  await expect.poll(() => sentImage.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return Math.round((bounds.width / bounds.height) * 100) / 100;
  })).toBe(1.33);
  await sentImage.click({ button: "right" });
  await expect.poll(() => ipcCalls(electronApp, "project:show-image-context-menu").then((calls) => calls.at(-1)?.args)).toEqual([
    generatedImagePath,
    "sent-image.png",
  ]);

  await modelSelect.selectOption("provider-2/gemma-4-31b-it-uncensored-bf16");
  await sendAgentMessage(electronApp, {
    method: "error",
    params: {
      threadId,
      turnId: "failed-gemma-turn",
      willRetry: false,
      error: { message: "Targeted Gemma failure" },
    },
  });
  await modelSelect.selectOption("ui/model");
  await expect(getThreadRow(page, "UI automation thread").locator("..")).toHaveClass(/active/);
  await expect(page.getByText("Please review the current project and summarize the important risks.", { exact: true })).toBeVisible();
  await expect(page.getByText("I will inspect the project structure, trace the main workflows, and report concrete findings.", { exact: true })).toBeVisible();
  await expect(generatedImage).toBeVisible();

  const openCallsBeforeReload = await ipcCalls(electronApp, "agent:thread:open").then((calls) => calls.length);
  await page.reload();
  await page.locator(".app-shell").waitFor();
  await expect(page.locator(".project-group.selected")).toContainText("project");
  await expect(getThreadRow(page, "UI automation thread").locator("..")).toHaveClass(/active/);
  await expect(page.locator(".model-select")).toHaveValue("ui/model");
  await expect.poll(() => ipcCalls(electronApp, "agent:thread:open").then((calls) => calls.length))
    .toBeGreaterThan(openCallsBeforeReload);
  if (await page.getByRole("button", { name: "Activity", exact: true }).getAttribute("aria-pressed") === "true") {
    await page.getByRole("button", { name: "Activity", exact: true }).click();
  }

  await openThreadActions(page, "UI automation thread");
  const initialThreadMenu = page.getByRole("menu");
  await expect(initialThreadMenu).toBeVisible();
  await assertMenuInsideViewport(initialThreadMenu);
  await expectScreenshot(page, "desktop-thread-menu.png", {
    animations: "disabled",
    caret: "hide",
    maskColor: "#d8dcd6",
    mask: [page.locator(".model-select"), page.locator(".project-group-main small")],
  });
  await page.locator(".workspace-header").click();
  await expect(initialThreadMenu).toBeHidden();
  await openThreadActions(page, "UI automation thread");
  const threadActionsTrigger = page.getByRole("button", { name: "Thread actions for UI automation thread" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(threadActionsTrigger).toBeFocused();

  await openThreadActions(page, "UI automation thread");
  await page.getByRole("menuitem", { name: "Archive task" }).click();
  await expect(getThreadRow(page, "UI automation thread")).toBeHidden();
  await expect.poll(() => ipcCalls(electronApp, "agent:thread:archive").then((calls) => calls.at(-1)?.args)).toEqual([threadId]);
  await expect(page.getByRole("button", { name: "Show archived tasks" })).toHaveCount(0);
  await page.evaluate((id) => window.rhzycode.unarchiveThread(id), threadId);
  await expect.poll(() => ipcCalls(electronApp, "agent:thread:unarchive").then((calls) => calls.at(-1)?.args)).toEqual([threadId]);
  await page.reload();
  await page.locator(".app-shell").waitFor();
  await expect(getThreadRow(page, "UI automation thread")).toBeVisible();
  if (await page.getByRole("button", { name: "Activity", exact: true }).getAttribute("aria-pressed") === "true") {
    await page.getByRole("button", { name: "Activity", exact: true }).click();
  }

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
  await page.getByRole("menuitem", { name: "Delete task permanently" }).click();
  const deleteConversationDialog = page.getByRole("dialog", { name: "Delete conversation" });
  await expect(deleteConversationDialog).toBeVisible();
  await expect(deleteConversationDialog.locator(".modal-actions button")).toHaveText([
    "Permanently delete conversation",
    "Cancel",
  ]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(getThreadRow(page, "Renamed UI thread")).toBeVisible();
  await openThreadActions(page, "Renamed UI thread");
  await page.getByRole("menuitem", { name: "Delete task permanently" }).click();
  await confirmThreadDeletion(page);
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

  await page.getByRole("button", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Mobile access", { exact: true })).toBeVisible();
  await expect(page.getByText("Local state protection", { exact: true })).toHaveCount(0);
  await assertVisibleControlsHaveNames(page);
  await expect(page.locator(".credential-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Add provider" }).click();
  await page.getByLabel("ID", { exact: true }).fill("sub2api");
  await page.getByLabel("Name", { exact: true }).fill("Sub2API");
  await page.getByLabel("URL", { exact: true }).fill("https://model.rhzy.ai/v1");
  await page.getByLabel("KEY", { exact: true }).fill("ui-test-key");
  await page.locator(".provider-editor select").selectOption("responses");
  await page.getByLabel("Models (optional)", { exact: true }).fill("gpt-5.5");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const sub2apiCredential = page.locator(".credential-row").filter({ hasText: "Sub2API API key" });
  await expect(page.locator(".credential-row")).toHaveCount(1);
  await expect(sub2apiCredential).toContainText("model.rhzy.ai");
  await expect(sub2apiCredential).toContainText("KEY starts with sk-");
  await expect(sub2apiCredential.locator("input, select, textarea")).toHaveCount(0);
  await sub2apiCredential.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".provider-editor-readonly")).toContainText("sub2api");
  await expect(page.locator(".provider-editor input:disabled")).toHaveCount(0);
  await page.getByLabel("KEY", { exact: true }).fill("ui-test-key-updated");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => ipcCalls(electronApp, "providers:configure").then((calls) => calls.at(-1)?.args[0])).toMatchObject({
    providerId: "sub2api",
    apiKey: "ui-test-key-updated",
  });
  await page.locator(".settings-view").evaluate((element) => { element.scrollTop = 0; });
  await expectScreenshot(page, "desktop-provider-credentials.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.025,
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

  await page.getByRole("button", { name: "Generate key", exact: true }).click();
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
  await page.getByRole("button", { name: "Copy access key" }).click();
  await expect.poll(() => ipcCalls(electronApp, "clipboard:write").then((calls) => calls.at(-1)?.args[0]))
    .toBe(`rhzy_${"B".repeat(43)}`);
  await installDeterministicUpdate(page);
  await expect.poll(() => ipcCalls(electronApp, "updates:check").then((calls) => calls.length)).toBeGreaterThan(0);
  await expect.poll(() => ipcCalls(electronApp, "updates:download").then((calls) => calls.length)).toBeGreaterThan(0);
  await expect.poll(() => ipcCalls(electronApp, "updates:install").then((calls) => calls.length)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Close Settings" }).click();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.locator(".skill-row")).toHaveCount(2);
  await expect(page.getByText("Review Helper", { exact: true })).toBeVisible();
  await expect(page.getByText("System Writer", { exact: true })).toBeVisible();
  await page.getByRole("switch", { name: "Disable Review Helper" }).click();
  await expect.poll(() => ipcCalls(electronApp, "skills:enabled:set").then((calls) => calls.at(-1)?.args)).toEqual([
    path.join(dataDir, "codex-home", "skills", "review-helper", "SKILL.md"),
    false,
  ]);
  await page.getByRole("button", { name: /Codex 1/ }).click();
  await expect(page.getByText("Imported 1; skipped 0.", { exact: true })).toBeVisible();
  await Promise.all([
    page.waitForEvent("dialog").then((dialog) => dialog.accept()),
    page.getByRole("button", { name: "Delete Review Helper" }).click(),
  ]);
  await expect(page.getByText("Review Helper", { exact: true })).toHaveCount(0);
  await expectScreenshot(page.locator(".skills-view"), "desktop-skills.png", {
    animations: "disabled",
    caret: "hide",
  });
  await assertVisibleControlsHaveNames(page);
  await page.getByRole("button", { name: "Close Skills" }).click();

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
  await expect(getSelectedProjectNewTask(page)).toBeEnabled();
  await expect(page.getByRole("button", { name: "Open project folder" })).toBeEnabled();
  await expect(modelSelect).toBeEnabled();

  await modelSelect.selectOption("ui/second");
  await clickSelectedProjectNewTask(page);
  await expect(taskPrompt).toBeEditable();
  await taskPrompt.fill("Run concurrent second task");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => ipcCalls(electronApp, "agent:turn:start").then((calls) => calls.length)).toBe(2);
  await expect(page.locator(".send-button.stop")).toBeVisible();
  await expect(getThreadRow(page, "Run deterministic verification")).toBeVisible();
  await expect(getThreadRow(page, "Run concurrent second task")).toBeVisible();

  await setThreadOpenDelay(electronApp, 600);
  await getThreadRow(page, "Run deterministic verification").click();
  await expect(page.getByRole("article").getByText("Run deterministic verification", { exact: true })).toBeVisible({ timeout: 200 });
  await expect(page.getByText("Start a new task", { exact: true })).toHaveCount(0);
  await expect(page.locator(".conversation-refresh")).toBeVisible();
  await expect(page.locator(".conversation-refresh")).toHaveCount(0, { timeout: 2_000 });
  await setThreadOpenDelay(electronApp, 0);
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
  await clickSelectedProjectNewTask(page);
  await expect(taskPrompt).toBeEditable();
  await expect(taskPrompt).toHaveValue("");
  await expect(page.locator(".attachment-list")).toHaveCount(0);
  await expect(page.locator(".message-list")).toHaveCount(0);
  await expect(page.getByText("Start a new task", { exact: true })).toBeVisible();

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1427, 842);
  });
  await expectScreenshot(page, "desktop-standard-window.png", {
    animations: "disabled",
    caret: "hide",
    maskColor: "#d8dcd6",
    mask: [page.locator(".project-group-main small")],
  });

  await modelSelect.selectOption("provider-2/gemma-4-31b-it-uncensored-bf16");
  await failNextTurn(electronApp);
  await taskPrompt.fill("Recover this prompt with another model");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  const failedCall = (await ipcCalls(electronApp, "agent:turn:start")).at(-1);
  await modelSelect.selectOption("ui/model");
  await expect(page.getByText("Start a new task", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("article").getByText("Recover this prompt with another model", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => ipcCalls(electronApp, "agent:turn:start").then((calls) => {
    const latest = calls.at(-1)?.args[0] as { threadId?: string; model?: string } | undefined;
    const failed = failedCall?.args[0] as { threadId?: string } | undefined;
    return { model: latest?.model, changedThread: latest?.threadId !== failed?.threadId };
  })).toEqual({ model: "ui/model", changedThread: false });
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
  await page.getByRole("button", { name: "Open project folder" }).click();
  await expect(page.locator(".project-group.selected")).toContainText("empty-project");
  const emptyProjectGroup = page.locator(".project-group").filter({ hasText: "empty-project" });
  await expect(emptyProjectGroup.getByRole("button", { name: "New task in project empty-project" })).toBeVisible();
  await expect(getThreadRow(page, "Run deterministic verification")).toBeVisible();
  await expect(page.getByText("Start a new task", { exact: true })).toBeVisible();
  await expect(page.locator(".message-list")).toHaveCount(0);
  await expect(previousProjectMessage).toHaveCount(0);

  await sendAgentMessage(electronApp, {
    method: "item/agentMessage/delta",
    params: { itemId: "late-previous-project-message", delta: "This stale message must stay hidden." },
  });
  await expect(page.getByText("This stale message must stay hidden.", { exact: true })).toHaveCount(0);

  const secondaryProjectDir = path.join(dataDir, "secondary-project");
  await page.evaluate(async ({ primary, secondary }) => {
    for (let index = 0; index < 24; index += 1) {
      await window.rhzycode.startThread({ cwd: index % 2 === 0 ? primary : secondary });
    }
  }, { primary: projectDir, secondary: secondaryProjectDir });
  await page.reload();
  await page.locator(".app-shell").waitFor();
  await expect(page.locator(".project-group")).toHaveCount(3);
  const projectOrderBeforeSelection = await page.locator(".project-group-main strong").allTextContents();
  const secondaryProjectGroup = page.locator(".project-group").filter({ hasText: "secondary-project" });
  await secondaryProjectGroup.scrollIntoViewIfNeeded();
  await secondaryProjectGroup.locator(".project-group-header").hover();
  await expectScreenshot(page, "desktop-project-tree-codex.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixels: 0,
    maskColor: "#d8dcd6",
    mask: [page.locator(".model-select"), page.locator(".project-thread-list")],
  });
  await expect(page.locator(".project-group-main strong")).toHaveText(projectOrderBeforeSelection);
  const projectTreeOverflow = await page.locator(".project-thread-list").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(projectTreeOverflow.scrollHeight).toBeGreaterThan(projectTreeOverflow.clientHeight);
  await page.locator(".project-thread-list").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => page.locator(".project-thread-list").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Import or export conversations" }).click();
  const transferDialog = page.getByRole("dialog", { name: "Import / Export" });
  await expect(transferDialog).toBeVisible();
  await expect(transferDialog.getByRole("button", { name: /^Import from Codex/ })).toBeVisible();
  await expect(transferDialog.getByRole("button", { name: /^Import from Claude/ })).toBeVisible();
  await transferDialog.getByRole("button", { name: /^Import backup/ }).click();
  await expect.poll(() => ipcCalls(electronApp, "conversation:restore").then((calls) => calls.length)).toBe(1);
  await expect(transferDialog.getByText("1 restored, 0 already present", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close Import / Export" }).click();

  await emptyProjectGroup.hover();
  await emptyProjectGroup.getByRole("button", { name: "Permanently delete project empty-project" }).click();
  const deleteProjectDialog = page.getByRole("dialog", { name: "Delete project" });
  await expect(deleteProjectDialog).toBeVisible();
  await expect(deleteProjectDialog.locator(".modal-actions button")).toHaveText([
    "Permanently delete project",
    "Cancel",
  ]);
  await deleteProjectDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(emptyProjectGroup).toBeVisible();
  await expect.poll(() => ipcCalls(electronApp, "project:delete").then((calls) => calls.length)).toBe(0);
  await emptyProjectGroup.hover();
  await emptyProjectGroup.getByRole("button", { name: "Permanently delete project empty-project" }).click();
  await deleteProjectDialog.getByRole("button", { name: "Permanently delete project", exact: true }).click();
  await expect(emptyProjectGroup).toHaveCount(0);
  await expect.poll(() => ipcCalls(electronApp, "project:delete").then((calls) => calls.at(-1)?.args)).toEqual([emptyProjectDir]);
  await page.reload();
  await page.locator(".app-shell").waitFor();
  await expect(page.locator(".project-group")).toHaveCount(2);
  await expect(page.locator(".project-group").filter({ hasText: "empty-project" })).toHaveCount(0);

  expect(rendererErrors).toEqual([]);
});

test("renders sent and received images at their natural aspect ratio with context-menu download", async ({}, testInfo) => {
  await page.getByRole("button", { name: "Open project folder" }).click();
  const threadId = await page.evaluate((cwd) => window.rhzycode.startThread({ cwd })
    .then((result) => result.thread.id), projectDir);
  await sendSyncEvent(electronApp, {
    type: "thread.updated",
    sequence: 20_000,
    thread: {
      id: threadId,
      hostId: "local-desktop",
      title: "Image aspect test",
      projectPath: projectDir,
      model: "ui/model",
      status: "idle",
      updatedAt: new Date().toISOString(),
    },
  });
  await expect(getThreadRow(page, "Image aspect test")).toBeVisible();
  await getThreadRow(page, "Image aspect test").click();
  await expect(getThreadRow(page, "Image aspect test").locator("..")).toHaveClass(/active/);
  await expect(page.getByText(
    "I will inspect the project structure, trace the main workflows, and report concrete findings.",
    { exact: true },
  )).toBeVisible();

  await sendAgentMessage(electronApp, {
    method: "item/completed",
    params: {
      threadId,
      item: {
        id: "aspect-received-image",
        type: "imageGeneration",
        status: "completed",
        savedPath: generatedImagePath,
        name: "received-image.png",
      },
    },
  });
  await sendAgentMessage(electronApp, {
    method: "item/completed",
    params: {
      threadId,
      item: {
        id: "aspect-sent-image",
        type: "userMessage",
        content: [{ type: "text", text: "Sent image aspect check" }],
        files: [{
          id: "aspect-sent-image-file",
          path: generatedImagePath,
          name: "sent-image.png",
          size: 68,
          mimeType: "image/png",
          source: "upload",
        }],
      },
    },
  });

  for (const name of ["received-image.png", "sent-image.png"]) {
    const image = page.locator(".message-image").filter({ has: page.getByRole("img", { name }) });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return Math.round((bounds.width / bounds.height) * 100) / 100;
    })).toBe(1.33);
    await image.click({ button: "right" });
    await expect.poll(() => ipcCalls(electronApp, "project:show-image-context-menu").then((calls) => calls.at(-1)?.args))
      .toEqual([generatedImagePath, name]);
  }
  await expect(page.getByRole("button", { name: /^Save (received|sent)-image\.png$/ })).toHaveCount(0);
  await page.locator(".conversation").screenshot({ path: testInfo.outputPath("image-aspect-layout.png") });
});

test("keeps a new task mouse-editable while the agent is still starting", async () => {
  const threadCallsBeforeReload = await ipcCalls(electronApp, "agent:threads").then((calls) => calls.length);
  const openCallsBeforeReload = await ipcCalls(electronApp, "agent:thread:open").then((calls) => calls.length);
  await page.evaluate(async (selectedProject) => {
    await window.rhzycode.rememberProject(selectedProject);
    const { thread } = await window.rhzycode.startThread({ cwd: selectedProject });
    localStorage.setItem("rhzycode.lastProject", selectedProject);
    localStorage.setItem("rhzycode.recentProjects", JSON.stringify([selectedProject]));
    localStorage.setItem("rhzycode.lastThreads", JSON.stringify({ [selectedProject]: thread.id }));
  }, projectDir);

  await setAgentConnectDelay(electronApp, 5_000);
  try {
    await page.reload();
    await page.locator(".app-shell").waitFor();
    const taskPrompt = page.getByRole("textbox", { name: "Task prompt" });
    await clickSelectedProjectNewTask(page);
    await taskPrompt.click();
    await page.keyboard.type("Typed before the agent finished starting");
    await expect(page.locator(".send-button")).toHaveAttribute("title", "Starting agent");
    await expect(page.locator(".send-button")).toBeDisabled();

    await expect.poll(() => ipcCalls(electronApp, "agent:threads").then((calls) => (
      calls.length - threadCallsBeforeReload
    ))).toBe(1);
    expect(await ipcCalls(electronApp, "agent:thread:open").then((calls) => calls.length))
      .toBe(openCallsBeforeReload);
    await expect(taskPrompt).toHaveValue("Typed before the agent finished starting");
    await expect(taskPrompt).toBeEditable();
  } finally {
    await setAgentConnectDelay(electronApp, 0);
  }
});

test("keeps the composer responsive during dense streaming updates", async () => {
  const openCallsBeforeReload = await ipcCalls(electronApp, "agent:thread:open").then((calls) => calls.length);
  const selectedThreadId = await page.evaluate(async (selectedProject) => {
    await window.rhzycode.rememberProject(selectedProject);
    const { thread } = await window.rhzycode.startThread({ cwd: selectedProject });
    localStorage.setItem("rhzycode.lastProject", selectedProject);
    localStorage.setItem("rhzycode.recentProjects", JSON.stringify([selectedProject]));
    localStorage.setItem("rhzycode.lastThreads", JSON.stringify({ [selectedProject]: thread.id }));
    return thread.id;
  }, projectDir);
  await page.reload();
  await page.locator(".app-shell").waitFor();
  await expect.poll(() => ipcCalls(electronApp, "agent:thread:open").then((calls) => calls.length))
    .toBeGreaterThan(openCallsBeforeReload);
  await expect(page.getByText(
    "I will inspect the project structure, trace the main workflows, and report concrete findings.",
    { exact: true },
  )).toBeVisible();

  await sendStreamingBurst(electronApp, selectedThreadId, 400, 0);
  await expect(page.locator(".message-list .message")).toHaveCount(402);

  const taskPrompt = page.getByRole("textbox", { name: "Task prompt" });
  await sendStreamingBurst(electronApp, selectedThreadId, 0, 2_000);
  const inputStartedAt = Date.now();
  await taskPrompt.fill("Composer stays responsive while output is streaming");
  expect(Date.now() - inputStartedAt).toBeLessThan(5_000);
  await expect(taskPrompt).toHaveValue("Composer stays responsive while output is streaming");
  await expect(page.locator(".message-list .message")).toHaveCount(403);

  await sendAgentMessage(electronApp, {
    method: "turn/completed",
    params: { threadId: selectedThreadId, turnId: "streaming-burst", turn: { status: "completed" } },
  });
});

test("shows a cached conversation immediately while a slow resume refreshes it", async () => {
  await page.getByRole("button", { name: "Open project folder" }).click();
  const taskPrompt = page.getByRole("textbox", { name: "Task prompt" });
  await clickSelectedProjectNewTask(page);
  await taskPrompt.fill("Cached conversation first message");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(getThreadRow(page, "Cached conversation first message")).toBeVisible();

  await clickSelectedProjectNewTask(page);
  await taskPrompt.fill("Cached conversation second message");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(getThreadRow(page, "Cached conversation second message")).toBeVisible();

  await setThreadOpenDelay(electronApp, 2_000);
  await getThreadRow(page, "Cached conversation first message").click();
  await expect(page.getByRole("article").getByText("Cached conversation first message", { exact: true }))
    .toBeVisible({ timeout: 200 });
  await expect(page.getByText("Start a new task", { exact: true })).toHaveCount(0);
  await expect(page.locator(".conversation-refresh")).toBeVisible();
  await taskPrompt.click();
  await page.keyboard.type("Draft typed while conversation refreshes");
  await expect(taskPrompt).toHaveValue("Draft typed while conversation refreshes");
  await expect(page.locator(".conversation-refresh")).toHaveCount(0, { timeout: 4_000 });
  await expect(taskPrompt).toHaveValue("Draft typed while conversation refreshes");
  await expect(taskPrompt).toBeEditable();
  await taskPrompt.fill("");
  await setThreadOpenDelay(electronApp, 0);
});

test("keeps a new task editable when a stale conversation open finishes", async () => {
  const title = "Stale slow conversation open";
  const selectedThreadId = await page.evaluate(async ({ cwd, selectedTitle }) => {
    const result = await window.rhzycode.startThread({ cwd });
    await window.rhzycode.renameThread(result.thread.id, selectedTitle);
    return result.thread.id;
  }, { cwd: projectDir, selectedTitle: title });

  await page.getByRole("button", { name: "Open project folder" }).click();
  await expect(getThreadRow(page, title)).toBeVisible();
  const completedBefore = await ipcCalls(electronApp, "agent:thread:open:completed").then((calls) => calls.length);
  await setThreadOpenDelay(electronApp, 1_500);
  try {
    await getThreadRow(page, title).click();
    await expect.poll(() => ipcCalls(electronApp, "agent:thread:open").then((calls) => calls.at(-1)?.args))
      .toEqual([selectedThreadId]);
    await clickSelectedProjectNewTask(page);

    const taskPrompt = page.getByRole("textbox", { name: "Task prompt" });
    await taskPrompt.click();
    await page.keyboard.type("Immediate input in the replacement task");
    await expect(taskPrompt).toHaveValue("Immediate input in the replacement task");

    await expect.poll(() => ipcCalls(electronApp, "agent:thread:open:completed").then((calls) => calls.length))
      .toBe(completedBefore + 1);
    await expect(taskPrompt).toHaveValue("Immediate input in the replacement task");
    await expect(taskPrompt).toBeEditable();
    await expect(page.getByText("Start a new task", { exact: true })).toBeVisible();
    await taskPrompt.fill("");
  } finally {
    await setThreadOpenDelay(electronApp, 0);
  }
});

test("keeps the selected conversation and draft when deletion finishes late", async () => {
  const sourceTitle = "Delete race source";
  const targetTitle = "Delete race target";
  const sourceThreadId = await page.evaluate(async ({ cwd, sourceTitle, targetTitle }) => {
    const source = await window.rhzycode.startThread({ cwd });
    const target = await window.rhzycode.startThread({ cwd });
    await window.rhzycode.renameThread(source.thread.id, sourceTitle);
    await window.rhzycode.renameThread(target.thread.id, targetTitle);
    return source.thread.id;
  }, { cwd: projectDir, sourceTitle, targetTitle });

  await page.getByRole("button", { name: "Open project folder" }).click();
  await expect(getThreadRow(page, sourceTitle)).toBeVisible();
  await expect(getThreadRow(page, targetTitle)).toBeVisible();
  await getThreadRow(page, sourceTitle).click();
  await expect(getThreadRow(page, sourceTitle).locator("..")).toHaveClass(/active/);

  await setThreadDeleteDelay(electronApp, 750);
  try {
    await openThreadActions(page, sourceTitle);
    await page.getByRole("menuitem", { name: "Delete task permanently" }).click();
    await confirmThreadDeletion(page);
    await expect.poll(() => ipcCalls(electronApp, "agent:thread:delete").then((calls) => calls.at(-1)?.args))
      .toEqual([sourceThreadId]);

    await sendSyncEvent(electronApp, {
      type: "thread.removed",
      sequence: 10_000,
      threadId: sourceThreadId,
    });
    await expect(getThreadRow(page, sourceTitle)).toHaveCount(0);

    await getThreadRow(page, targetTitle).click();
    const taskPrompt = page.getByRole("textbox", { name: "Task prompt" });
    await expect(getThreadRow(page, targetTitle).locator("..")).toHaveClass(/active/);
    await expect(taskPrompt).toBeEditable();
    await taskPrompt.fill("Draft entered while the previous deletion is finishing");

    await expect.poll(() => ipcCalls(electronApp, "agent:thread:delete:completed")
      .then((calls) => calls.at(-1)?.args)).toEqual([sourceThreadId]);
    await expect(getThreadRow(page, targetTitle).locator("..")).toHaveClass(/active/);
    await expect(taskPrompt).toHaveValue("Draft entered while the previous deletion is finishing");
    await expect(taskPrompt).toBeEditable();
  } finally {
    await setThreadDeleteDelay(electronApp, 0);
  }
});

test("keeps the composer usable while deleting and switching conversations repeatedly", async () => {
  const titles = {
    source: "Delete switch source",
    firstTarget: "Delete switch first target",
    secondSource: "Delete switch second source",
    finalTarget: "Delete switch final target",
  };
  const threadIds = await page.evaluate(async ({ cwd, threadTitles }) => {
    const ids: Record<string, string> = {};
    for (const [key, title] of Object.entries(threadTitles)) {
      const result = await window.rhzycode.startThread({ cwd });
      await window.rhzycode.renameThread(result.thread.id, title);
      ids[key] = result.thread.id;
    }
    return ids;
  }, { cwd: projectDir, threadTitles: titles });

  await page.getByRole("button", { name: "Open project folder" }).click();
  await getThreadRow(page, titles.source).click();
  await expect(getThreadRow(page, titles.source).locator("..")).toHaveClass(/active/);

  await setThreadDeleteDelay(electronApp, 1_000);
  try {
    await openThreadActions(page, titles.source);
    await page.getByRole("menuitem", { name: "Delete task permanently" }).click();
    await confirmThreadDeletion(page);
    await expect.poll(() => ipcCalls(electronApp, "agent:thread:delete").then((calls) => calls.at(-1)?.args))
      .toEqual([threadIds.source]);
    await expect(getThreadRow(page, titles.source)).toHaveCount(0);

    await getThreadRow(page, titles.firstTarget).click();
    const taskPrompt = page.getByRole("textbox", { name: "Task prompt" });
    await taskPrompt.click();
    await page.keyboard.type("Draft after first delete and switch. ");

    await openThreadActions(page, titles.secondSource);
    await page.getByRole("menuitem", { name: "Delete task permanently" }).click();
    await confirmThreadDeletion(page);
    await expect.poll(() => ipcCalls(electronApp, "agent:thread:delete").then((calls) => calls.at(-1)?.args))
      .toEqual([threadIds.secondSource]);
    await expect(getThreadRow(page, titles.secondSource)).toHaveCount(0);

    await getThreadRow(page, titles.finalTarget).click();
    await taskPrompt.click();
    await page.keyboard.type("Draft after second delete and switch.");
    await expect(taskPrompt).toHaveValue("Draft after second delete and switch.");

    await getThreadRow(page, titles.firstTarget).click();
    await expect(taskPrompt).toBeEditable();
    await expect(taskPrompt).toHaveValue("Draft after first delete and switch. ");

    await expect.poll(() => ipcCalls(electronApp, "agent:thread:delete:completed").then((calls) => calls.length))
      .toBeGreaterThanOrEqual(2);
    await expect(getThreadRow(page, titles.firstTarget).locator("..")).toHaveClass(/active/);
    await expect(taskPrompt).toBeEditable();
    await expect(taskPrompt).toHaveValue("Draft after first delete and switch. ");
  } finally {
    await setThreadDeleteDelay(electronApp, 0);
  }
});

test("keeps the composer editable when deleting the current conversation slowly", async () => {
  const sourceTitle = "Slow current deletion";
  const sourceThreadId = await page.evaluate(async ({ cwd, title }) => {
    const source = await window.rhzycode.startThread({ cwd });
    await window.rhzycode.renameThread(source.thread.id, title);
    return source.thread.id;
  }, { cwd: projectDir, title: sourceTitle });

  await page.getByRole("button", { name: "Open project folder" }).click();
  await expect(getThreadRow(page, sourceTitle)).toBeVisible();
  const modelSelect = page.getByRole("combobox", { name: "Model for next turn" });
  await modelSelect.selectOption("ui/second");
  await getThreadRow(page, sourceTitle).click();
  await expect(modelSelect).toHaveValue("ui/second");
  await expect(getThreadRow(page, sourceTitle).locator("..")).toHaveClass(/active/);

  await setThreadDeleteDelay(electronApp, 750);
  try {
    await openThreadActions(page, sourceTitle);
    await page.getByRole("menuitem", { name: "Delete task permanently" }).click();
    await confirmThreadDeletion(page);
    await expect.poll(() => ipcCalls(electronApp, "agent:thread:delete").then((calls) => calls.at(-1)?.args))
      .toEqual([sourceThreadId]);

    const taskPrompt = page.getByRole("textbox", { name: "Task prompt" });
    await expect(taskPrompt).toBeEditable();
    await taskPrompt.fill("Draft entered while deleting the current conversation");
    await expect(taskPrompt).toHaveValue("Draft entered while deleting the current conversation");

    await expect.poll(() => ipcCalls(electronApp, "agent:thread:delete:completed")
      .then((calls) => calls.at(-1)?.args)).toEqual([sourceThreadId]);
    await expect(getThreadRow(page, sourceTitle)).toHaveCount(0);
    await expect(taskPrompt).toHaveValue("Draft entered while deleting the current conversation");
    await expect(taskPrompt).toBeEditable();
  } finally {
    await setThreadDeleteDelay(electronApp, 0);
  }
});

test("keeps model selection and composer input usable after deleting the current conversation", async () => {
  const sourceTitle = "Delete then change model";
  const sourceThreadId = await page.evaluate(async ({ cwd, title }) => {
    const source = await window.rhzycode.startThread({ cwd });
    await window.rhzycode.renameThread(source.thread.id, title);
    return source.thread.id;
  }, { cwd: projectDir, title: sourceTitle });

  await page.getByRole("button", { name: "Open project folder" }).click();
  await expect(getThreadRow(page, sourceTitle)).toBeVisible();
  const modelSelect = page.getByRole("combobox", { name: "Model for next turn" });
  await getThreadRow(page, sourceTitle).click();

  await setThreadDeleteDelay(electronApp, 750);
  try {
    await openThreadActions(page, sourceTitle);
    await page.getByRole("menuitem", { name: "Delete task permanently" }).click();
    await confirmThreadDeletion(page);
    await expect.poll(() => ipcCalls(electronApp, "agent:thread:delete").then((calls) => calls.at(-1)?.args))
      .toEqual([sourceThreadId]);

    await modelSelect.selectOption("ui/model");
    await expect(modelSelect).toHaveValue("ui/model");

    const taskPrompt = page.getByRole("textbox", { name: "Task prompt" });
    await taskPrompt.fill("Draft after deleting and changing models");
    await expect(taskPrompt).toHaveValue("Draft after deleting and changing models");
    await expect(taskPrompt).toBeFocused();

    await expect.poll(() => ipcCalls(electronApp, "agent:thread:delete:completed")
      .then((calls) => calls.at(-1)?.args)).toEqual([sourceThreadId]);
    await expect(modelSelect).toHaveValue("ui/model");
    await expect(taskPrompt).toBeEditable();
  } finally {
    await setThreadDeleteDelay(electronApp, 0);
  }
});

test("keeps the composer mouse-editable after deleting another conversation", async () => {
  const sourceTitle = "Delete other conversation";
  const targetTitle = "Keep selected conversation";
  const sourceThreadId = await page.evaluate(async ({ cwd, sourceTitle, targetTitle }) => {
    const source = await window.rhzycode.startThread({ cwd });
    const target = await window.rhzycode.startThread({ cwd });
    await window.rhzycode.renameThread(source.thread.id, sourceTitle);
    await window.rhzycode.renameThread(target.thread.id, targetTitle);
    return source.thread.id;
  }, { cwd: projectDir, sourceTitle, targetTitle });

  await page.getByRole("button", { name: "Open project folder" }).click();
  await expect(getThreadRow(page, sourceTitle)).toBeVisible();
  await expect(getThreadRow(page, targetTitle)).toBeVisible();
  await getThreadRow(page, targetTitle).click();
  await expect(getThreadRow(page, targetTitle).locator("..")).toHaveClass(/active/);
  const taskPrompt = page.getByRole("textbox", { name: "Task prompt" });
  await taskPrompt.focus();

  await setThreadDeleteDelay(electronApp, 750);
  try {
    await openThreadActions(page, sourceTitle);
    await expect(taskPrompt).toBeFocused();
    await page.getByRole("menuitem", { name: "Delete task permanently" }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(taskPrompt).toBeEditable();
    await expect(getThreadRow(page, sourceTitle)).toBeVisible();

    await openThreadActions(page, sourceTitle);
    await page.getByRole("menuitem", { name: "Delete task permanently" }).click();
    await confirmThreadDeletion(page);
    await expect.poll(() => ipcCalls(electronApp, "agent:thread:delete").then((calls) => calls.at(-1)?.args))
      .toEqual([sourceThreadId]);

    await expect(getThreadRow(page, targetTitle).locator("..")).toHaveClass(/active/);
    await taskPrompt.click();
    await page.keyboard.type("Immediate draft after deleting another conversation");
    await expect(taskPrompt).toHaveValue("Immediate draft after deleting another conversation");

    await expect.poll(() => ipcCalls(electronApp, "agent:thread:delete:completed")
      .then((calls) => calls.at(-1)?.args)).toEqual([sourceThreadId]);
    await expect(getThreadRow(page, sourceTitle)).toHaveCount(0);
    await expect(taskPrompt).toBeFocused();
  } finally {
    await setThreadDeleteDelay(electronApp, 0);
  }
});

test("keeps the composer mouse-editable after consecutive conversation deletions settle", async () => {
  const titles = ["Consecutive delete one", "Consecutive delete two", "Consecutive delete three"];
  const threadIds = await page.evaluate(async ({ cwd, titles: selectedTitles }) => {
    const ids: string[] = [];
    for (const title of selectedTitles) {
      const result = await window.rhzycode.startThread({ cwd });
      await window.rhzycode.renameThread(result.thread.id, title);
      ids.push(result.thread.id);
    }
    return ids;
  }, { cwd: projectDir, titles });

  await page.getByRole("button", { name: "Open project folder" }).click();
  for (const title of titles) await expect(getThreadRow(page, title)).toBeVisible();
  await getThreadRow(page, titles[0]).click();

  const completedBefore = await ipcCalls(electronApp, "agent:thread:delete:completed").then((calls) => calls.length);
  await setThreadDeleteDelay(electronApp, 500);
  try {
    for (let index = 0; index < titles.length; index += 1) {
      await openThreadActions(page, titles[index]);
      await page.getByRole("menuitem", { name: "Delete task permanently" }).click();
      await confirmThreadDeletion(page);
      await expect.poll(() => ipcCalls(electronApp, "agent:thread:delete").then((calls) => calls.at(-1)?.args))
        .toEqual([threadIds[index]]);
    }

    await expect.poll(() => ipcCalls(electronApp, "agent:thread:delete:completed").then((calls) => calls.length))
      .toBe(completedBefore + titles.length);
    for (const title of titles) await expect(getThreadRow(page, title)).toHaveCount(0);

    const taskPrompt = page.getByRole("textbox", { name: "Task prompt" });
    await expect(taskPrompt).toBeEditable();
    await taskPrompt.click();
    await page.keyboard.type("Composer works after consecutive deletions");
    await expect(taskPrompt).toHaveValue("Composer works after consecutive deletions");
  } finally {
    await setThreadDeleteDelay(electronApp, 0);
  }
});

test("creates the first conversation after returning to an empty project", async () => {
  for (const selectedDirectory of [projectDir, emptyProjectDir, projectDir]) {
    await electronApp.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [directory],
      })) as typeof dialog.showOpenDialog;
    }, selectedDirectory);
    await page.getByRole("button", { name: "Open project folder" }).click();
    await expect(page.locator(".project-group.selected .project-group-main strong"))
      .toHaveText(path.basename(selectedDirectory));
  }

  const emptyProjectGroup = page.locator(".project-group").filter({ hasText: "empty-project" });
  await emptyProjectGroup.locator(".project-group-header").hover();
  await emptyProjectGroup.getByRole("button", { name: "New task in project empty-project" }).click();

  const taskPrompt = page.getByRole("textbox", { name: "Task prompt" });
  await expect(page.locator(".project-group.selected .project-group-main strong")).toHaveText("empty-project");
  await expect(page.getByText("Start a new task", { exact: true })).toBeVisible();
  await expect(taskPrompt).toBeEditable();
  await taskPrompt.fill("First task in the empty project");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => ipcCalls(electronApp, "agent:thread:start").then((calls) => {
    const params = calls.at(-1)?.args[0] as { cwd?: string } | undefined;
    return params?.cwd;
  })).toBe(emptyProjectDir);
  await expect(getThreadRow(page, "First task in the empty project")).toBeVisible();

  await emptyProjectGroup.locator(".project-group-header").hover();
  await emptyProjectGroup.getByRole("button", { name: "New task in project empty-project" }).click();
  await expect(page.getByText("Start a new task", { exact: true })).toBeVisible();
  await expect(taskPrompt).toHaveValue("");
  await expect(getThreadRow(page, "First task in the empty project").locator("..")).not.toHaveClass(/active/);
});

test("shows an assistant reply delivered only as a completed item", async () => {
  const threadId = await page.evaluate((cwd) => window.rhzycode.startThread({ cwd })
    .then((result) => result.thread.id), emptyProjectDir);
  await sendSyncEvent(electronApp, {
    type: "thread.updated",
    sequence: 30_000,
    thread: {
      id: threadId,
      hostId: "local-desktop",
      title: "Completion-only reply",
      projectPath: emptyProjectDir,
      model: "ui/model",
      status: "running",
      updatedAt: new Date().toISOString(),
    },
  });
  const threadRow = getThreadRow(page, "Completion-only reply");
  await expect(threadRow).toBeVisible();
  await threadRow.click();
  await expect(threadRow.locator("..")).toHaveClass(/active/);

  await sendAgentMessage(electronApp, {
    method: "item/completed",
    params: {
      threadId,
      turnId: "completion-only-turn",
      item: {
        id: "completion-only-message",
        type: "agentMessage",
        text: "This reply arrived without streaming deltas.",
      },
    },
  });

  await expect(page.getByText("This reply arrived without streaming deltas.", { exact: true })).toBeVisible();
});

test("uses the last manually selected model for a new task", async () => {
  const titles = {
    preferred: "Manual model preference",
    other: "Different history model",
  };
  await page.evaluate(async ({ cwd, titles: threadTitles }) => {
    const preferred = await window.rhzycode.startThread({ cwd, model: "ui/model" });
    const other = await window.rhzycode.startThread({ cwd, model: "ui/model" });
    await window.rhzycode.renameThread(preferred.thread.id, threadTitles.preferred);
    await window.rhzycode.renameThread(other.thread.id, threadTitles.other);
  }, { cwd: projectDir, titles });

  await page.getByRole("button", { name: "Open project folder" }).click();
  await getThreadRow(page, titles.preferred).click();
  const modelSelect = page.getByRole("combobox", { name: "Model for next turn" });
  await modelSelect.selectOption("ui/second");
  await expect(modelSelect).toHaveValue("ui/second");

  await getThreadRow(page, titles.other).click();
  await expect(modelSelect).toHaveValue("ui/second");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("rhzycode.selectedModel")))
    .toBe("ui/second");

  await clickSelectedProjectNewTask(page);
  await expect(page.getByText("Start a new task", { exact: true })).toBeVisible();
  await expect(modelSelect).toHaveValue("ui/second");
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

async function dropFilesOnComposer(targetPage: Page, filePaths: string[]): Promise<void> {
  const composerBox = targetPage.locator(".composer-box");
  const bounds = await composerBox.boundingBox();
  if (!bounds) throw new Error("Composer bounds are unavailable.");
  const session = await targetPage.context().newCDPSession(targetPage);
  const data = { items: [], files: filePaths, dragOperationsMask: 1 };
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  try {
    await session.send("Input.dispatchDragEvent", { type: "dragEnter", ...point, data });
    await expect(composerBox).toHaveClass(/drag-active/);
    await session.send("Input.dispatchDragEvent", { type: "dragOver", ...point, data });
    await session.send("Input.dispatchDragEvent", { type: "drop", ...point, data });
    await expect(composerBox).not.toHaveClass(/drag-active/);
  } finally {
    await session.detach();
  }
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
    const themeProbe = document.createElement("span");
    themeProbe.style.cssText = "position:fixed;visibility:hidden;background:var(--accent-fill,var(--accent));color:var(--on-accent)";
    document.body.append(themeProbe);
    const themeStyle = getComputedStyle(themeProbe);
    const userBounds = user.getBoundingClientRect();
    const assistantBounds = assistant.getBoundingClientRect();
    const result = {
      userLeft: userBounds.left,
      userRight: userBounds.right,
      assistantLeft: assistantBounds.left,
      assistantRight: assistantBounds.right,
      userBackground: getComputedStyle(user).backgroundColor,
      userBorderStyle: getComputedStyle(user).borderTopStyle,
      userColor: getComputedStyle(user).color,
      expectedUserBackground: themeStyle.backgroundColor,
      expectedUserColor: themeStyle.color,
    };
    themeProbe.remove();
    return result;
  });
  expect(layout.userLeft).toBeGreaterThan(layout.assistantLeft);
  expect(layout.userRight).toBeGreaterThan(layout.assistantRight - 2);
  expect(layout.userBackground).toBe(layout.expectedUserBackground);
  expect(layout.userBorderStyle).toBe("none");
  expect(layout.userColor).toBe(layout.expectedUserColor);
}

async function openThreadActions(activePage: Page, title: string): Promise<void> {
  const wrapper = getThreadRow(activePage, title).locator("..");
  await wrapper.hover();
  await wrapper.getByRole("button", { name: `Thread actions for ${title}` }).click();
}

async function confirmThreadDeletion(activePage: Page): Promise<void> {
  await activePage.getByRole("button", { name: "Permanently delete conversation" }).click();
}

function getThreadRow(activePage: Page, title: string) {
  return activePage.locator(".thread-row").filter({ hasText: title });
}

function getSelectedProjectNewTask(activePage: Page) {
  return activePage.locator(".project-group.selected")
    .getByRole("button", { name: /^New task in project / });
}

async function clickSelectedProjectNewTask(activePage: Page): Promise<void> {
  await activePage.locator(".project-group.selected .project-group-header").hover();
  await getSelectedProjectNewTask(activePage).click();
}

async function typeAndClearComposer(activePage: Page, composer: Locator, text: string): Promise<void> {
  await expect(composer).toBeEditable();
  await composer.click();
  await expect(composer).toBeFocused();
  await activePage.keyboard.type(text);
  await expect(composer).toHaveValue(text);
  await activePage.keyboard.press("Control+A");
  await activePage.keyboard.press("Backspace");
  await expect(composer).toHaveValue("");
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

async function sendStreamingBurst(
  app: ElectronApplication,
  threadId: string,
  uniqueItemCount: number,
  repeatedDeltaCount: number,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, input) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    for (let index = 0; index < input.uniqueItemCount; index += 1) {
      contents?.send("agent:message", {
        method: "item/agentMessage/delta",
        params: {
          threadId: input.threadId,
          turnId: "streaming-burst",
          itemId: `history-${index}`,
          delta: "x",
        },
      });
    }
    for (let index = 0; index < input.repeatedDeltaCount; index += 1) {
      contents?.send("agent:message", {
        method: "item/agentMessage/delta",
        params: {
          threadId: input.threadId,
          turnId: "streaming-burst",
          itemId: "live-output",
          delta: "x",
        },
      });
    }
  }, { threadId, uniqueItemCount, repeatedDeltaCount });
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

async function setThreadOpenDelay(app: ElectronApplication, milliseconds: number): Promise<void> {
  await app.evaluate((_electron, value) => {
    const state = (globalThis as any).__rhzycodeUiTest as { threadOpenDelayMs?: number } | undefined;
    if (state) state.threadOpenDelayMs = value;
  }, milliseconds);
}

async function setThreadDeleteDelay(app: ElectronApplication, milliseconds: number): Promise<void> {
  await app.evaluate((_electron, value) => {
    const state = (globalThis as any).__rhzycodeUiTest as { threadDeleteDelayMs?: number } | undefined;
    if (state) state.threadDeleteDelayMs = value;
  }, milliseconds);
}

async function setAgentConnectDelay(app: ElectronApplication, milliseconds: number): Promise<void> {
  await app.evaluate((_electron, value) => {
    const state = (globalThis as any).__rhzycodeUiTest as { agentConnectDelayMs?: number } | undefined;
    if (state) state.agentConnectDelayMs = value;
  }, milliseconds);
}

function writeGeneratedImageFixture(filePath: string): void {
  const width = 320;
  const height = 240;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + 1 + x * 3;
      const highlight = Math.abs(x - y * 4 / 3) < 16 || Math.abs((width - x) - y * 4 / 3) < 16;
      pixels[offset] = highlight ? 245 : Math.round(36 + 90 * x / width);
      pixels[offset + 1] = highlight ? 204 : Math.round(72 + 105 * y / height);
      pixels[offset + 2] = highlight ? 84 : Math.round(145 - 70 * x / width);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function installDeterministicIpc(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, fixture) => {
    const threads = new Map<string, Record<string, unknown>>();
    let threadSequence = 0;
    let terminal: Record<string, unknown> | null = null;
    let gatewayState = "running";
    let credentialStatus = {
      encryptionAvailable: true,
      providers: [] as Array<Record<string, any>>,
    };
    let mobileAccessStatus = {
      accessKey: null as Record<string, unknown> | null,
      audit: [],
    };
    let mobileAccessKeySequence = 0;
    let skillsStatus = {
      skills: [
        {
          name: "review-helper",
          displayName: "Review Helper",
          description: "Review changes and identify concrete engineering risks.",
          shortDescription: "Focused code review support",
          enabled: true,
          path: fixture.userSkillPath,
          scope: "user",
          canRemove: true,
        },
        {
          name: "system-writer",
          displayName: "System Writer",
          description: "Built-in document support.",
          shortDescription: null,
          enabled: true,
          path: fixture.systemSkillPath,
          scope: "system",
          canRemove: false,
        },
      ],
      errors: [],
      sources: {
        codex: { available: true, count: 1 },
        claude: { available: false, count: 0 },
      },
    };
    const testState = {
      calls: [] as Array<{ channel: string; args: unknown[] }>,
      failNextTurn: false,
      agentConnectDelayMs: 0,
      threadDeleteDelayMs: 0,
      threadOpenDelayMs: 0,
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
      host: "127.0.0.1",
      port: 45123,
      url: "http://127.0.0.1:45123",
      error: null,
    });
    const replace = (channel: string, handler: (...args: any[]) => unknown) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };

    replace("agent:status", () => ({ state: "connected", error: null }));
    replace("agent:connect", async () => {
      record("agent:connect");
      if (testState.agentConnectDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, testState.agentConnectDelayMs));
      }
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
    replace("project:forget", (_event, projectPath) => {
      record("project:forget", projectPath);
    });
    replace("project:delete", (_event, projectPath) => {
      record("project:delete", projectPath);
      return { deletedConversationCount: 0 };
    });
    replace("conversation:backup", (_event, projectPath) => {
      record("conversation:backup", projectPath);
      return {
        filePath: `${projectPath}.rhzycode-backup`,
        conversationCount: 1,
        size: 1024,
      };
    });
    replace("conversation:restore", () => {
      record("conversation:restore");
      return {
        filePath: `${fixture.projectDir}.rhzycode-backup`,
        importedCount: 1,
        skippedCount: 0,
        projectPaths: [fixture.projectDir],
      };
    });
    replace("project:resolve-dropped-files", (_event, filePaths) => {
      record("project:resolve-dropped-files", filePaths);
      return filePaths.flatMap((filePath: string) => {
        if (filePath === fixture.attachmentPath) {
          return [{ path: filePath, name: "notes.txt", kind: "file", size: 17 }];
        }
        if (filePath === fixture.generatedImagePath) {
          return [{ path: filePath, name: "generated-image.png", kind: "image", size: 68 }];
        }
        return [];
      });
    });
    replace("agent:threads", (_event, options = {}) => {
      record("agent:threads", options);
      return [...threads.values()]
        .filter((thread) => Boolean(thread.archived) === Boolean(options.archived))
        .filter((thread) => !options.cwd || thread.projectPath === options.cwd)
        .filter((thread) => !options.searchTerm
          || String(thread.title).toLowerCase().includes(String(options.searchTerm).toLowerCase()))
        .map(({ archived: _archived, ...thread }) => thread);
    });
    replace("agent:thread:start", (_event, params) => {
      record("agent:thread:start", params);
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
    replace("agent:thread:open", async (_event, threadId) => {
      record("agent:thread:open", threadId);
      if (testState.threadOpenDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, testState.threadOpenDelayMs));
      }
      const thread = threads.get(threadId);
      if (!thread) throw new Error("Thread not found");
      const { archived: _archived, ...summary } = thread;
      record("agent:thread:open:completed", threadId);
      return {
        thread: summary,
        messages: [
          {
            id: "history-user",
            role: "user",
            content: "Please review the current project and summarize the important risks.",
            files: [{
              id: "file-history-notes",
              name: "notes.txt",
              size: 24,
              source: "upload",
              path: fixture.attachmentPath,
            }],
          },
          { id: "history-assistant", role: "assistant", content: "I will inspect the project structure, trace the main workflows, and report concrete findings." },
        ],
        timeline: [],
      };
    });
    replace("agent:thread:model", (_event, threadId, model) => {
      record("agent:thread:model", threadId, model);
      const thread = threads.get(threadId);
      if (!thread) throw new Error("Thread not found");
      const updated = { ...thread, model, updatedAt: new Date().toISOString() };
      threads.set(threadId, updated);
      const { archived: _archived, ...summary } = updated;
      return summary;
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
    replace("agent:thread:delete", async (_event, threadId) => {
      record("agent:thread:delete", threadId);
      threads.delete(threadId);
      if (testState.threadDeleteDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, testState.threadDeleteDelayMs));
      }
      record("agent:thread:delete:completed", threadId);
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
    replace("project:open-local-file", (_event, filePath) => {
      record("project:open-local-file", filePath);
    });
    replace("project:reveal-local-file", (_event, filePath) => {
      record("project:reveal-local-file", filePath);
    });
    replace("project:save-local-file", (_event, filePath, suggestedName) => {
      record("project:save-local-file", filePath, suggestedName);
      return filePath;
    });
    replace("project:show-image-context-menu", (_event, filePath, suggestedName) => {
      record("project:show-image-context-menu", filePath, suggestedName);
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
    replace("skills:list", (_event, forceReload) => {
      record("skills:list", forceReload);
      return skillsStatus;
    });
    replace("skills:install", () => {
      record("skills:install");
      return null;
    });
    replace("skills:import", (_event, source) => {
      record("skills:import", source);
      return { importedCount: 1, skippedCount: 0, failedCount: 0, status: skillsStatus };
    });
    replace("skills:enabled:set", (_event, skillPath, enabled) => {
      record("skills:enabled:set", skillPath, enabled);
      skillsStatus = {
        ...skillsStatus,
        skills: skillsStatus.skills.map((skill) => skill.path === skillPath ? { ...skill, enabled } : skill),
      };
      return skillsStatus;
    });
    replace("skills:remove", (_event, skillPath) => {
      record("skills:remove", skillPath);
      skillsStatus = {
        ...skillsStatus,
        skills: skillsStatus.skills.filter((skill) => skill.path !== skillPath),
      };
      return skillsStatus;
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
      controlState: "missing",
      mobileAccessState: "missing",
    }));
    replace("clipboard:write", (_event, value) => {
      record("clipboard:write", value);
    });
    replace("sync:status", () => syncStatus());
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
      mobileAccessKeySequence += 1;
      const accessKey = {
        key: `rhzy_${(mobileAccessKeySequence === 1 ? "A" : "B").repeat(43)}`,
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
  }, {
    projectDir,
    attachmentPath,
    generatedImagePath,
    userSkillPath: path.join(dataDir, "codex-home", "skills", "review-helper", "SKILL.md"),
    systemSkillPath: path.join(dataDir, "codex-home", "skills", ".system", "system-writer", "SKILL.md"),
  });
}
