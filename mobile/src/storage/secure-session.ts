import { defaultControlHost, defaultControlPort } from "../auth/control-access";

export const secureSessionKeys = {
  connections: "rhzycode.connections.v2",
  activeConnectionId: "rhzycode.activeConnectionId.v2",
  legacyHost: "rhzycode.controlHost",
  legacyPort: "rhzycode.controlPort",
  legacyAccessKey: "rhzycode.accessKey",
} as const;

const connectionKeyPrefix = "rhzycode.connectionKey.v2.";

export interface SecureStorageAdapter {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface MobileSession {
  id: string;
  host: string;
  port: number;
  accessKey: string;
}

export interface MobileSessionState {
  connections: MobileSession[];
  activeConnectionId: string | null;
}

export interface SavedConnectionInput {
  id?: string;
  host: string;
  port: number;
  accessKey: string;
}

interface StoredConnection {
  id: string;
  host: string;
  port: number;
}

export function secureConnectionKey(id: string): string {
  return `${connectionKeyPrefix}${id}`;
}

export class SecureSessionStore {
  constructor(private readonly storage: SecureStorageAdapter) {}

  async load(
    fallbackHost = defaultControlHost,
    fallbackPort = defaultControlPort,
  ): Promise<MobileSessionState> {
    const [storedConnections, storedActiveId] = await Promise.all([
      this.storage.getItemAsync(secureSessionKeys.connections),
      this.storage.getItemAsync(secureSessionKeys.activeConnectionId),
    ]);
    const connections = parseConnections(storedConnections);
    if (connections.length) {
      const accessKeys = await Promise.all(connections.map((connection) => (
        this.storage.getItemAsync(secureConnectionKey(connection.id))
      )));
      const sessions = connections.map((connection, index) => ({
        ...connection,
        accessKey: accessKeys[index] || "",
      }));
      return {
        connections: sessions,
        activeConnectionId: sessions.some((session) => session.id === storedActiveId)
          ? storedActiveId
          : sessions[0]?.id || null,
      };
    }

    if (storedConnections !== null) return { connections: [], activeConnectionId: null };
    return this.migrateLegacyConnection(fallbackHost, fallbackPort);
  }

  async saveConnection(input: SavedConnectionInput): Promise<MobileSessionState> {
    const current = await this.load();
    const matching = input.id
      ? current.connections.find((connection) => connection.id === input.id)
      : current.connections.find((connection) => connection.host === input.host && connection.port === input.port);
    const id = matching?.id || createConnectionId();
    const connection: MobileSession = {
      id,
      host: input.host,
      port: input.port,
      accessKey: input.accessKey,
    };
    const connections = matching
      ? current.connections.map((item) => item.id === id ? connection : item)
      : [...current.connections, connection];
    await Promise.all([
      this.writeConnectionMetadata(connections),
      this.storage.setItemAsync(secureConnectionKey(id), input.accessKey),
      this.storage.setItemAsync(secureSessionKeys.activeConnectionId, id),
    ]);
    return { connections, activeConnectionId: id };
  }

  async setActiveConnection(id: string): Promise<void> {
    const current = await this.load();
    if (!current.connections.some((connection) => connection.id === id)) {
      throw new Error("Cannot activate an unknown computer connection.");
    }
    await this.storage.setItemAsync(secureSessionKeys.activeConnectionId, id);
  }

  async clearAccessKey(id: string): Promise<MobileSessionState> {
    const current = await this.load();
    await this.storage.deleteItemAsync(secureConnectionKey(id));
    return {
      ...current,
      connections: current.connections.map((connection) => (
        connection.id === id ? { ...connection, accessKey: "" } : connection
      )),
    };
  }

  async removeConnection(id: string): Promise<MobileSessionState> {
    const current = await this.load();
    const connections = current.connections.filter((connection) => connection.id !== id);
    const activeConnectionId = current.activeConnectionId === id
      ? connections[0]?.id || null
      : current.activeConnectionId;
    await Promise.all([
      this.writeConnectionMetadata(connections),
      this.storage.deleteItemAsync(secureConnectionKey(id)),
      activeConnectionId
        ? this.storage.setItemAsync(secureSessionKeys.activeConnectionId, activeConnectionId)
        : this.storage.deleteItemAsync(secureSessionKeys.activeConnectionId),
    ]);
    return { connections, activeConnectionId };
  }

  private async migrateLegacyConnection(
    fallbackHost: string,
    fallbackPort: number,
  ): Promise<MobileSessionState> {
    const [storedHost, storedPort, accessKey] = await Promise.all([
      this.storage.getItemAsync(secureSessionKeys.legacyHost),
      this.storage.getItemAsync(secureSessionKeys.legacyPort),
      this.storage.getItemAsync(secureSessionKeys.legacyAccessKey),
    ]);
    if (!storedHost && !storedPort && !accessKey) {
      return { connections: [], activeConnectionId: null };
    }
    const parsedPort = Number(storedPort);
    const connection: MobileSession = {
      id: createConnectionId(),
      host: storedHost || fallbackHost,
      port: Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65_535
        ? parsedPort
        : fallbackPort,
      accessKey: accessKey || "",
    };
    await Promise.all([
      this.writeConnectionMetadata([connection]),
      this.storage.setItemAsync(secureSessionKeys.activeConnectionId, connection.id),
      connection.accessKey
        ? this.storage.setItemAsync(secureConnectionKey(connection.id), connection.accessKey)
        : Promise.resolve(),
      this.storage.deleteItemAsync(secureSessionKeys.legacyHost),
      this.storage.deleteItemAsync(secureSessionKeys.legacyPort),
      this.storage.deleteItemAsync(secureSessionKeys.legacyAccessKey),
    ]);
    return { connections: [connection], activeConnectionId: connection.id };
  }

  private async writeConnectionMetadata(connections: MobileSession[]): Promise<void> {
    const metadata: StoredConnection[] = connections.map(({ id, host, port }) => ({ id, host, port }));
    await this.storage.setItemAsync(secureSessionKeys.connections, JSON.stringify(metadata));
  }
}

function parseConnections(value: string | null): StoredConnection[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StoredConnection => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<StoredConnection>;
      return typeof candidate.id === "string"
        && candidate.id.length > 0
        && typeof candidate.host === "string"
        && candidate.host.length > 0
        && Number.isInteger(candidate.port)
        && Number(candidate.port) >= 1
        && Number(candidate.port) <= 65_535;
    });
  } catch {
    return [];
  }
}

function createConnectionId(): string {
  return `computer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
