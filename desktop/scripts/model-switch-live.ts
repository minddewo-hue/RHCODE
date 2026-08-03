import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopRuntime } from "../src/main/runtime.js";

interface AgentMessage {
  method?: string;
  params?: Record<string, unknown>;
}

interface RequestShape {
  model: string;
  previousResponse: boolean;
  inputItems: number;
  inputKinds: string[];
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(desktopRoot, "..");
const gatewayRoot = process.env.RHZYCODE_GATEWAY_HOME?.trim() || desktopRoot;
const runtimeConfigPath = process.env.RHZYCODE_SWITCH_GATEWAY_CONFIG?.trim();
if (runtimeConfigPath && !fs.existsSync(runtimeConfigPath)) {
  throw new Error(`Runtime gateway config is missing: ${runtimeConfigPath}`);
}

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rhzycode-model-switch-"));
const requestShapes: RequestShape[] = [];
const externalGatewayUrl = process.env.RHZYCODE_SWITCH_GATEWAY_URL?.trim();
const externalCatalogPath = process.env.RHZYCODE_SWITCH_CATALOG_PATH?.trim();
if (Boolean(externalGatewayUrl) !== Boolean(externalCatalogPath)) {
  throw new Error("RHZYCODE_SWITCH_GATEWAY_URL and RHZYCODE_SWITCH_CATALOG_PATH must be set together.");
}
const observedFetch: typeof fetch = async (input, init) => {
  if (typeof init?.body === "string") {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (typeof body.model === "string") {
        const items = Array.isArray(body.input) ? body.input : [];
        requestShapes.push({
          model: body.model,
          previousResponse: typeof body.previous_response_id === "string",
          inputItems: items.length,
          inputKinds: items.map((item) => {
            const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
            return [record.type, record.role].filter(Boolean).join(":") || typeof item;
          }),
        });
      }
    } catch {
      // Provider discovery and non-JSON requests are outside this diagnostic.
    }
  }
  return fetch(input, init);
};

const runtime = new DesktopRuntime(
  gatewayRoot,
  codexHome,
  undefined,
  undefined,
  undefined,
  runtimeConfigPath,
  observedFetch,
);
let observingProxy: http.Server | null = null;
if (externalGatewayUrl && externalCatalogPath) {
  const proxy = await startObservingProxy(externalGatewayUrl);
  observingProxy = proxy.server;
  const status = {
    state: "running" as const,
    transport: "internal" as const,
    providerCount: 0,
    modelCount: 0,
    configSource: "existing-client",
    providers: [],
    models: [],
    error: null,
  };
  runtime.gateway.start = async () => status;
  runtime.gateway.stop = async () => ({ ...status, state: "stopped" as const });
  runtime.gateway.getStatus = () => status;
  runtime.gateway.getBaseUrl = () => proxy.baseUrl;
  runtime.gateway.getCatalogPath = () => externalCatalogPath;
}

try {
  await runtime.start();
  const catalog = await runtime.listModels();
  const models = catalog.data || [];
  const preferred = [
    "provider-2/grok-latest",
    "provider-5/gpt-5.6-sol",
    "provider-3/gemma4-31b-uncensored-bf16-256k-seq4",
  ];
  const modelsByProvider = new Map<string, string[]>();
  for (const model of models) {
    const provider = model.model.split("/", 1)[0]!;
    const group = modelsByProvider.get(provider) || [];
    group.push(model.model);
    modelsByProvider.set(provider, group);
  }
  const representatives = [...modelsByProvider.values()].map((group) =>
    preferred.find((model) => group.includes(model)) || group[0]!,
  );
  if (representatives.length < 2) {
    throw new Error(`At least two provider groups are required; found ${representatives.length}.`);
  }
  const firstPass = representatives.slice(0, 3);
  const selected = firstPass.length > 1 ? [...firstPass, firstPass[0]!] : firstPass;
  console.log(`SWITCH_MODELS ${selected.join(" -> ")}`);

  const started = await runtime.startThread({
    cwd: workspaceRoot,
    model: selected[0],
    approvalPolicy: "never",
    sandboxMode: "read-only",
  });
  const threadId = String(started.thread?.id || "");
  if (!threadId) throw new Error("thread/start returned no thread id.");

  const marker = `RHZY_SWITCH_${Date.now().toString(36).toUpperCase()}`;
  const prompts = selected.map((_, index) => index === 0
    ? `Do not use tools. Remember the marker ${marker}. Reply with exactly SWITCH_STEP_1_OK.`
    : `Do not use tools. Using the conversation history, reply with exactly ${marker}.`);
  for (let index = 0; index < selected.length; index += 1) {
    const output = await runTurn(threadId, selected[index]!, prompts[index]!);
    const expected = index === 0 ? "SWITCH_STEP_1_OK" : marker;
    const ok = finalAnswer(output) === expected;
    console.log(`${ok ? "PASS" : "FAIL"} step=${index + 1} model=${selected[index]} output=${JSON.stringify(finalAnswer(output).slice(0, 160))}`);
    if (!ok) throw new Error(`Model switch step ${index + 1} did not preserve the expected conversation state.`);
  }

  console.log(`REQUEST_SHAPES ${JSON.stringify(requestShapes)}`);
} finally {
  await runtime.stop().catch(() => undefined);
  if (observingProxy) await new Promise<void>((resolve) => observingProxy!.close(() => resolve()));
  await removeTempDirectory(codexHome);
}

async function removeTempDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) {
        console.error(`TEMP_CLEANUP_WARNING ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function startObservingProxy(upstreamBaseUrl: string): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bodyBuffer = Buffer.concat(chunks);
      if (bodyBuffer.length > 0) {
        try {
          const body = JSON.parse(bodyBuffer.toString("utf8")) as Record<string, unknown>;
          if (typeof body.model === "string") {
            const items = Array.isArray(body.input) ? body.input : [];
            requestShapes.push({
              model: body.model,
              previousResponse: typeof body.previous_response_id === "string",
              inputItems: items.length,
              inputKinds: items.map((item) => {
                const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
                return [record.type, record.role].filter(Boolean).join(":") || typeof item;
              }),
            });
          }
        } catch {
          // Only JSON model requests are relevant to the switch diagnostic.
        }
      }
      const target = new URL(request.url || "/", `${upstreamBaseUrl.replace(/\/$/, "")}/`);
      const upstream = await fetch(target, {
        method: request.method,
        headers: Object.fromEntries(Object.entries(request.headers).flatMap(([key, value]) =>
          value == null || key === "host" || key === "content-length" ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]])),
        ...(bodyBuffer.length > 0 ? { body: bodyBuffer } : {}),
      });
      response.writeHead(upstream.status, Object.fromEntries([...upstream.headers.entries()].filter(([key]) =>
        key !== "content-encoding" && key !== "content-length" && key !== "transfer-encoding")));
      if (upstream.body) {
        for await (const chunk of upstream.body) response.write(chunk);
      }
      response.end();
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Observing proxy did not bind to a TCP port.");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function runTurn(threadId: string, model: string, text: string): Promise<string> {
  let output = "";
  let listener: ((message: unknown) => void) | undefined;
  const completed = new Promise<Record<string, unknown>>((resolve) => {
    listener = (raw: unknown) => {
      const message = raw as AgentMessage;
      if (String(message.params?.threadId || "") !== threadId) return;
      if (message.method === "item/agentMessage/delta") output += String(message.params?.delta || "");
      if (message.method === "item/completed") {
        const item = message.params?.item as Record<string, unknown> | undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string" && !output) output = item.text;
      }
      if (message.method === "turn/completed") resolve((message.params?.turn || {}) as Record<string, unknown>);
    };
    runtime.on("agent:message", listener);
  });
  try {
    await withTimeout(runtime.startTurn({ threadId, text, model }), 30_000, "turn/start");
    const turn = await withTimeout(completed, 180_000, "turn/completed");
    if (String(turn.status || "").toLowerCase().includes("fail")) {
      throw new Error(JSON.stringify(turn.error || turn));
    }
    return output;
  } finally {
    if (listener) runtime.off("agent:message", listener);
  }
}

function finalAnswer(value: string): string {
  return value.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
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
