import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";

type AppServerState = "disconnected" | "connecting" | "connected" | "error";

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer?: NodeJS.Timeout;
}

interface AppServerStartOptions {
  codexHome?: string;
  configOverrides?: Record<string, string | boolean | number>;
}

export class AppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private state: AppServerState = "disconnected";
  private lastError: string | null = null;

  getStatus(): { state: AppServerState; error: string | null } {
    return { state: this.state, error: this.lastError };
  }

  start(options: AppServerStartOptions = {}): Promise<void> {
    if (this.state === "connected") return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    const pendingStart = this.connect(options);
    this.startPromise = pendingStart;
    void pendingStart.finally(() => {
      if (this.startPromise === pendingStart) this.startPromise = null;
    }).catch(() => undefined);
    return pendingStart;
  }

  private async connect(options: AppServerStartOptions): Promise<void> {
    this.setState("connecting");
    if (options.codexHome) mkdirSync(options.codexHome, { recursive: true });
    const executable = process.env.RHZYCODE_CODEX_PATH || "codex";
    const configArgs = Object.entries(options.configOverrides || {}).flatMap(([key, value]) => [
      "-c",
      `${key}=${toTomlValue(value)}`,
    ]);
    const child = spawn(executable, [...configArgs, "app-server", "--stdio"], {
      env: options.codexHome
        ? { ...process.env, CODEX_HOME: options.codexHome }
        : process.env,
      windowsHide: true,
    });
    this.child = child;

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => this.emit("diagnostic", chunk.toString()));
    child.once("error", (error) => this.handleExit(error));
    child.once("exit", (code) => {
      if (this.child === child) {
        this.handleExit(new Error(`Agent Host exited with code ${code ?? "unknown"}.`));
      }
    });

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "rhzycode_desktop",
          title: "RHZYCODE Desktop",
          version: "0.1.0",
        },
      });
      this.notify("initialized", {});
      this.setState("connected");
    } catch (error) {
      this.handleExit(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async request<T>(method: string, params: unknown, timeoutMs: number | null = 60_000): Promise<T> {
    if (!this.child) throw new Error("Agent Host is not running.");
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs == null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      timer?.unref();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ id, method, params });
    });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    child?.kill();
    this.rejectPending(new Error("Agent Host stopped."));
    this.setState("disconnected");
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: RpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error("Agent Host input is unavailable.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.emit("diagnostic", `Invalid App Server message: ${line}`);
      return;
    }

    if (typeof message.id === "number" && ("result" in message || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "App Server request failed."));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.emit("message", message);
  }

  private handleExit(error: Error): void {
    this.child?.kill();
    this.child = null;
    this.rejectPending(error);
    this.lastError = error.message;
    this.setState("error");
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private setState(state: AppServerState): void {
    this.state = state;
    if (state !== "error") this.lastError = null;
    this.emit("status", this.getStatus());
  }
}

function toTomlValue(value: string | boolean | number): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
