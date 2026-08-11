import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { agentEventSchema, controlSnapshotSchema, type AgentEvent } from "@rhzycode/protocol";
import type { ControlStore, ControlStoreState, PersistedCommandReplay } from "./control-plane/app";
import type { CredentialEncryption } from "./credential-store";

export type EncryptedLoadStatus = "missing" | "restored" | "partial" | "invalid" | "unavailable";

export interface DecodedEncryptedState<T> {
  state: T;
  partial?: boolean;
}

export interface PersistenceStatus {
  encryptionAvailable: boolean;
  controlState: EncryptedLoadStatus;
  mobileAccessState: EncryptedLoadStatus;
}

type StateDecoder<T> = (value: unknown) => DecodedEncryptedState<T> | null;

export class EncryptedControlPersistence {
  private store: ControlStore | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeReplay: (() => void) | null = null;
  private pendingWrite: NodeJS.Timeout | null = null;
  private writeInFlight: Promise<void> | null = null;
  private writeRequested = false;
  private loadStatus: EncryptedLoadStatus = "missing";

  constructor(
    private readonly filePath: string,
    private readonly encryption: CredentialEncryption,
  ) {}

  load(): ControlStoreState | null {
    if (!this.encryption.isAvailable()) {
      this.loadStatus = "unavailable";
      return null;
    }
    if (!fs.existsSync(this.filePath)) {
      this.loadStatus = "missing";
      return null;
    }
    try {
      const plaintext = this.encryption.decrypt(fs.readFileSync(this.filePath));
      const value = JSON.parse(plaintext) as { snapshot?: unknown; events?: unknown; commandReplays?: unknown };
      const snapshot = controlSnapshotSchema.safeParse(value.snapshot);
      const rawEvents = Array.isArray(value.events) ? value.events : [];
      const events = rawEvents.flatMap((event) => {
        const result = agentEventSchema.safeParse(event);
        return result.success ? [result.data] : [];
      });
      const rawCommandReplays = Array.isArray(value.commandReplays) ? value.commandReplays : [];
      const commandReplays = rawCommandReplays.filter(isPersistedCommandReplay);
      if (!snapshot.success) {
        this.loadStatus = "invalid";
        return null;
      }
      const discardedPending = snapshot.data.approvals.length > 0 || snapshot.data.userInputs.length > 0;
      const discardedEvents = !Array.isArray(value.events) || events.length !== rawEvents.length;
      const discardedReplays = value.commandReplays !== undefined
        && (!Array.isArray(value.commandReplays) || commandReplays.length !== rawCommandReplays.length);
      this.loadStatus = discardedPending || discardedEvents || discardedReplays ? "partial" : "restored";
      return { snapshot: snapshot.data, events, commandReplays };
    } catch {
      this.loadStatus = "invalid";
      return null;
    }
  }

  getLoadStatus(): EncryptedLoadStatus {
    return this.loadStatus;
  }

  attach(store: ControlStore): void {
    this.detach();
    this.store = store;
    this.unsubscribe = store.onEvent((event) => {
      if (shouldScheduleWrite(event)) this.scheduleWrite();
    });
    this.unsubscribeReplay = store.onCommandReplay(() => this.scheduleWrite());
  }

  flush(): Promise<void> {
    if (this.pendingWrite) clearTimeout(this.pendingWrite);
    this.pendingWrite = null;
    if (!this.store || !this.encryption.isAvailable()) return Promise.resolve();
    this.writeRequested = true;
    if (!this.writeInFlight) {
      this.writeInFlight = this.writePendingState().finally(() => {
        this.writeInFlight = null;
      });
    }
    return this.writeInFlight;
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeReplay?.();
    this.unsubscribeReplay = null;
    this.store = null;
    if (this.pendingWrite) clearTimeout(this.pendingWrite);
    this.pendingWrite = null;
  }

  private scheduleWrite(): void {
    if (this.pendingWrite) clearTimeout(this.pendingWrite);
    this.pendingWrite = setTimeout(() => {
      void this.flush().catch(() => undefined);
    }, 150);
    this.pendingWrite.unref();
  }

  private async writePendingState(): Promise<void> {
    while (this.writeRequested && this.store && this.encryption.isAvailable()) {
      this.writeRequested = false;
      const encrypted = this.encryption.encrypt(JSON.stringify(this.store.exportState()));
      const temporaryPath = `${this.filePath}.tmp`;
      await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsPromises.writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await fsPromises.rename(temporaryPath, this.filePath);
    }
  }
}

function isPersistedCommandReplay(value: unknown): value is PersistedCommandReplay {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PersistedCommandReplay>;
  return typeof entry.key === "string"
    && entry.key.length <= 500
    && typeof entry.fingerprint === "string"
    && entry.fingerprint.length <= 200
    && typeof entry.expiresAt === "number"
    && Number.isFinite(entry.expiresAt)
    && entry.expiresAt > Date.now()
    && (entry.clientMessageId === undefined
      || (typeof entry.clientMessageId === "string" && entry.clientMessageId.length <= 200))
    && Object.prototype.hasOwnProperty.call(entry, "result");
}

function shouldScheduleWrite(event: AgentEvent): boolean {
  return event.type !== "timeline.upserted"
    || (event.item.status !== "running" && event.item.status !== "pending");
}

export class EncryptedStateFile<T> {
  private loadStatus: EncryptedLoadStatus = "missing";

  constructor(
    private readonly filePath: string,
    private readonly encryption: CredentialEncryption,
    private readonly decoder?: StateDecoder<T>,
  ) {}

  load(): T | null {
    if (!this.encryption.isAvailable()) {
      this.loadStatus = "unavailable";
      return null;
    }
    if (!fs.existsSync(this.filePath)) {
      this.loadStatus = "missing";
      return null;
    }
    try {
      const parsed = JSON.parse(this.encryption.decrypt(fs.readFileSync(this.filePath))) as unknown;
      const decoded = this.decoder ? this.decoder(parsed) : { state: parsed as T };
      if (!decoded) {
        this.loadStatus = "invalid";
        return null;
      }
      this.loadStatus = decoded.partial ? "partial" : "restored";
      return decoded.state;
    } catch {
      this.loadStatus = "invalid";
      return null;
    }
  }

  getLoadStatus(): EncryptedLoadStatus {
    return this.loadStatus;
  }

  save(value: T): void {
    if (!this.encryption.isAvailable()) throw new Error("Encrypted state storage is unavailable.");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, this.encryption.encrypt(JSON.stringify(value)), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
