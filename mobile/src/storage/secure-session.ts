export const secureSessionKeys = {
  connections: "rhzycode.connections.v2",
  activeConnectionId: "rhzycode.activeConnectionId.v2",
} as const;

const connectionKeyPrefix = "rhzycode.connectionKey.v2.";
const navigationKeyPrefix = "rhzycode.navigation.v1.";

export interface SecureStorageAdapter {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface MobileSession {
  id: string;
  accessKey: string;
}

export interface MobileSessionState {
  connections: MobileSession[];
  activeConnectionId: string | null;
}

export interface MobileNavigationState {
  projectPath: string | null;
  threadId: string | null;
  newThreadDraft: boolean;
  collapsedProjectPaths: string[];
}

export interface SavedConnectionInput {
  id?: string;
  accessKey: string;
}

interface StoredConnection {
  id: string;
}

export function secureConnectionKey(id: string): string {
  return `${connectionKeyPrefix}${id}`;
}

export function mobileNavigationKey(id: string): string {
  return `${navigationKeyPrefix}${id}`;
}

export class SecureSessionStore {
  constructor(private readonly storage: SecureStorageAdapter) {}

  async load(): Promise<MobileSessionState> {
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
        id: connection.id,
        accessKey: accessKeys[index] || "",
      }));
      return {
        connections: sessions,
        activeConnectionId: sessions.some((session) => session.id === storedActiveId)
          ? storedActiveId
          : sessions[0]?.id || null,
      };
    }

    return { connections: [], activeConnectionId: null };
  }

  async saveConnection(input: SavedConnectionInput): Promise<MobileSessionState> {
    const current = await this.load();
    const matching = input.id
      ? current.connections.find((connection) => connection.id === input.id)
      : current.connections.find((connection) => connection.accessKey === input.accessKey);
    const id = matching?.id || createConnectionId();
    const connection: MobileSession = { id, accessKey: input.accessKey };
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

  async loadNavigation(id: string): Promise<MobileNavigationState> {
    const value = await this.storage.getItemAsync(mobileNavigationKey(id));
    if (!value) return emptyNavigationState();
    try {
      const parsed = JSON.parse(value) as Partial<MobileNavigationState>;
      return {
        projectPath: typeof parsed.projectPath === "string" ? parsed.projectPath : null,
        threadId: typeof parsed.threadId === "string" ? parsed.threadId : null,
        newThreadDraft: parsed.newThreadDraft === true,
        collapsedProjectPaths: normalizeStoredPaths(parsed.collapsedProjectPaths),
      };
    } catch {
      return emptyNavigationState();
    }
  }

  async saveNavigation(id: string, state: MobileNavigationState): Promise<void> {
    await this.storage.setItemAsync(mobileNavigationKey(id), JSON.stringify(state));
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
      this.storage.deleteItemAsync(mobileNavigationKey(id)),
      activeConnectionId
        ? this.storage.setItemAsync(secureSessionKeys.activeConnectionId, activeConnectionId)
        : this.storage.deleteItemAsync(secureSessionKeys.activeConnectionId),
    ]);
    return { connections, activeConnectionId };
  }

  private async writeConnectionMetadata(connections: MobileSession[]): Promise<void> {
    const metadata: StoredConnection[] = connections.map(({ id }) => ({ id }));
    await this.storage.setItemAsync(secureSessionKeys.connections, JSON.stringify(metadata));
  }
}

function emptyNavigationState(): MobileNavigationState {
  return { projectPath: null, threadId: null, newThreadDraft: false, collapsedProjectPaths: [] };
}

function normalizeStoredPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0))]
    .slice(0, 50);
}

function parseConnections(value: string | null): StoredConnection[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const ids = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as Record<string, unknown>;
      if (Object.keys(candidate).length !== 1 || typeof candidate.id !== "string" || !candidate.id) continue;
      ids.add(candidate.id);
    }
    return [...ids].map((id) => ({ id }));
  } catch {
    return [];
  }
}

function createConnectionId(): string {
  return `computer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
