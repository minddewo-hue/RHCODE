import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";

export interface MobileAccessKey {
  key: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface MobileClientIdentity {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface MobileAccessAuditEntry {
  id: string;
  clientId: string;
  action:
    | "approval.resolved"
    | "project.created"
    | "task.thread_started"
    | "task.turn_started"
    | "task.turn_interrupted"
    | "task.user_input_submitted"
    | "task.thread_renamed"
    | "task.thread_archived"
    | "task.thread_unarchived"
    | "task.thread_deleted";
  detail: string;
  createdAt: string;
}

export interface MobileAccessState {
  accessKey?: MobileAccessKey;
  audit: MobileAccessAuditEntry[];
}

export interface NormalizedMobileAccessState {
  state: MobileAccessState;
  discardedInvalidRecords: boolean;
}

const maxAuditEntries = 500;
export const mobileAccessClientId = "desktop-mobile-access-key";

export class MobileAccessManager extends EventEmitter {
  private accessKey: MobileAccessKey | null = null;
  private audit: MobileAccessAuditEntry[] = [];

  constructor(
    state?: MobileAccessState | null,
    private readonly saveState?: (state: MobileAccessState) => void,
  ) {
    super();
    const restored = state ? normalizeMobileAccessState(state)?.state : null;
    this.accessKey = restored?.accessKey ? { ...restored.accessKey } : null;
    this.audit = (restored?.audit || []).slice(-maxAuditEntries);
  }

  status() {
    return {
      accessKey: this.accessKey ? { ...this.accessKey } : null,
      audit: [...this.audit].reverse(),
    };
  }

  rotateAccessKey(): MobileAccessKey {
    const previous = this.accessKey;
    const next: MobileAccessKey = {
      key: `rhzy_${randomBytes(32).toString("base64url")}`,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.accessKey = next;
    try {
      this.persist();
    } catch (error) {
      this.accessKey = previous;
      throw error;
    }
    if (previous) this.emit("access:revoked", mobileAccessClientId);
    this.emit("status", this.status());
    return { ...next };
  }

  authenticate(key: string): MobileClientIdentity | null {
    if (!this.accessKey || !safeEqual(hashKey(this.accessKey.key), hashKey(key))) return null;
    if (
      !this.accessKey.lastUsedAt
      || Date.now() - new Date(this.accessKey.lastUsedAt).getTime() > 60_000
    ) {
      this.accessKey.lastUsedAt = new Date().toISOString();
      this.persist();
    }
    return {
      id: mobileAccessClientId,
      name: "RHZYCODE Mobile",
      createdAt: this.accessKey.createdAt,
      lastSeenAt: this.accessKey.lastUsedAt || this.accessKey.createdAt,
    };
  }

  recordApproval(clientId: string, approvalId: string): void {
    this.record(clientId, "approval.resolved", approvalId);
    this.persistAndPublish();
  }

  recordProjectCreated(clientId: string): void {
    this.record(clientId, "project.created", "project");
    this.persistAndPublish();
  }

  recordTaskCommand(
    clientId: string,
    action: Extract<MobileAccessAuditEntry["action"], `task.${string}`>,
    targetId: string,
  ): void {
    this.record(clientId, action, targetId);
    this.persistAndPublish();
  }

  exportState(): MobileAccessState {
    return {
      ...(this.accessKey ? { accessKey: { ...this.accessKey } } : {}),
      audit: [...this.audit],
    };
  }

  private record(
    clientId: string,
    action: MobileAccessAuditEntry["action"],
    detail: string,
  ): void {
    this.audit.push({
      id: randomUUID(),
      clientId,
      action,
      detail,
      createdAt: new Date().toISOString(),
    });
    if (this.audit.length > maxAuditEntries) this.audit.splice(0, this.audit.length - maxAuditEntries);
  }

  private persistAndPublish(): void {
    this.persist();
    this.emit("status", this.status());
  }

  private persist(): void {
    this.saveState?.(this.exportState());
  }
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function restoreAccessKey(value: unknown): MobileAccessKey | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.key !== "string"
    || !/^rhzy_[A-Za-z0-9_-]{43}$/.test(input.key)
    || !validDate(input.createdAt)
    || !(input.lastUsedAt === null || validDate(input.lastUsedAt))
  ) return null;
  return {
    key: input.key,
    createdAt: input.createdAt,
    lastUsedAt: input.lastUsedAt,
  };
}

function restoreAuditEntry(value: unknown): MobileAccessAuditEntry | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (
    !validText(input.id, 200)
    || !validText(input.clientId, 200)
    || !validText(input.detail, 500)
    || !validDate(input.createdAt)
    || !isAuditAction(input.action)
  ) return null;
  return {
    id: input.id,
    clientId: input.clientId,
    action: input.action,
    detail: input.detail,
    createdAt: input.createdAt,
  };
}

function isAuditAction(value: unknown): value is MobileAccessAuditEntry["action"] {
  return value === "approval.resolved"
    || value === "project.created"
    || value === "task.thread_started"
    || value === "task.turn_started"
    || value === "task.turn_interrupted"
    || value === "task.user_input_submitted"
    || value === "task.thread_renamed"
    || value === "task.thread_archived"
    || value === "task.thread_unarchived"
    || value === "task.thread_deleted";
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function normalizeMobileAccessState(value: unknown): NormalizedMobileAccessState | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.audit)) return null;
  const accessKey = input.accessKey === undefined ? null : restoreAccessKey(input.accessKey);
  const audit = input.audit.flatMap((candidate) => {
    const entry = restoreAuditEntry(candidate);
    return entry ? [entry] : [];
  }).slice(-maxAuditEntries);
  return {
    state: {
      ...(accessKey ? { accessKey } : {}),
      audit,
    },
    discardedInvalidRecords:
      (input.accessKey !== undefined && !accessKey)
      || audit.length !== input.audit.length,
  };
}
