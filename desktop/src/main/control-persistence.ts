import fs from "node:fs";
import path from "node:path";
import { agentEventSchema, controlSnapshotSchema } from "@rhzycode/protocol";
import type { ControlStore, ControlStoreState } from "@rhzycode/control-plane";
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
  private pendingWrite: NodeJS.Timeout | null = null;
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
      const value = JSON.parse(plaintext) as { snapshot?: unknown; events?: unknown };
      const snapshot = controlSnapshotSchema.safeParse(value.snapshot);
      const rawEvents = Array.isArray(value.events) ? value.events : [];
      const events = rawEvents.flatMap((event) => {
        const result = agentEventSchema.safeParse(event);
        return result.success ? [result.data] : [];
      });
      if (!snapshot.success) {
        this.loadStatus = "invalid";
        return null;
      }
      const discardedPending = snapshot.data.approvals.length > 0 || snapshot.data.userInputs.length > 0;
      const discardedEvents = !Array.isArray(value.events) || events.length !== rawEvents.length;
      this.loadStatus = discardedPending || discardedEvents ? "partial" : "restored";
      return { snapshot: snapshot.data, events };
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
    this.unsubscribe = store.onEvent(() => this.scheduleWrite());
  }

  flush(): void {
    if (this.pendingWrite) clearTimeout(this.pendingWrite);
    this.pendingWrite = null;
    if (!this.store || !this.encryption.isAvailable()) return;
    const encrypted = this.encryption.encrypt(JSON.stringify(this.store.exportState()));
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, encrypted, { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.store = null;
    if (this.pendingWrite) clearTimeout(this.pendingWrite);
    this.pendingWrite = null;
  }

  private scheduleWrite(): void {
    if (this.pendingWrite) clearTimeout(this.pendingWrite);
    this.pendingWrite = setTimeout(() => this.flush(), 150);
    this.pendingWrite.unref();
  }
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
