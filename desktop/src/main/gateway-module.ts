import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  startEmbeddedGateway,
  type EmbeddedGatewayHandle,
  type EmbeddedGatewayModel,
  type EmbeddedGatewayProvider,
} from "../../model-gateway/src/embedded.js";

export type GatewayModuleState = "stopped" | "starting" | "running" | "error";

export interface GatewayModuleStatus {
  state: GatewayModuleState;
  transport: "internal";
  providerCount: number;
  modelCount: number;
  configSource: string | null;
  providers: EmbeddedGatewayProvider[];
  models: EmbeddedGatewayModel[];
  error: string | null;
}

export class GatewayModule extends EventEmitter {
  private handle: EmbeddedGatewayHandle | null = null;
  private state: GatewayModuleState = "stopped";
  private error: string | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private probeInFlight: Promise<GatewayModuleStatus> | null = null;
  private catalogPath: string | null = null;

  constructor(
    private readonly rootDir: string,
    private readonly envPath = resolveGatewayEnvPath(rootDir),
    private readonly configPath?: string,
  ) {
    super();
  }

  getStatus(): GatewayModuleStatus {
    return {
      state: this.state,
      transport: "internal",
      providerCount: this.handle?.providerCount || 0,
      modelCount: this.handle?.modelCount || 0,
      configSource: this.handle?.configSource || null,
      providers: this.handle?.providers || [],
      models: this.handle?.models || [],
      error: this.error,
    };
  }

  getBaseUrl(): string {
    if (!this.handle) throw new Error("Embedded model gateway is not running.");
    return this.handle.baseUrl;
  }

  getCatalogPath(): string {
    if (!this.catalogPath) throw new Error("Embedded model catalog is not ready.");
    return this.catalogPath;
  }

  async start(): Promise<GatewayModuleStatus> {
    if (this.handle) return this.getStatus();
    this.setState("starting");
    try {
      this.handle = await startEmbeddedGateway({
        rootDir: this.rootDir,
        envPath: this.envPath,
        configPath: this.configPath,
        port: 0,
      });
      this.catalogPath = this.writeRuntimeCatalog(this.handle.models);
      this.error = null;
      this.setState("running");
      this.startProbeLoop();
      void this.probeProviders();
      return this.getStatus();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.setState("error");
      throw error;
    }
  }

  async stop(): Promise<GatewayModuleStatus> {
    this.stopProbeLoop();
    const handle = this.handle;
    this.handle = null;
    this.catalogPath = null;
    if (handle) await handle.stop();
    this.error = null;
    this.setState("stopped");
    return this.getStatus();
  }

  private writeRuntimeCatalog(models: EmbeddedGatewayModel[]): string {
    const sourcePath = path.join(this.rootDir, "codex-model-catalog.json");
    const catalog = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as { models: Array<Record<string, unknown>> };
    const entries = new Map(catalog.models.map((entry) => [String(entry.slug), entry]));
    for (const [index, model] of models.entries()) {
      const existing = entries.get(model.id);
      if (existing) {
        if (model.runtimeInstructions || model.contextWindow) {
          const entry = structuredClone(existing);
          const instructions = String(entry.base_instructions || "");
          if (model.runtimeInstructions && !instructions.includes("# Model Runtime Rules")) {
            entry.base_instructions = `${instructions}\n\n# Model Runtime Rules\n${model.runtimeInstructions}`;
          }
          if (model.contextWindow) {
            entry.context_window = model.contextWindow;
            entry.max_context_window = model.contextWindow;
            entry.effective_context_window_percent = 90;
          }
          entries.set(model.id, entry);
        }
        continue;
      }
      const template = catalog.models.find((entry) =>
        model.id.startsWith("vllm/") ? String(entry.slug).startsWith("vllm/") : String(entry.slug).startsWith(`${model.providerId}/`),
      ) || catalog.models[0];
      if (!template) continue;
      const entry = structuredClone(template);
      entry.slug = model.id;
      entry.display_name = `${model.ownedBy} - ${model.upstreamModel}`;
      entry.description = `${model.upstreamModel} through the local RHZY gateway.`;
      entry.priority = index + 1;
      if (model.protocol !== "responses") {
        const instructions = String(entry.base_instructions || "");
        const remainder = instructions.includes("\n\n") ? instructions.slice(instructions.indexOf("\n\n")) : "";
        const runtimeInstructions = model.runtimeInstructions
          ? `\n\n# Model Runtime Rules\n${model.runtimeInstructions}`
          : "";
        entry.base_instructions = `You are Codex, a coding agent powered by ${model.upstreamModel} through the Codex CLI. The active model ID is ${model.id}. If asked which model is active, answer with this model ID and do not claim to be an OpenAI GPT model.${remainder}${runtimeInstructions}`;
        entry.default_reasoning_level = null;
        entry.supported_reasoning_levels = [];
        entry.supports_reasoning_summaries = false;
        entry.default_reasoning_summary = "none";
        entry.support_verbosity = false;
        entry.default_verbosity = null;
        entry.supports_parallel_tool_calls = model.capabilities.parallel_tool_calls !== false;
        entry.supports_image_detail_original = false;
        entry.input_modalities = ["text"];
        entry.supports_search_tool = false;
        entry.use_responses_lite = false;
        entry.shell_type = "default";
        entry.apply_patch_tool_type = null;
        entry.context_window = Number(entry.context_window) || 131_072;
        entry.max_context_window = entry.context_window;
        entry.effective_context_window_percent = 90;
      }
      if (model.contextWindow) {
        entry.context_window = model.contextWindow;
        entry.max_context_window = model.contextWindow;
        entry.effective_context_window_percent = 90;
      }
      entries.set(model.id, entry);
    }
    catalog.models = models
      .map((model) => entries.get(model.id))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
    const outputPath = path.join(os.tmpdir(), `rhzycode-model-catalog-${process.pid}.json`);
    fs.writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    return outputPath;
  }

  async restart(): Promise<GatewayModuleStatus> {
    await this.stop();
    return this.start();
  }

  async probeProviders(): Promise<GatewayModuleStatus> {
    if (!this.handle) throw new Error("Embedded model gateway is not running.");
    if (this.probeInFlight) return this.probeInFlight;
    const handle = this.handle;
    this.probeInFlight = handle.probeProviders().then(() => {
      if (this.handle === handle) this.emit("status", this.getStatus());
      return this.getStatus();
    }).finally(() => {
      this.probeInFlight = null;
    });
    return this.probeInFlight;
  }

  private startProbeLoop(): void {
    this.stopProbeLoop();
    this.probeTimer = setInterval(() => {
      void this.probeProviders().catch(() => undefined);
    }, 60_000);
    this.probeTimer.unref();
  }

  private stopProbeLoop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  private setState(state: GatewayModuleState): void {
    this.state = state;
    this.emit("status", this.getStatus());
  }
}

export function resolveGatewayEnvPath(rootDir: string): string {
  const resolvedRoot = path.resolve(rootDir);
  return path.basename(resolvedRoot).toLowerCase() === "model-gateway"
    ? path.join(path.dirname(resolvedRoot), ".env")
    : path.join(resolvedRoot, ".env");
}

export function selectGatewayRoot(candidates: Array<string | undefined>): string {
  const available = candidates.filter((candidate): candidate is string => Boolean(candidate));
  if (available.length === 0) throw new Error("No model gateway location is available.");
  return available.find((candidate) => fs.existsSync(path.join(candidate, "gateway.config.json")))
    || available[0]!;
}
