import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage } from "electron";
import updaterPackage from "electron-updater";
import {
  ControlStore,
  MobileAccessManager,
  normalizeMobileAccessState,
  type MobileAccessState,
} from "./control-plane/app";
import fs from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { DesktopRuntime } from "./runtime";
import {
  ProjectDirectoryRegistry,
  normalizeProjectDirectoryState,
  type ProjectDirectoryState,
} from "./project-directories";
import type { ComposerAttachment } from "../shared/desktop-api";
import { ProviderCredentialStore } from "./credential-store";
import { detectLlmProtocol } from "./llm-protocol";
import { DesktopSettingsStore, isValidSyncPort } from "./desktop-settings";
import { removeStalePastedImages, savePastedImage } from "./pasted-image-store";
import { buildTextContextMenu } from "./text-context-menu";
import { UpdateManager, type UpdateAdapter } from "./update-manager";
import { EncryptedControlPersistence, EncryptedStateFile, type PersistenceStatus } from "./control-persistence";
import {
  validateApprovalResolution,
  validateClipboardText,
  validateCredentialUpdate,
  validateIdentifier,
  validateLlmProviderConfiguration,
  validateProjectPath,
  validateStartThread,
  validateStartTurn,
  validateSyncPort,
  validateTerminalResize,
  validateTerminalStart,
  validateTerminalWrite,
  validateThreadListOptions,
  validateThreadRename,
  validateUserInputResolution,
} from "./ipc-validation";

const { autoUpdater } = updaterPackage;

let mainWindow: BrowserWindow | null = null;
let runtime: DesktopRuntime | null = null;
let controlPersistence: EncryptedControlPersistence | null = null;
let quitAfterCleanup = false;

const userDataOverride = process.env.RHZYCODE_USER_DATA_DIR?.trim();
if (userDataOverride) app.setPath("userData", resolve(userDataOverride));

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function createWindow(): void {
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
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const menu = Menu.buildFromTemplate(buildTextContextMenu(params));
    menu.popup({ window: mainWindow || undefined });
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function registerIpc(
  activeRuntime: DesktopRuntime,
  credentials: ProviderCredentialStore,
  updates: UpdateManager,
  mobileAccess: MobileAccessManager,
  desktopSettings: DesktopSettingsStore,
  getPersistenceStatus: () => PersistenceStatus,
): void {
  ipcMain.handle("agent:status", () => activeRuntime.agent.getStatus());
  ipcMain.handle("agent:connect", async () => {
    await activeRuntime.startGatewayAndAgent().catch(() => undefined);
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
  ipcMain.handle("agent:thread:rename", (_event, threadId: unknown, name: unknown) => {
    const input = validateThreadRename(threadId, name);
    return activeRuntime.renameThread(input.threadId, input.name);
  });
  ipcMain.handle("agent:thread:delete", (_event, threadId: unknown) =>
    activeRuntime.deleteThread(validateIdentifier(threadId, "threadId")),
  );
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
    });
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

  ipcMain.handle("sync:status", () => activeRuntime.getSyncStatus());
  ipcMain.handle("sync:port:set", async (_event, value: unknown) => {
    const port = validateSyncPort(value);
    const status = await activeRuntime.setSyncPort(port);
    desktopSettings.save({ syncPort: port });
    return status;
  });
  ipcMain.handle("sync:snapshot", () => activeRuntime.getSnapshot());
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
  ipcMain.handle("project:choose-files", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile", "multiSelections"],
      title: "Choose files or images",
    });
    if (result.canceled) return [];
    return result.filePaths.flatMap((filePath): ComposerAttachment[] => {
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return [];
        return [{
          path: filePath,
          name: filePath.split(/[\\/]/).at(-1) || filePath,
          kind: isImagePath(filePath) ? "image" : "file",
          size: stat.size,
        }];
      } catch {
        return [];
      }
    });
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

  activeRuntime.on("agent:status", (status) => mainWindow?.webContents.send("agent:status", status));
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

function pastedImageDirectory(): string {
  return join(app.getPath("userData"), "temp", "pasted-images");
}

function resolveGatewayRoot(): string {
  const candidates = [
    process.env.RHZYCODE_GATEWAY_HOME,
    resolve(app.getAppPath(), "model-gateway"),
    join(process.resourcesPath, "gateway"),
    join(app.getPath("userData"), "gateway"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => fs.existsSync(join(candidate, "gateway.config.json"))) || candidates[0]!;
}

function resolveCodexHome(): string {
  const configuredHome = process.env.RHZYCODE_CODEX_HOME?.trim();
  return configuredHome
    ? resolve(configuredHome)
    : join(app.getPath("userData"), "codex-home");
}

function useBundledCodexBinary(): void {
  if (process.env.RHZYCODE_CODEX_PATH) return;
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  const bundledPath = join(process.resourcesPath, "codex", executable);
  if (fs.existsSync(bundledPath)) process.env.RHZYCODE_CODEX_PATH = bundledPath;
}

function traceStartup(stage: string): void {
  if (process.env.RHZYCODE_STARTUP_TRACE !== "1") return;
  try {
    fs.appendFileSync(join(app.getPath("userData"), "startup-trace.log"), `${stage}\n`, "utf8");
  } catch {
    // Startup tracing is diagnostic-only and must never prevent the app from loading.
  }
}

app.whenReady().then(() => {
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
  const updateUrl = process.env.RHZYCODE_UPDATE_URL?.trim()
    || "http://192.168.11.103:8791/desktop";
  const updates = new UpdateManager(
    autoUpdater as unknown as UpdateAdapter,
    true,
    updateUrl,
  );
  traceStartup("updates-created");
  const environmentSyncPort = Number(process.env.RHZYCODE_SYNC_PORT || 8790);
  const startupSyncPort = environmentSyncPort === 0 || isValidSyncPort(environmentSyncPort)
    ? environmentSyncPort
    : 8790;
  const desktopSettings = new DesktopSettingsStore(join(app.getPath("userData"), "desktop-settings.json"));
  const savedDesktopSettings = desktopSettings.load(startupSyncPort);
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
  if (!mobileAccess.status().accessKey && encryption.isAvailable()) {
    mobileAccess.rotateAccessKey();
  }
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
  runtime = new DesktopRuntime(
    gatewayRoot,
    resolveCodexHome(),
    undefined,
    savedDesktopSettings.syncPort,
    controlStore,
    mobileAccess,
    projectDirectories,
    runtimeGatewayConfigPath,
  );
  traceStartup("runtime-created");
  registerIpc(runtime, credentials, updates, mobileAccess, desktopSettings, () => ({
    encryptionAvailable: encryption.isAvailable(),
    controlState: controlPersistence!.getLoadStatus(),
    mobileAccessState: mobileAccessState.getLoadStatus(),
  }));
  traceStartup("ipc-registered");
  createWindow();
  traceStartup("window-created");
  updates.start();
  void runtime.start().catch((error) => {
    mainWindow?.webContents.send("agent:diagnostic", String(error));
  });
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
    controlPersistence?.flush();
    controlPersistence?.detach();
    quitAfterCleanup = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
