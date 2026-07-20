import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(desktopDir, "release", "win-unpacked", "RHZYCODE.exe");
if (!fs.existsSync(executable)) throw new Error("Build the unpacked desktop release before mobile access smoke.");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-mobile-access-smoke-"));
const syncUrl = "http://127.0.0.1:8791";
const cdpUrl = "http://127.0.0.1:9336";
let appProcess = null;

try {
  let session = await launch();
  await assertLongConversationLayout(session);
  const initialUpdates = await session.evaluate("window.rhzycode.getUpdateStatus()");
  if (initialUpdates.enabled || initialUpdates.state !== "disabled") {
    throw new Error("Unsigned local release unexpectedly enabled automatic updates.");
  }
  const access = await session.evaluate("window.rhzycode.getMobileAccessStatus()");
  const key = access.accessKey?.key;
  if (!key) throw new Error("Desktop did not generate a persistent mobile access key.");
  const unauthorized = await fetch(`${syncUrl}/v1/snapshot`);
  if (unauthorized.status !== 401) throw new Error(`Expected unauthenticated 401, got ${unauthorized.status}.`);
  const authorized = await fetch(`${syncUrl}/v1/snapshot`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!authorized.ok) throw new Error(`Authenticated snapshot failed with HTTP ${authorized.status}.`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assertEncryptedFile("mobile-access-state.bin", key);
  assertEncryptedFile("control-state.bin", "local-desktop");
  await session.close();

  session = await launch();
  const restored = await fetch(`${syncUrl}/v1/snapshot`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!restored.ok) throw new Error(`Restored KEY failed with HTTP ${restored.status}.`);
  const status = await session.evaluate("window.rhzycode.getMobileAccessStatus()");
  if (status.accessKey?.key !== key) throw new Error("Mobile access key did not survive restart.");
  const replacement = await session.evaluate("window.rhzycode.rotateMobileAccessKey()");
  const revoked = await fetch(`${syncUrl}/v1/snapshot`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (revoked.status !== 401) throw new Error(`Replaced key returned HTTP ${revoked.status}.`);
  const replacementAuthorized = await fetch(`${syncUrl}/v1/snapshot`, {
    headers: { Authorization: `Bearer ${replacement.key}` },
  });
  if (!replacementAuthorized.ok) {
    throw new Error(`Replacement key failed with HTTP ${replacementAuthorized.status}.`);
  }
  await session.evaluate("document.querySelector('button[title=\"Settings\"]')?.click()");
  const connectionVisible = await waitForEvaluation(
    session,
    "document.querySelectorAll('.connection-field').length === 3",
    5000,
  );
  if (!connectionVisible) throw new Error("Mobile IP, port, and access key were not rendered.");
  const storageRows = await session.evaluate("document.querySelectorAll('.storage-state-row').length");
  if (storageRows !== 2) throw new Error(`Expected two storage restore rows, found ${storageRows}.`);
  await session.close();
  console.log("Desktop smoke passed: long conversation layout, persistent key auth, encrypted restart, rotation, and connection UI.");
} finally {
  await stopCurrentProcess();
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  const resolvedDataDir = path.resolve(dataDir);
  if (resolvedDataDir.startsWith(tempRoot)) {
    try {
      fs.rmSync(resolvedDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      console.warn(`Unable to remove mobile access smoke data: ${error instanceof Error ? error.message : error}`);
    }
  }
}

async function launch() {
  let stdout = "";
  let stderr = "";
  appProcess = spawn(executable, ["--remote-debugging-port=9336", `--user-data-dir=${dataDir}`], {
    env: {
      ...process.env,
      RHZYCODE_SYNC_PORT: "8791",
      RHZYCODE_STARTUP_TRACE: "1",
      RHZYCODE_USER_DATA_DIR: dataDir,
      RHZYCODE_GATEWAY_HOME: "",
      FAKER_API_KEY: "",
      SUB2API_API_KEY: "",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  appProcess.stdout.setEncoding("utf8");
  appProcess.stdout.on("data", (chunk) => { stdout += chunk; });
  appProcess.stderr.setEncoding("utf8");
  appProcess.stderr.on("data", (chunk) => { stderr += chunk; });
  const target = await waitForTarget(() => {
    if (appProcess.exitCode == null) return null;
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    return `Packaged app exited with code ${appProcess.exitCode}.${output ? `\n${output}` : ""}`;
  });
  const client = await createCdpClient(target.webSocketDebuggerUrl);
  const session = {
    evaluate: (expression) => client.evaluate(expression),
    async close() {
      const child = appProcess;
      await client.evaluate("window.close()").catch(() => undefined);
      await waitForProcessExit(child, 5000);
      if (child.exitCode == null) {
        child.kill();
        await waitForProcessExit(child, 3000);
      }
      client.close();
      if (/Error occurred in handler|Uncaught/i.test(stderr)) throw new Error(stderr.trim());
    },
  };
  if (!await waitForEvaluation(session, "Boolean(document.querySelector('.app-shell'))", 5000)) {
    throw new Error("Packaged renderer target opened but the application shell did not mount.");
  }
  return session;
}

async function stopCurrentProcess() {
  const child = appProcess;
  if (!child || child.exitCode != null) return;
  child.kill();
  await waitForProcessExit(child, 3000);
}

async function waitForProcessExit(child, timeoutMs) {
  if (!child || child.exitCode != null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function waitForEvaluation(session, expression, timeoutMs) {
  const expiresAt = Date.now() + timeoutMs;
  while (Date.now() < expiresAt) {
    if (await session.evaluate(expression).catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForTarget(getProcessError) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const processError = getProcessError();
    if (processError) throw new Error(processError);
    try {
      const targets = await (await fetch(`${cdpUrl}/json/list`)).json();
      if (targets[0]?.webSocketDebuggerUrl) return targets[0];
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const output = getProcessError();
  const tracePath = path.join(dataDir, "startup-trace.log");
  const trace = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8").trim() : "not created";
  throw new Error(output || `Packaged renderer did not start before the 20 second timeout.\nStartup trace:\n${trace}`);
}

async function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    message.error ? callbacks.reject(new Error(message.error.message)) : callbacks.resolve(message.result);
  };
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const callId = ++id;
      pending.set(callId, { resolve, reject });
      socket.send(JSON.stringify({ id: callId, method, params }));
    });
  }
  await call("Runtime.enable");
  return {
    async evaluate(expression) {
      const response = await call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      return response.result.value;
    },
    close: () => socket.close(),
  };
}

async function assertLongConversationLayout(session) {
  const layout = await session.evaluate(`(() => {
    const shell = document.querySelector('.app-shell');
    const workspace = document.querySelector('.workspace');
    const conversation = document.querySelector('.conversation');
    const composer = document.querySelector('.composer-wrap');
    if (!shell || !workspace || !conversation || !composer) return null;

    const probe = document.createElement('div');
    probe.className = 'message-list layout-smoke-probe';
    const message = document.createElement('article');
    message.className = 'message assistant';
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    const body = document.createElement('div');
    const author = document.createElement('div');
    author.className = 'message-author';
    author.textContent = 'Layout smoke';
    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = Array.from(
      { length: 180 },
      (_, index) => 'Long response line ' + (index + 1) + ': desktop remains the scroll owner.',
    ).join('\\n');
    body.append(author, content);
    message.append(avatar, body);
    probe.append(message);
    conversation.append(probe);

    const composerRect = composer.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    const scrollable = conversation.scrollHeight > conversation.clientHeight;
    conversation.scrollTop = conversation.scrollHeight;
    const scrollMoved = conversation.scrollTop > 0;
    const result = {
      viewportHeight: window.innerHeight,
      shellHeight: shellRect.height,
      workspaceBottom: workspaceRect.bottom,
      composerTop: composerRect.top,
      composerBottom: composerRect.bottom,
      conversationHeight: conversation.clientHeight,
      scrollable,
      scrollMoved,
    };
    probe.remove();
    return result;
  })()`);
  if (!layout) throw new Error("Long conversation layout elements were not available.");
  if (Math.abs(layout.shellHeight - layout.viewportHeight) > 1) {
    throw new Error(`Application shell escaped the viewport: ${JSON.stringify(layout)}.`);
  }
  if (layout.workspaceBottom > layout.viewportHeight + 1) {
    throw new Error(`Workspace escaped the viewport: ${JSON.stringify(layout)}.`);
  }
  if (layout.composerTop < 0 || layout.composerBottom > layout.viewportHeight + 1) {
    throw new Error(`Composer is not visible after a long response: ${JSON.stringify(layout)}.`);
  }
  if (layout.conversationHeight <= 0 || !layout.scrollable || !layout.scrollMoved) {
    throw new Error(`Conversation did not become independently scrollable: ${JSON.stringify(layout)}.`);
  }
}

function assertEncryptedFile(name, forbiddenText) {
  const filePath = path.join(dataDir, name);
  if (!fs.existsSync(filePath)) throw new Error(`${name} was not persisted.`);
  if (fs.readFileSync(filePath).includes(Buffer.from(forbiddenText))) {
    throw new Error(`${name} contains plaintext state.`);
  }
}
