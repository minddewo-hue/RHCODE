import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, Notification, safeStorage, shell } from "electron";
import updaterPackage from "electron-updater";
import {
  ControlStore,
  MobileAccessManager,
  normalizeMobileAccessState,
  type MobileAccessState,
} from "./control-plane/app";
import fs from "node:fs";
import os from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { DesktopRuntime } from "./runtime";
import {
  ProjectDirectoryRegistry,
  normalizeProjectDirectoryState,
  type ProjectDirectoryState,
} from "./project-directories";
import type { ComposerAttachment, SkillsStatus } from "../shared/desktop-api";
import { ProviderCredentialStore } from "./credential-store";
import { detectLlmProtocol } from "./llm-protocol";
import { removeStalePastedImages, savePastedImage } from "./pasted-image-store";
import { buildImageContextMenu, buildTextContextMenu } from "./text-context-menu";
import { DEFAULT_UPDATE_MANIFEST_URL, UpdateManager, type UpdateAdapter } from "./update-manager";
import { EncryptedControlPersistence, EncryptedStateFile, type PersistenceStatus } from "./control-persistence";
import { AppServerClient } from "./app-server";
import {
  importClaudeConversations,
  importCodexConversations,
  normalizeCodexSessionProvidersOnce,
  runFirstLaunchEnvironmentMigrations,
  type EnvironmentMigrationSource,
} from "./environment-migration";
import { selectGatewayRoot } from "./gateway-module";
import { SkillsManager } from "./skills-manager";
import { showStartupDialog } from "./startup-dialog";
import {
  bundledCodexExecutable,
  desktopUpdatePlatform,
  linuxOzonePlatform,
  preferredCodexPath,
  shouldQuitWhenAllWindowsClose,
} from "./platform/desktop-platform";
import {
  resolveTaskWindowChrome,
  toRendererTaskActivity,
  type RendererTaskActivityStatus,
  type TaskActivityStatus,
} from "./task-activity";
import {
  validateApprovalResolution,
  validateClipboardText,
  validateCredentialUpdate,
  validateIdentifier,
  validateLlmProviderConfiguration,
  validateProjectPath,
  validateSkillEnabled,
  validateSkillImportSource,
  validateSkillPath,
  validateStartThread,
  validateStartTurn,
  validateTerminalResize,
  validateTerminalStart,
  validateTerminalWrite,
  validateThreadListOptions,
  validateThreadModel,
  validateThreadRename,
  validateUserInputResolution,
} from "./ipc-validation";

const { autoUpdater } = updaterPackage;
const systemFetch = net.fetch.bind(net) as typeof fetch;

let mainWindow: BrowserWindow | null = null;
let runtime: DesktopRuntime | null = null;
let controlPersistence: EncryptedControlPersistence | null = null;
let quitAfterCleanup = false;
let startupEnvironmentMigration: Promise<void> = Promise.resolve();
let taskActivityPresenter: WindowTaskActivityPresenter | null = null;

const userDataOverride = process.env.RHZYCODE_USER_DATA_DIR?.trim();
if (userDataOverride) app.setPath("userData", resolve(userDataOverride));

const remoteDebugPort = process.env.RHZYCODE_DEBUG_PORT?.trim();
if (remoteDebugPort && /^\d{2,5}$/.test(remoteDebugPort)) {
  app.commandLine.appendSwitch("remote-debugging-port", remoteDebugPort);
}

const ozonePlatform = linuxOzonePlatform();
if (ozonePlatform) app.commandLine.appendSwitch("ozone-platform", ozonePlatform);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#f4f5f3",
    title: "RHZYCODE",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        console.error(
          `[Renderer] Failed to load ${validatedURL}: ${errorCode} ${errorDescription}`,
        );
      }
    },
  );
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[Renderer] Process exited: ${details.reason} (${details.exitCode})`);
  });
  mainWindow.webContents.on("console-message", (details) => {
    if (details.level === "warning" || details.level === "error") {
      console.error(`[Renderer:${details.level}] ${details.message}`);
    }
  });
  mainWindow.webContents.on("context-menu", (event, params) => {
    if (params.mediaType === "image") {
      event.preventDefault();
      return;
    }
    const menu = Menu.buildFromTemplate(buildTextContextMenu(params));
    menu.popup({ window: mainWindow || undefined });
  });
  mainWindow.once("ready-to-show", () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.focus();
  });
  mainWindow.on("focus", () => {
    if (!mainWindow) return;
    mainWindow.flashFrame(false);
    mainWindow.webContents.focus();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
  return mainWindow;
}

function registerIpc(
  activeRuntime: DesktopRuntime,
  codexHome: string,
  credentials: ProviderCredentialStore,
  updates: UpdateManager,
  mobileAccess: MobileAccessManager,
  skillsManager: SkillsManager,
  getPersistenceStatus: () => PersistenceStatus,
): void {
  const listSkills = async (forceReload = false): Promise<SkillsStatus> => {
    const result = await activeRuntime.listSkills(forceReload);
    return {
      skills: result.skills.map((skill) => ({
        ...skill,
        canRemove: skill.scope === "user" && skillsManager.canRemove(skill.path),
      })),
      errors: result.errors,
      sources: skillsManager.getSourceStatus(),
    };
  };

  ipcMain.handle("agent:status", () => activeRuntime.agent.getStatus());
  ipcMain.handle("agent:connect", async () => {
    await startupEnvironmentMigration;
    if (activeRuntime.agent.getStatus().state !== "connected") {
      await activeRuntime.startGatewayAndAgent().catch(() => undefined);
    }
    return activeRuntime.agent.getStatus();
  });
  ipcMain.handle("agent:models", () => activeRuntime.listModels());
  ipcMain.handle("agent:threads", (_event, options: unknown) =>
    activeRuntime.listThreads(validateThreadListOptions(options)));
  ipcMain.handle("agent:thread:open", (_event, threadId: unknown) =>
    activeRuntime.openThread(validateIdentifier(threadId, "threadId")),
  );
  ipcMain.handle("agent:thread:start", (_event, params: unknown) =>
    activeRuntime.startThread(validateStartThread(params)),
  );
  ipcMain.handle("agent:thread:archive", (_event, threadId: unknown) =>
    activeRuntime.archiveThread(validateIdentifier(threadId, "threadId")),
  );
  ipcMain.handle("agent:thread:unarchive", (_event, threadId: unknown) =>
    activeRuntime.unarchiveThread(validateIdentifier(threadId, "threadId")),
  );
  ipcMain.handle("agent:thread:model", (_event, threadId: unknown, model: unknown) => {
    const input = validateThreadModel(threadId, model);
    return activeRuntime.setThreadModel(input.threadId, input.model);
  });
  ipcMain.handle("agent:thread:rename", (_event, threadId: unknown, name: unknown) => {
    const input = validateThreadRename(threadId, name);
    return activeRuntime.renameThread(input.threadId, input.name);
  });
  ipcMain.handle("agent:thread:delete", (_event, threadId: unknown) =>
    activeRuntime.deleteThread(validateIdentifier(threadId, "threadId")),
  );
  ipcMain.handle("agent:thread:compact", (_event, threadId: unknown) =>
    activeRuntime.compactThread(validateIdentifier(threadId, "threadId")),
  );
  ipcMain.handle("conversation:backup", async (_event, projectPath: unknown) => {
    const validatedProjectPath = validateProjectPath(projectPath);
    const projectName = basename(validatedProjectPath).replace(/[^a-zA-Z0-9._-]+/g, "-") || "project";
    const date = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Back up project conversations",
      defaultPath: join(app.getPath("documents"), `${projectName}-conversations-${date}.rhzycode-backup`),
      filters: [{ name: "RHZYCODE conversation backup", extensions: ["rhzycode-backup"] }],
    });
    if (result.canceled || !result.filePath) return null;
    return activeRuntime.backupProjectConversations(validatedProjectPath, result.filePath);
  });
  ipcMain.handle("conversation:export", async (_event, value: unknown) => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
      throw new Error("Conversation selection is invalid.");
    }
    const threadIds = [...new Set(value.map((threadId) => validateIdentifier(threadId, "threadId")))];
    const date = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Export conversations",
      defaultPath: join(app.getPath("documents"), `rhzycode-conversations-${date}.rhzycode-backup`),
      filters: [{ name: "RHZYCODE conversation backup", extensions: ["rhzycode-backup"] }],
    });
    if (result.canceled || !result.filePath) return null;
    return activeRuntime.exportConversations(threadIds, result.filePath);
  });
  ipcMain.handle("conversation:export-list", () => activeRuntime.listExportConversations());
  ipcMain.handle("conversation:restore", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Restore project conversations",
      properties: ["openFile"],
      filters: [{ name: "RHZYCODE conversation backup", extensions: ["rhzycode-backup"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return activeRuntime.restoreProjectConversations(validateLocalFilePath(result.filePaths[0]));
  });
  ipcMain.handle("conversation:import-external", async (_event, value: unknown) => {
    if (value !== "codex" && value !== "claude") {
      throw new Error("Conversation import source is invalid.");
    }
    await startupEnvironmentMigration;
    const result = value === "codex"
      ? importCodexConversations(resolveUserCodexHome(), codexHome)
      : await (async () => {
          if (activeRuntime.agent.getStatus().state !== "connected") {
            await activeRuntime.startGatewayAndAgent();
          }
          return importClaudeConversations(activeRuntime.agent, codexHome);
        })();
    for (const projectPath of result.projectPaths) {
      try {
        activeRuntime.rememberProjectDirectory(projectPath);
      } catch {
        // Imported conversations remain available if their old project was moved.
      }
    }
    return result;
  });
  ipcMain.handle("agent:turn:start", (_event, params: unknown) =>
    activeRuntime.startTurn(validateStartTurn(params)),
  );
  ipcMain.handle("agent:turn:interrupt", (_event, threadId: unknown) =>
    activeRuntime.interruptTurn(validateIdentifier(threadId, "threadId")),
  );

  ipcMain.handle("gateway:status", () => activeRuntime.gateway.getStatus());
  ipcMain.handle("gateway:start", async () => {
    await activeRuntime.startGatewayAndAgent().catch(() => undefined);
    return activeRuntime.gateway.getStatus();
  });
  ipcMain.handle("gateway:stop", async () => {
    await activeRuntime.stopGateway();
    return activeRuntime.gateway.getStatus();
  });
  ipcMain.handle("gateway:restart", async () => {
    await activeRuntime.restartGateway().catch(() => undefined);
    return activeRuntime.gateway.getStatus();
  });
  ipcMain.handle("gateway:probe", () => activeRuntime.gateway.probeProviders());
  ipcMain.handle("credentials:status", () => credentials.status());
  ipcMain.handle("credentials:set", async (_event, providerId: unknown, apiKey: unknown) => {
    const input = validateCredentialUpdate(providerId, apiKey);
    credentials.set(input.providerId, input.apiKey);
    credentials.applyToEnvironment();
    let gatewayError: string | null = null;
    try {
      await activeRuntime.restartGateway();
    } catch (error) {
      gatewayError = error instanceof Error ? error.message : String(error);
    }
    return {
      credentials: credentials.status(),
      gateway: activeRuntime.gateway.getStatus(),
      gatewayError,
    };
  });
  ipcMain.handle("providers:configure", async (_event, value: unknown) => {
    const input = validateLlmProviderConfiguration(value);
    const apiKey = input.apiKey.trim() || credentials.getApiKey(input.providerId);
    if (!apiKey) throw new Error("An API key is required for this provider.");
    const detected = await detectLlmProtocol({
      baseUrl: input.baseUrl,
      apiKey,
      protocol: input.protocol,
    }, systemFetch);
    credentials.upsert({
      providerId: input.providerId,
      name: input.name,
      baseUrl: detected.baseUrl,
      protocol: input.protocol,
      detectedProtocol: detected.protocol,
      models: input.models,
    }, input.apiKey);
    credentials.applyToEnvironment();
    let gatewayError: string | null = null;
    try {
      await activeRuntime.restartGateway();
    } catch (error) {
      gatewayError = error instanceof Error ? error.message : String(error);
    }
    return {
      credentials: credentials.status(),
      gateway: activeRuntime.gateway.getStatus(),
      gatewayError,
    };
  });
  ipcMain.handle("providers:remove", async (_event, providerId: unknown) => {
    credentials.remove(validateIdentifier(providerId, "providerId"));
    credentials.applyToEnvironment();
    let gatewayError: string | null = null;
    try {
      await activeRuntime.restartGateway();
    } catch (error) {
      gatewayError = error instanceof Error ? error.message : String(error);
    }
    return {
      credentials: credentials.status(),
      gateway: activeRuntime.gateway.getStatus(),
      gatewayError,
    };
  });
  ipcMain.handle("skills:list", (_event, forceReload: unknown) =>
    listSkills(forceReload === undefined ? false : validateSkillEnabled(forceReload)));
  ipcMain.handle("skills:install", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory"],
      title: "Choose a Skill directory",
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const installedName = skillsManager.install(result.filePaths[0]);
    return { installedName, status: await listSkills(true) };
  });
  ipcMain.handle("skills:import", async (_event, source: unknown) => {
    const summary = skillsManager.import(validateSkillImportSource(source));
    return { ...summary, status: await listSkills(true) };
  });
  ipcMain.handle(
    "skills:enabled:set",
    async (_event, skillPath: unknown, enabled: unknown) => {
      const path = validateSkillPath(skillPath);
      await activeRuntime.setSkillEnabled(path, validateSkillEnabled(enabled));
      return listSkills(true);
    },
  );
  ipcMain.handle("skills:remove", async (_event, skillPath: unknown) => {
    skillsManager.remove(validateSkillPath(skillPath));
    return listSkills(true);
  });
  ipcMain.handle("updates:status", () => updates.getStatus());
  ipcMain.handle("updates:check", () => updates.check());
  ipcMain.handle("updates:download", () => updates.download());
  ipcMain.handle("updates:install", () => updates.install());
  ipcMain.handle("mobile-access:status", () => mobileAccess.status());
  ipcMain.handle("mobile-access:key:rotate", () => mobileAccess.rotateAccessKey());
  ipcMain.handle("storage:status", () => getPersistenceStatus());
  ipcMain.handle("clipboard:write", (_event, value: unknown) => {
    clipboard.writeText(validateClipboardText(value));
  });
  ipcMain.on("diagnostic:performance", (_event, event: unknown, detail: unknown) => {
    if (typeof event !== "string" || !/^[a-z0-9:_-]{1,80}$/i.test(event)) return;
    const fields = detail && typeof detail === "object" ? detail as Record<string, unknown> : {};
    const safeDetail = Object.fromEntries(Object.entries(fields).flatMap(([key, value]) => (
      typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
        ? [[key.slice(0, 80), value]]
        : []
    )));
    const logPath = join(codexHome, "logs", "interaction-performance.jsonl");
    void fs.promises.mkdir(join(codexHome, "logs"), { recursive: true })
      .then(() => fs.promises.appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), event, detail: safeDetail })}\n`))
      .catch(() => undefined);
  });

  ipcMain.handle("sync:status", () => activeRuntime.getSyncStatus());
  ipcMain.handle("sync:snapshot", () => activeRuntime.getRendererBootstrapState());
  ipcMain.handle(
    "sync:approval:resolve",
    (_event, id: unknown, decision: unknown) => {
      const input = validateApprovalResolution(id, decision);
      return activeRuntime.resolveApproval(input.id, input.decision);
    },
  );
  ipcMain.handle(
    "sync:user-input:resolve",
    (_event, id: unknown, answers: unknown) => {
      const input = validateUserInputResolution(id, answers);
      return activeRuntime.resolveUserInput(input.id, input.answers);
    },
  );
  ipcMain.handle("terminal:status", () => activeRuntime.getTerminalStatus());
  ipcMain.handle("terminal:start", (_event, params: unknown) =>
    activeRuntime.startTerminal(validateTerminalStart(params)),
  );
  ipcMain.handle("terminal:write", (_event, processId: unknown, data: unknown) => {
    const input = validateTerminalWrite(processId, data);
    return activeRuntime.writeTerminal(input.processId, input.data);
  });
  ipcMain.handle(
    "terminal:resize",
    (_event, processId: unknown, cols: unknown, rows: unknown) => {
      const input = validateTerminalResize(processId, cols, rows);
      return activeRuntime.resizeTerminal(input.processId, input.cols, input.rows);
    },
  );
  ipcMain.handle("terminal:stop", (_event, processId: unknown) =>
    activeRuntime.stopTerminal(validateIdentifier(processId, "processId")),
  );
  ipcMain.handle("project:choose", chooseProjectDirectory);
  ipcMain.handle("project:list", () => activeRuntime.listProjectDirectories());
  ipcMain.handle("project:remember", (_event, projectPath: unknown) =>
    activeRuntime.rememberProjectDirectory(validateProjectPath(projectPath)));
  ipcMain.handle("project:forget", (_event, projectPath: unknown) =>
    activeRuntime.forgetProjectDirectory(validateProjectPath(projectPath)));
  ipcMain.handle("project:delete", (_event, projectPath: unknown) =>
    activeRuntime.deleteProjectDirectory(validateProjectPath(projectPath)));
  ipcMain.handle("project:choose-files", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile", "multiSelections"],
      title: "Choose files or images",
    });
    if (result.canceled) return [];
    return attachmentsFromFilePaths(result.filePaths);
  });
  ipcMain.handle("project:resolve-dropped-files", (_event, value: unknown) => {
    if (!Array.isArray(value) || value.length > 20) throw new Error("Dropped files are invalid.");
    const filePaths = value.map((entry) => {
      if (typeof entry !== "string" || !isAbsolute(entry)) throw new Error("Dropped file path is invalid.");
      return entry;
    });
    return attachmentsFromFilePaths(filePaths);
  });
  ipcMain.handle("project:save-pasted-image", (_event, input: unknown) =>
    savePastedImage(pastedImageDirectory(), input));
  ipcMain.handle("project:read-local-image", (_event, value: unknown) => {
    if (typeof value !== "string" || !isAbsolute(value)) throw new Error("Image path is invalid.");
    const extension = extname(value).toLowerCase();
    const mimeType = new Map([
      [".avif", "image/avif"], [".bmp", "image/bmp"], [".gif", "image/gif"],
      [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"], [".png", "image/png"], [".webp", "image/webp"],
    ]).get(extension);
    if (!mimeType) throw new Error("Unsupported image format.");
    const bytes = fs.readFileSync(value);
    if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("Image is too large to preview.");
    return `data:${mimeType};base64,${bytes.toString("base64")}`;
  });
  ipcMain.handle("project:open-local-file", async (_event, value: unknown) => {
    const filePath = validateLocalFilePath(value);
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
  });
  ipcMain.handle("project:reveal-local-file", (_event, value: unknown) => {
    shell.showItemInFolder(validateLocalFilePath(value));
  });
  ipcMain.handle("project:save-local-file", (_event, value: unknown, suggestedName: unknown) =>
    saveLocalFile(value, suggestedName));
  ipcMain.handle("project:show-image-context-menu", (_event, value: unknown, suggestedName: unknown) => {
    const sourcePath = validateLocalFilePath(value);
    const menu = Menu.buildFromTemplate(buildImageContextMenu(() => {
      void saveLocalFile(sourcePath, suggestedName, "Save image").catch((error) => {
        dialog.showErrorBox("Could not save image", error instanceof Error ? error.message : String(error));
      });
    }));
    menu.popup({ window: mainWindow || undefined });
  });

  activeRuntime.on("agent:status", (status) => mainWindow?.webContents.send("agent:status", status));
  activeRuntime.on("task:activity", (activity: TaskActivityStatus) => {
    taskActivityPresenter?.handle(activity);
  });
  activeRuntime.on("agent:message", (message) => mainWindow?.webContents.send("agent:message", message));
  activeRuntime.on("agent:diagnostic", (message) =>
    mainWindow?.webContents.send("agent:diagnostic", message),
  );
  activeRuntime.on("gateway:status", (status) =>
    mainWindow?.webContents.send("gateway:status", status),
  );
  activeRuntime.on("sync:status", (status) => mainWindow?.webContents.send("sync:status", status));
  activeRuntime.on("sync:event", (event) => mainWindow?.webContents.send("sync:event", event));
  activeRuntime.on("terminal:status", (status) =>
    mainWindow?.webContents.send("terminal:status", status),
  );
  activeRuntime.on("terminal:output", (output) =>
    mainWindow?.webContents.send("terminal:output", output),
  );
  activeRuntime.on("projects:changed", (projects) =>
    mainWindow?.webContents.send("projects:changed", projects),
  );
  updates.on("status", (status) => mainWindow?.webContents.send("updates:status", status));
  mobileAccess.on("status", (status) => mainWindow?.webContents.send("mobile-access:status", status));
}

async function chooseProjectDirectory(): Promise<string | null> {
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择项目目录",
    })
    : await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "选择项目目录",
    });
  return result.canceled ? null : result.filePaths[0] || null;
}

function isImagePath(filePath: string): boolean {
  return new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"])
    .has(extname(filePath).toLowerCase());
}

function attachmentsFromFilePaths(filePaths: string[]): ComposerAttachment[] {
  return filePaths.flatMap((filePath): ComposerAttachment[] => {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return [];
      return [{
        path: filePath,
        name: basename(filePath),
        kind: isImagePath(filePath) ? "image" : "file",
        size: stat.size,
      }];
    } catch {
      return [];
    }
  });
}

function validateLocalFilePath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error("File path is invalid.");
  const stats = fs.statSync(value);
  if (!stats.isFile()) throw new Error("File is no longer available.");
  return value;
}

async function saveLocalFile(
  value: unknown,
  suggestedName: unknown,
  title = "Save generated file",
): Promise<string | null> {
  const sourcePath = validateLocalFilePath(value);
  const defaultName = typeof suggestedName === "string" && suggestedName.trim()
    ? basename(suggestedName.trim())
    : basename(sourcePath);
  const result = await dialog.showSaveDialog(mainWindow!, { title, defaultPath: defaultName });
  if (result.canceled || !result.filePath) return null;
  if (resolve(result.filePath) !== resolve(sourcePath)) fs.copyFileSync(sourcePath, result.filePath);
  return result.filePath;
}

function pastedImageDirectory(): string {
  return join(app.getPath("userData"), "temp", "pasted-images");
}

function resolveGatewayRoot(): string {
  return selectGatewayRoot([
    process.env.RHZYCODE_GATEWAY_HOME,
    app.getAppPath(),
    join(process.resourcesPath, "gateway"),
    join(app.getPath("userData"), "gateway"),
  ]);
}

function resolveCodexHome(): string {
  const configuredHome = process.env.RHZYCODE_CODEX_HOME?.trim();
  return configuredHome
    ? resolve(configuredHome)
    : join(app.getPath("userData"), "codex-home");
}

function resolveUserCodexHome(): string {
  const configuredHome = process.env.CODEX_HOME?.trim();
  return configuredHome ? resolve(configuredHome) : join(os.homedir(), ".codex");
}

function migrationSourceLabel(source: EnvironmentMigrationSource): string {
  return source === "codex" ? "Codex" : "Claude";
}

async function runStartupEnvironmentMigrations(
  codexHome: string,
  projectDirectories: ProjectDirectoryRegistry,
  window: BrowserWindow,
): Promise<void> {
  if (process.env.RHZYCODE_SKIP_ENVIRONMENT_MIGRATION === "1") return;

  await runFirstLaunchEnvironmentMigrations({
    statePath: join(app.getPath("userData"), "environment-migration.json"),
    codexSourceHome: resolveUserCodexHome(),
    codexDestinationHome: codexHome,
    createClaudeClient: () => new AppServerClient(),
    confirm: async (source, count) => {
      const label = migrationSourceLabel(source);
      const result = await showStartupDialog(window, () => dialog.showMessageBox(window, {
        type: "question",
        title: `迁移 ${label} 对话`,
        message: `检测到 ${count} 个 ${label} 项目对话，是否迁移到 RHZYCODE？`,
        detail: "只复制项目对话，不迁移 API Key、登录信息或模型配置，也不会删除原始数据。仍然存在的项目目录会自动加入项目列表。",
        buttons: ["迁移", "跳过"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }));
      return result.response === 0;
    },
    rememberProject: (projectPath) => {
      projectDirectories.remember(projectPath);
    },
    onProgress: (source, active) => {
      taskActivityPresenter?.setMigrationActive(active, migrationSourceLabel(source));
    },
    onError: async (source, error) => {
      console.error(`[Environment migration:${source}]`, error.message);
      await showStartupDialog(window, () => dialog.showMessageBox(window, {
        type: "error",
        title: `${migrationSourceLabel(source)} 对话迁移失败`,
        message: `${migrationSourceLabel(source)} 对话未能全部迁移`,
        detail: `${error.message}\n\n原始数据没有修改，下次启动时会再次尝试。`,
        buttons: ["确定"],
        defaultId: 0,
        noLink: true,
      }));
    },
  });
}

function useBundledCodexBinary(): void {
  const executable = bundledCodexExecutable();
  const bundledPath = [
    join(process.resourcesPath, "codex", executable),
    join(process.resourcesPath, "codex", "bin", executable),
  ].find((candidate) => fs.existsSync(candidate)) || join(process.resourcesPath, "codex", executable);
  const selectedPath = preferredCodexPath(
    bundledPath,
    fs.existsSync(bundledPath),
    process.env.RHZYCODE_CODEX_PATH,
  );
  if (selectedPath) process.env.RHZYCODE_CODEX_PATH = selectedPath;
}

function traceStartup(stage: string): void {
  if (process.env.RHZYCODE_STARTUP_TRACE !== "1") return;
  try {
    fs.appendFileSync(join(app.getPath("userData"), "startup-trace.log"), `${stage}\n`, "utf8");
  } catch {
    // Startup tracing is diagnostic-only and must never prevent the app from loading.
  }
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  traceStartup("ready");
  removeStalePastedImages(pastedImageDirectory());
  useBundledCodexBinary();
  traceStartup("codex-resolved");
  const gatewayRoot = resolveGatewayRoot();
  traceStartup("gateway-resolved");
  const encryption = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value: string) => safeStorage.encryptString(value),
    decrypt: (value: Buffer) => safeStorage.decryptString(value),
  };
  const credentials = new ProviderCredentialStore(
    gatewayRoot,
    join(app.getPath("userData"), "gateway-credentials.json"),
    encryption,
  );
  traceStartup("credentials-created");
  credentials.applyToEnvironment();
  const runtimeGatewayConfigPath = credentials.writeRuntimeConfig();
  traceStartup("credentials-applied");
  const updateManifestUrl = DEFAULT_UPDATE_MANIFEST_URL;
  const updatePlatform = desktopUpdatePlatform();
  const updates = new UpdateManager(
    autoUpdater as unknown as UpdateAdapter,
    updatePlatform !== null,
    {
      manifestUrl: updateManifestUrl,
      currentVersion: app.getVersion(),
      platform: updatePlatform || undefined,
      fetchImpl: systemFetch,
    },
  );
  traceStartup("updates-created");
  controlPersistence = new EncryptedControlPersistence(
    join(app.getPath("userData"), "control-state.bin"),
    encryption,
  );
  const controlStore = new ControlStore(controlPersistence.load());
  controlPersistence.attach(controlStore);
  traceStartup("control-state-loaded");
  const mobileAccessState = new EncryptedStateFile<MobileAccessState>(
    join(app.getPath("userData"), "mobile-access-state.bin"),
    encryption,
    (value) => {
      const normalized = normalizeMobileAccessState(value);
      return normalized
        ? { state: normalized.state, partial: normalized.discardedInvalidRecords }
        : null;
    },
  );
  const mobileAccess = new MobileAccessManager(
    mobileAccessState.load(),
    (state) => mobileAccessState.save(state),
  );
  traceStartup("mobile-access-state-loaded");
  const projectDirectoryState = new EncryptedStateFile<ProjectDirectoryState>(
    join(app.getPath("userData"), "project-directories.bin"),
    encryption,
    (value) => {
      const state = normalizeProjectDirectoryState(value);
      return state ? { state } : null;
    },
  );
  const projectDirectories = new ProjectDirectoryRegistry(
    projectDirectoryState.load(),
    encryption.isAvailable() ? (state) => projectDirectoryState.save(state) : undefined,
  );
  traceStartup("project-directories-loaded");
  const codexHome = resolveCodexHome();
  const skillsManager = new SkillsManager(join(codexHome, "skills"), {
    codex: join(resolveUserCodexHome(), "skills"),
    claude: join(os.homedir(), ".claude", "skills"),
  });
  runtime = new DesktopRuntime(
    gatewayRoot,
    codexHome,
    controlStore,
    mobileAccess,
    projectDirectories,
    runtimeGatewayConfigPath,
    systemFetch,
  );
  traceStartup("runtime-created");
  registerIpc(runtime, codexHome, credentials, updates, mobileAccess, skillsManager, () => ({
    encryptionAvailable: encryption.isAvailable(),
    controlState: controlPersistence!.getLoadStatus(),
    mobileAccessState: mobileAccessState.getLoadStatus(),
  }));
  traceStartup("ipc-registered");
  let finishEnvironmentMigration!: () => void;
  startupEnvironmentMigration = new Promise<void>((resolveMigration) => {
    finishEnvironmentMigration = resolveMigration;
  });
  const window = createWindow();
  taskActivityPresenter = new WindowTaskActivityPresenter(() => mainWindow);
  traceStartup("window-created");
  await new Promise<void>((resolveWindow) => {
    if (!window.webContents.isLoadingMainFrame()) resolveWindow();
    else window.webContents.once("did-finish-load", () => resolveWindow());
  });
  try {
    try {
      await runStartupEnvironmentMigrations(codexHome, projectDirectories, window);
      traceStartup("environment-migration-checked");
      const providerNormalization = normalizeCodexSessionProvidersOnce(
        codexHome,
        join(app.getPath("userData"), "session-provider-normalization.json"),
      );
      traceStartup(
        `session-providers-normalized: ${providerNormalization.normalizedCount}/${providerNormalization.examinedCount}`,
      );
      if (providerNormalization.failedCount > 0) {
        window.webContents.send(
          "agent:diagnostic",
          `${providerNormalization.failedCount} migrated conversation(s) could not be made compatible with the local model gateway.`,
        );
      }
    } catch (error) {
      window.webContents.send("agent:diagnostic", `Conversation migration failed: ${String(error)}`);
    }
    await runtime.start();
  } catch (error) {
    window.webContents.send("agent:diagnostic", String(error));
  } finally {
    finishEnvironmentMigration();
  }
  updates.start();
}).catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  traceStartup(`failed: ${message.replace(/[\r\n]+/g, " ").slice(0, 1000)}`);
  console.error("[Startup]", message);
  dialog.showErrorBox("RHZYCODE startup failed", message);
  app.exit(1);
});

app.on("before-quit", (event) => {
  if (quitAfterCleanup || !runtime) return;
  event.preventDefault();
  void runtime.stop().finally(() => {
    void controlPersistence?.flush().finally(() => {
      controlPersistence?.detach();
      quitAfterCleanup = true;
      app.quit();
    });
  });
});

app.on("window-all-closed", () => {
  if (shouldQuitWhenAllWindowsClose()) app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

class WindowTaskActivityPresenter {
  private holdTimer: NodeJS.Timeout | null = null;
  private latest: TaskActivityStatus = {
    activeCount: 0,
    runningCount: 0,
    waitingCount: 0,
    lastEvent: null,
  };
  private migrationActive = false;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  setMigrationActive(active: boolean, sourceLabel = ""): void {
    this.migrationActive = active;
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    this.clearHold();
    if (active) {
      window.setProgressBar(2, { mode: "indeterminate" });
      window.setTitle(`RHZYCODE - 正在迁移 ${sourceLabel} 对话`.trim());
      this.publish({
        activeCount: 0,
        runningCount: 0,
        waitingCount: 0,
        lastEvent: null,
      }, {
        progress: 2,
        mode: "indeterminate",
        title: `RHZYCODE - 正在迁移 ${sourceLabel} 对话`.trim(),
        accent: "running",
        shouldFlash: false,
        notification: null,
        holdMs: 0,
      });
      return;
    }
    this.apply(this.latest, true);
  }

  handle(activity: TaskActivityStatus): void {
    this.latest = activity;
    if (this.migrationActive) return;
    this.apply(activity, false);
  }

  private apply(activity: TaskActivityStatus, suppressCompletionCue: boolean): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    const focused = window.isFocused();
    const effective = suppressCompletionCue ? { ...activity, lastEvent: null } : activity;
    const chrome = resolveTaskWindowChrome(effective, { focused });
    this.clearHold();
    this.paint(window, chrome);
    this.publish(effective, chrome);

    if (chrome.shouldFlash) window.flashFrame(true);
    if (chrome.notification && Notification.isSupported()) {
      const notification = new Notification({
        title: chrome.notification.title,
        body: chrome.notification.body,
      });
      notification.on("click", () => {
        const target = this.getWindow();
        if (!target || target.isDestroyed()) return;
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
      });
      notification.show();
    }

    if (chrome.holdMs > 0) {
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        const current = this.getWindow();
        if (!current || current.isDestroyed() || this.migrationActive) return;
        const steadyActivity = { ...this.latest, lastEvent: null };
        const steady = resolveTaskWindowChrome(steadyActivity, { focused: current.isFocused() });
        this.paint(current, steady);
        this.publish(steadyActivity, steady);
      }, chrome.holdMs);
    }
  }

  private paint(
    window: BrowserWindow,
    chrome: ReturnType<typeof resolveTaskWindowChrome>,
  ): void {
    if (chrome.mode === "none" || chrome.progress < 0) window.setProgressBar(-1);
    else window.setProgressBar(chrome.progress, { mode: chrome.mode });
    window.setTitle(chrome.title);
  }

  private publish(
    activity: TaskActivityStatus,
    chrome: ReturnType<typeof resolveTaskWindowChrome>,
  ): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    const payload: RendererTaskActivityStatus = toRendererTaskActivity(activity, chrome);
    window.webContents.send("task:activity", payload);
  }

  private clearHold(): void {
    if (!this.holdTimer) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }
}
