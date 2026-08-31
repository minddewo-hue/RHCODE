import type { ControlSnapshot } from "@rhzycode/protocol";
import { ControlClientError, type ControlClient } from "./control-client";

export const snapshotRequestTimeoutMs = 15_000;
export const webSocketConnectTimeoutMs = 15_000;
export const webSocketHeartbeatIntervalMs = 20_000;
export const webSocketHeartbeatTimeoutMs = 15_000;

export type AppConnectionAction = "none" | "pause" | "resume";

export function appConnectionAction(previous: string, next: string): AppConnectionAction {
  if (previous === next) return "none";
  if (next === "active") return "resume";
  return previous === "active" ? "pause" : "none";
}

export type IncomingSequenceAction = "apply" | "duplicate" | "gap";

export function incomingSequenceAction(current: number, incoming: number): IncomingSequenceAction {
  if (incoming <= current) return "duplicate";
  return incoming === current + 1 ? "apply" : "gap";
}

interface SnapshotRetryOptions {
  attempts?: number;
  retryDelay?: (attempt: number) => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface CommandRetryOptions {
  attempts?: number;
  retryDelay?: (attempt: number) => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function getSnapshotWithRetry(
  client: Pick<ControlClient, "getSnapshot">,
  options: SnapshotRetryOptions = {},
): Promise<ControlSnapshot> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const retryDelay = options.retryDelay || snapshotRetryDelay;
  const sleep = options.sleep || wait;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await client.getSnapshot(snapshotRequestTimeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1 || !isRetryableConnectionError(error)) throw error;
      await sleep(retryDelay(attempt));
    }
  }

  throw lastError;
}

export async function runControlCommandWithRetry<T>(
  operation: () => Promise<T>,
  options: CommandRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const retryDelay = options.retryDelay || ((attempt) => 800 * (attempt + 1));
  const sleep = options.sleep || wait;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1 || !isRetryableConnectionError(error)) throw error;
      await sleep(retryDelay(attempt));
    }
  }

  throw lastError;
}

export function reconnectDelay(attempt: number, random = Math.random): number {
  const base = Math.min(10_000, 1_000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + random() * 0.4));
}

export function heartbeatPingFrame(id: string): string {
  return JSON.stringify({ type: "control.ping", id });
}

export function heartbeatPongId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as { type?: unknown; id?: unknown };
    return parsed.type === "control.pong" && typeof parsed.id === "string" && parsed.id.length <= 100
      ? parsed.id
      : null;
  } catch {
    return null;
  }
}

function snapshotRetryDelay(attempt: number): number {
  return attempt === 0 ? 300 : 900;
}

export function isRetryableConnectionError(error: unknown): boolean {
  return error instanceof ControlClientError
    && ["offline", "timeout", "server", "invalid_response"].includes(error.code);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
