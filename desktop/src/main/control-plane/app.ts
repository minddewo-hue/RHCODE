import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  agentEventSchema,
  hostSummarySchema,
  remoteModelListResultSchema,
  remoteArchivedThreadListRequestSchema,
  remoteArchivedThreadListResultSchema,
  remoteProjectCreateRequestSchema,
  remoteProjectCreateResultSchema,
  remoteProjectForgetRequestSchema,
  remoteProjectListResultSchema,
  remoteDirectoryBrowseRequestSchema,
  remoteDirectoryBrowseResultSchema,
  remoteThreadStartRequestSchema,
  remoteThreadStartResultSchema,
  remoteThreadOpenResultSchema,
  remoteThreadMutationResultSchema,
  remoteThreadModelRequestSchema,
  remoteThreadRenameRequestSchema,
  remoteTurnInterruptResultSchema,
  remoteTurnStartRequestSchema,
  remoteTurnStartResultSchema,
  remoteUserInputSubmitRequestSchema,
  remoteUserInputSubmitResultSchema,
  threadSummarySchema,
  type RemoteArchivedThreadListRequest,
  type RemoteArchivedThreadListResult,
  type RemoteModelListResult,
  type RemoteProjectCreateRequest,
  type RemoteProjectCreateResult,
  type RemoteProjectForgetRequest,
  type RemoteProjectListResult,
  type RemoteDirectoryBrowseRequest,
  type RemoteDirectoryBrowseResult,
  type RemoteThreadMutationResult,
  type RemoteThreadOpenResult,
  type RemoteThreadModelRequest,
  type RemoteThreadRenameRequest,
  type RemoteThreadStartRequest,
  type RemoteThreadStartResult,
  type RemoteTurnInterruptResult,
  type RemoteTurnStartRequest,
  type RemoteTurnStartResult,
  type RemoteUserInputSubmitRequest,
  type RemoteUserInputSubmitResult,
} from "@rhzycode/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import { z } from "zod";
import { readGeneratedImageFile } from "../generated-image-store.js";
import type { ManagedFileStore } from "../managed-file-store.js";
import { ControlStore, type AgentEventInput } from "./store.js";
import { MobileAccessManager, type MobileClientIdentity } from "./mobile-access.js";

export interface ControlPlaneOptions {
  store?: ControlStore;
  logLevel?: string;
  mobileAccess?: MobileAccessManager;
  commands?: ControlCommandHandlers;
  generatedImageDirectory?: string;
  managedFiles?: Pick<ManagedFileStore, "read">;
  tls?: HttpsServerOptions;
}

export interface RemoteCommandContext {
  client: MobileClientIdentity;
}

export interface ControlCommandHandlers {
  listModels?(context: RemoteCommandContext): Promise<RemoteModelListResult>;
  listProjects?(context: RemoteCommandContext): Promise<RemoteProjectListResult>;
  browseProjects?(
    request: RemoteDirectoryBrowseRequest,
    context: RemoteCommandContext,
  ): Promise<RemoteDirectoryBrowseResult>;
  createProject?(
    request: RemoteProjectCreateRequest,
    context: RemoteCommandContext,
  ): Promise<RemoteProjectCreateResult>;
  forgetProject?(
    request: RemoteProjectForgetRequest,
    context: RemoteCommandContext,
  ): Promise<RemoteProjectListResult>;
  listArchivedThreads(
    request: RemoteArchivedThreadListRequest,
    context: RemoteCommandContext,
  ): Promise<RemoteArchivedThreadListResult>;
  startThread(
    request: RemoteThreadStartRequest,
    context: RemoteCommandContext,
  ): Promise<RemoteThreadStartResult>;
  openThread(
    threadId: string,
    context: RemoteCommandContext,
  ): Promise<RemoteThreadOpenResult>;
  startTurn(
    threadId: string,
    request: RemoteTurnStartRequest,
    context: RemoteCommandContext,
  ): Promise<RemoteTurnStartResult>;
  interruptTurn(
    threadId: string,
    context: RemoteCommandContext,
  ): Promise<RemoteTurnInterruptResult>;
  submitUserInput(
    requestId: string,
    request: RemoteUserInputSubmitRequest,
    context: RemoteCommandContext,
  ): Promise<RemoteUserInputSubmitResult>;
  setThreadModel?(
    threadId: string,
    request: RemoteThreadModelRequest,
    context: RemoteCommandContext,
  ): Promise<RemoteThreadMutationResult>;
  renameThread(
    threadId: string,
    request: RemoteThreadRenameRequest,
    context: RemoteCommandContext,
  ): Promise<RemoteThreadMutationResult>;
  archiveThread(
    threadId: string,
    context: RemoteCommandContext,
  ): Promise<RemoteThreadMutationResult>;
  unarchiveThread(
    threadId: string,
    context: RemoteCommandContext,
  ): Promise<RemoteThreadMutationResult>;
  deleteThread(
    threadId: string,
    context: RemoteCommandContext,
  ): Promise<RemoteThreadMutationResult>;
}

export type ControlCommandErrorCode = "invalid" | "not_found" | "conflict" | "unavailable";

export class ControlCommandError extends Error {
  constructor(readonly code: ControlCommandErrorCode) {
    super(code);
    this.name = "ControlCommandError";
  }
}

export interface ControlPlaneHandle {
  app: FastifyInstance;
  store: ControlStore;
  start(options?: { host?: string; port?: number }): Promise<{ host: string; port: number; url: string }>;
  stop(): Promise<void>;
}

interface TrackedSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  on(event: "close" | "error", listener: () => void): unknown;
}

interface CachedCommand {
  fingerprint: string;
  expiresAt: number;
  promise: Promise<unknown>;
}

class CommandReplayCache {
  private readonly entries = new Map<string, CachedCommand>();

  async execute<T>(
    clientId: string,
    idempotencyKey: string,
    fingerprint: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.prune();
    const cacheKey = `${clientId}:${idempotencyKey}`;
    const existing = this.entries.get(cacheKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ControlCommandError("conflict");
      return existing.promise as Promise<T>;
    }

    const promise = operation();
    this.entries.set(cacheKey, {
      fingerprint,
      expiresAt: Date.now() + 10 * 60_000,
      promise,
    });
    try {
      return await promise;
    } catch (error) {
      this.entries.delete(cacheKey);
      throw error;
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= 500) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

export async function createControlPlane(options: ControlPlaneOptions = {}): Promise<ControlPlaneHandle> {
  const app = (options.tls
    ? Fastify({ logger: { level: options.logLevel || "info" }, https: options.tls, bodyLimit: 36 * 1024 * 1024 })
    : Fastify({ logger: { level: options.logLevel || "info" }, bodyLimit: 36 * 1024 * 1024 })) as unknown as FastifyInstance;
  const store = options.store || new ControlStore();
  const mobileAccess = options.mobileAccess;
  const commands = options.commands;
  const commandReplay = new CommandReplayCache();
  const sockets = new Map<TrackedSocket, string | null>();

  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.addHook("onRequest", async (request, reply) => {
    if (!mobileAccess || request.method === "OPTIONS" || request.url === "/health") return;
    const key = extractAccessKey(request.headers.authorization, request.headers["sec-websocket-protocol"]);
    const client = key ? mobileAccess.authenticate(key) : null;
    if (!client) return reply.code(401).send({ error: "Missing or invalid mobile access key." });
    (request as typeof request & { mobileClient?: MobileClientIdentity }).mobileClient = client;
  });

  app.get("/health", async () => ({
    ok: true,
    service: "rhzycode-control-plane",
    time: new Date().toISOString(),
  }));

  app.get("/v1/snapshot", async () => store.snapshot());

  app.get("/v1/generated-images/:id", async (request, reply) => {
    if (!mobileAccess || !options.generatedImageDirectory) {
      return reply.code(404).send({ error: "Generated image access is not enabled." });
    }
    const params = z.object({ id: z.string().min(1).max(240) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid generated image identifier." });
    const image = readGeneratedImageFile(options.generatedImageDirectory, params.data.id);
    if (!image) return reply.code(404).send({ error: "Generated image not found." });
    return reply
      .header("Content-Type", image.mimeType)
      .header("Content-Length", String(image.bytes.byteLength))
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .send(image.bytes);
  });

  app.get("/v1/files/:id", async (request, reply) => {
    if (!mobileAccess || !options.managedFiles) {
      return reply.code(404).send({ error: "Managed file access is not enabled." });
    }
    const params = z.object({ id: z.string().min(1).max(240) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid file identifier." });
    const file = options.managedFiles.read(params.data.id);
    if (!file) return reply.code(404).send({ error: "File not found." });
    return reply
      .header("Content-Type", file.mimeType)
      .header("Content-Length", String(file.bytes.byteLength))
      .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .header("Cache-Control", "private, no-store")
      .send(file.bytes);
  });

  app.post("/v1/hosts", async (request, reply) => {
    if (mobileAccess) return reply.code(403).send({ error: "Mobile clients cannot publish host state." });
    const result = hostSummarySchema.safeParse(request.body);
    if (!result.success) return reply.code(400).send({ error: result.error.flatten() });
    return reply.code(202).send(store.upsertHost(result.data));
  });

  app.post("/v1/threads", async (request, reply) => {
    if (mobileAccess) return reply.code(403).send({ error: "Mobile clients cannot publish thread state." });
    const result = threadSummarySchema.safeParse(request.body);
    if (!result.success) return reply.code(400).send({ error: result.error.flatten() });
    return reply.code(202).send(store.upsertThread(result.data));
  });

  app.post("/v1/events", async (request, reply) => {
    if (mobileAccess) return reply.code(403).send({ error: "Mobile clients cannot publish agent events." });
    const result = agentEventSchema.safeParse({
      ...(request.body as Record<string, unknown>),
      sequence: 0,
    });
    if (!result.success) return reply.code(400).send({ error: result.error.flatten() });
    const { sequence: _ignored, ...input } = result.data;
    return reply.code(202).send(store.publish(input as AgentEventInput));
  });

  app.post("/v1/approvals/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = z.object({ decision: z.enum(["approved", "declined"]) }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid approval decision." });
    }
    const event = store.resolveApproval(params.data.id, body.data.decision);
    if (!event) return reply.code(404).send({ error: "Approval not found." });
    const client = (request as typeof request & { mobileClient?: MobileClientIdentity }).mobileClient;
    if (mobileAccess && client) mobileAccess.recordApproval(client.id, params.data.id);
    return event;
  });

  app.get("/v1/commands/threads/archived", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote task control is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands) return reply.code(503).send({ error: "Desktop task control is unavailable." });
    const query = remoteArchivedThreadListRequestSchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Invalid archived thread query." });
    }
    try {
      const result = await commands.listArchivedThreads(query.data, { client });
      return remoteArchivedThreadListResultSchema.parse(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.get("/v1/commands/projects", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote project access is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands?.listProjects) return reply.code(503).send({ error: "Desktop project access is unavailable." });
    try {
      const result = await commands.listProjects({ client });
      return remoteProjectListResultSchema.parse(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.get("/v1/commands/projects/browse", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote project access is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands?.browseProjects) return reply.code(503).send({ error: "Desktop directory browsing is unavailable." });
    const query = remoteDirectoryBrowseRequestSchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid directory path." });
    try {
      return remoteDirectoryBrowseResultSchema.parse(await commands.browseProjects(query.data, { client }));
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.get("/v1/commands/models", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote model access is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands?.listModels) return reply.code(503).send({ error: "Desktop model access is unavailable." });
    try {
      const result = await commands.listModels({ client });
      return remoteModelListResultSchema.parse(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.post("/v1/commands/projects", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote project access is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands?.createProject) return reply.code(503).send({ error: "Desktop project access is unavailable." });
    const body = remoteProjectCreateRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid remote project request." });
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (!idempotencyKey) return reply.code(400).send({ error: "A valid Idempotency-Key is required." });
    try {
      const result = await commandReplay.execute(
        client.id,
        idempotencyKey,
        commandFingerprint("project.create", body.data),
        async () => {
          const rawResult = await commands.createProject!(body.data, { client });
          const parsed = remoteProjectCreateResultSchema.parse(rawResult);
          mobileAccess.recordProjectCreated(client.id);
          return parsed;
        },
      );
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.delete("/v1/commands/projects", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote project access is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands?.forgetProject) return reply.code(503).send({ error: "Desktop project access is unavailable." });
    const body = remoteProjectForgetRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid remote project removal request." });
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (!idempotencyKey) return reply.code(400).send({ error: "A valid Idempotency-Key is required." });
    try {
      const result = await commandReplay.execute(
        client.id,
        idempotencyKey,
        commandFingerprint("project.forget", body.data),
        async () => {
          const parsed = remoteProjectListResultSchema.parse(
            await commands.forgetProject!(body.data, { client }),
          );
          mobileAccess.recordProjectRemoved(client.id);
          return parsed;
        },
      );
      return reply.code(200).send(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.post("/v1/commands/user-inputs/:requestId/submit", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote task control is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands) return reply.code(503).send({ error: "Desktop task control is unavailable." });
    const params = z.object({ requestId: z.string().min(1).max(500) }).safeParse(request.params);
    const body = remoteUserInputSubmitRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid remote user input response." });
    }
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (!idempotencyKey) return reply.code(400).send({ error: "A valid Idempotency-Key is required." });
    try {
      const result = await commandReplay.execute(
        client.id,
        idempotencyKey,
        commandFingerprint("user-input.submit", { requestId: params.data.requestId, ...body.data }),
        async () => {
          const rawResult = await commands.submitUserInput(
            params.data.requestId,
            body.data,
            { client },
          );
          const parsed = remoteUserInputSubmitResultSchema.parse(rawResult);
          mobileAccess.recordTaskCommand(client.id, "task.user_input_submitted", parsed.requestId);
          return parsed;
        },
      );
      return reply.code(202).send(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.post("/v1/commands/threads/start", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote task control is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands) return reply.code(503).send({ error: "Desktop task control is unavailable." });
    const body = remoteThreadStartRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid remote thread request." });
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (!idempotencyKey) return reply.code(400).send({ error: "A valid Idempotency-Key is required." });
    try {
      const result = await commandReplay.execute(
        client.id,
        idempotencyKey,
        commandFingerprint("thread.start", body.data),
        async () => {
          const rawResult = await commands.startThread(body.data, { client });
          const parsed = remoteThreadStartResultSchema.parse(rawResult);
          mobileAccess.recordTaskCommand(client.id, "task.thread_started", parsed.threadId);
          return parsed;
        },
      );
      return reply.code(201).send(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.get("/v1/commands/threads/:threadId", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote task control is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands) return reply.code(503).send({ error: "Desktop task control is unavailable." });
    const params = z.object({ threadId: z.string().min(1).max(500) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid remote thread open request." });
    }
    try {
      const result = remoteThreadOpenResultSchema.parse(
        await commands.openThread(params.data.threadId, { client }),
      );
      return reply.send(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.post("/v1/commands/threads/:threadId/turns/start", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote task control is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands) return reply.code(503).send({ error: "Desktop task control is unavailable." });
    const params = z.object({ threadId: z.string().min(1).max(500) }).safeParse(request.params);
    const body = remoteTurnStartRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid remote turn request." });
    }
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (!idempotencyKey) return reply.code(400).send({ error: "A valid Idempotency-Key is required." });
    try {
      const result = await commandReplay.execute(
        client.id,
        idempotencyKey,
        commandFingerprint("turn.start", { threadId: params.data.threadId, ...body.data }),
        async () => {
          const rawResult = await commands.startTurn(params.data.threadId, body.data, { client });
          const parsed = remoteTurnStartResultSchema.parse(rawResult);
          mobileAccess.recordTaskCommand(
            client.id,
            "task.turn_started",
            parsed.turnId || parsed.threadId,
          );
          return parsed;
        },
      );
      return reply.code(202).send(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.post("/v1/commands/threads/:threadId/turns/interrupt", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote task control is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands) return reply.code(503).send({ error: "Desktop task control is unavailable." });
    const params = z.object({ threadId: z.string().min(1).max(500) }).safeParse(request.params);
    const body = z.object({}).strict().safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid remote interrupt request." });
    }
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (!idempotencyKey) return reply.code(400).send({ error: "A valid Idempotency-Key is required." });
    try {
      const result = await commandReplay.execute(
        client.id,
        idempotencyKey,
        commandFingerprint("turn.interrupt", { threadId: params.data.threadId }),
        async () => {
          const rawResult = await commands.interruptTurn(params.data.threadId, { client });
          const parsed = remoteTurnInterruptResultSchema.parse(rawResult);
          mobileAccess.recordTaskCommand(client.id, "task.turn_interrupted", parsed.threadId);
          return parsed;
        },
      );
      return reply.code(202).send(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.post("/v1/commands/threads/:threadId/model", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote task control is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    const setThreadModel = commands?.setThreadModel;
    if (!setThreadModel) return reply.code(503).send({ error: "Desktop task control is unavailable." });
    const params = z.object({ threadId: z.string().min(1).max(500) }).safeParse(request.params);
    const body = remoteThreadModelRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid remote thread model request." });
    }
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (!idempotencyKey) return reply.code(400).send({ error: "A valid Idempotency-Key is required." });
    try {
      const result = await commandReplay.execute(
        client.id,
        idempotencyKey,
        commandFingerprint("thread.model", { threadId: params.data.threadId, ...body.data }),
        async () => {
          const rawResult = await setThreadModel(params.data.threadId, body.data, { client });
          const parsed = remoteThreadMutationResultSchema.parse(rawResult);
          mobileAccess.recordTaskCommand(client.id, "task.thread_model_changed", parsed.threadId);
          return parsed;
        },
      );
      return reply.send(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.post("/v1/commands/threads/:threadId/rename", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote task control is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands) return reply.code(503).send({ error: "Desktop task control is unavailable." });
    const params = z.object({ threadId: z.string().min(1).max(500) }).safeParse(request.params);
    const body = remoteThreadRenameRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid remote thread rename request." });
    }
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (!idempotencyKey) return reply.code(400).send({ error: "A valid Idempotency-Key is required." });
    try {
      const result = await commandReplay.execute(
        client.id,
        idempotencyKey,
        commandFingerprint("thread.rename", { threadId: params.data.threadId, ...body.data }),
        async () => {
          const rawResult = await commands.renameThread(params.data.threadId, body.data, { client });
          const parsed = remoteThreadMutationResultSchema.parse(rawResult);
          mobileAccess.recordTaskCommand(client.id, "task.thread_renamed", parsed.threadId);
          return parsed;
        },
      );
      return reply.send(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.post("/v1/commands/threads/:threadId/archive", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote task control is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands) return reply.code(503).send({ error: "Desktop task control is unavailable." });
    const params = z.object({ threadId: z.string().min(1).max(500) }).safeParse(request.params);
    const body = z.object({}).strict().safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid remote thread archive request." });
    }
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (!idempotencyKey) return reply.code(400).send({ error: "A valid Idempotency-Key is required." });
    try {
      const result = await commandReplay.execute(
        client.id,
        idempotencyKey,
        commandFingerprint("thread.archive", { threadId: params.data.threadId }),
        async () => {
          const rawResult = await commands.archiveThread(params.data.threadId, { client });
          const parsed = remoteThreadMutationResultSchema.parse(rawResult);
          mobileAccess.recordTaskCommand(client.id, "task.thread_archived", parsed.threadId);
          return parsed;
        },
      );
      return reply.send(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.post("/v1/commands/threads/:threadId/unarchive", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote task control is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands) return reply.code(503).send({ error: "Desktop task control is unavailable." });
    const params = z.object({ threadId: z.string().min(1).max(500) }).safeParse(request.params);
    const body = z.object({}).strict().safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid remote thread unarchive request." });
    }
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (!idempotencyKey) return reply.code(400).send({ error: "A valid Idempotency-Key is required." });
    try {
      const result = await commandReplay.execute(
        client.id,
        idempotencyKey,
        commandFingerprint("thread.unarchive", { threadId: params.data.threadId }),
        async () => {
          const rawResult = await commands.unarchiveThread(params.data.threadId, { client });
          const parsed = remoteThreadMutationResultSchema.parse(rawResult);
          mobileAccess.recordTaskCommand(client.id, "task.thread_unarchived", parsed.threadId);
          return parsed;
        },
      );
      return reply.send(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.delete("/v1/commands/threads/:threadId", async (request, reply) => {
    if (!mobileAccess) return reply.code(404).send({ error: "Remote task control is not enabled." });
    const client = mobileCommandClient(request, mobileAccess);
    if (!client) return reply.code(401).send({ error: "Missing mobile access identity." });
    if (!commands) return reply.code(503).send({ error: "Desktop task control is unavailable." });
    const params = z.object({ threadId: z.string().min(1).max(500) }).safeParse(request.params);
    const body = z.object({}).strict().safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Invalid remote thread deletion request." });
    }
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    if (!idempotencyKey) return reply.code(400).send({ error: "A valid Idempotency-Key is required." });
    try {
      const result = await commandReplay.execute(
        client.id,
        idempotencyKey,
        commandFingerprint("thread.delete", { threadId: params.data.threadId }),
        async () => {
          const rawResult = await commands.deleteThread(params.data.threadId, { client });
          const parsed = remoteThreadMutationResultSchema.parse(rawResult);
          mobileAccess.recordTaskCommand(client.id, "task.thread_deleted", parsed.threadId);
          return parsed;
        },
      );
      return reply.send(result);
    } catch (error) {
      return sendCommandError(reply, error);
    }
  });

  app.get("/v1/events", { websocket: true }, (socket, request) => {
    const client = (request as typeof request & { mobileClient?: MobileClientIdentity }).mobileClient;
    sockets.set(socket, client?.id || null);
    const query = z
      .object({ after: z.coerce.number().int().nonnegative().default(0) })
      .safeParse(request.query);
    const after = query.success ? query.data.after : 0;
    for (const event of store.listEvents(after)) socket.send(JSON.stringify(event));
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  const closeRevokedAccess = (clientId: string) => {
    for (const [socket, socketClientId] of sockets) {
      if (socketClientId !== clientId) continue;
      sockets.delete(socket);
      try {
        socket.close(4001, "Mobile access key replaced");
      } catch {
        continue;
      }
    }
  };
  mobileAccess?.on("access:revoked", closeRevokedAccess);

  const unsubscribe = store.onEvent((event) => {
    const payload = JSON.stringify(event);
    for (const socket of sockets.keys()) {
      if (socket.readyState === 1) socket.send(payload);
    }
  });

  return {
    app,
    store,
    async start(startOptions = {}) {
      const host = startOptions.host || "127.0.0.1";
      const port = startOptions.port ?? 8790;
      await app.listen({ host, port });
      const address = app.server.address();
      if (!address || typeof address === "string") {
        throw new Error("Control plane did not bind to a TCP address.");
      }
      const scheme = options.tls ? "https" : "http";
      return { host, port: address.port, url: `${scheme}://${formatHostForUrl(host)}:${address.port}` };
    },
    async stop() {
      unsubscribe();
      mobileAccess?.off("access:revoked", closeRevokedAccess);
      for (const socket of sockets.keys()) {
        try {
          socket.close();
        } catch {
          continue;
        }
      }
      sockets.clear();
      await app.close();
    },
  };
}

export { ControlStore, type ControlStoreState } from "./store.js";
export {
  MobileAccessManager,
  normalizeMobileAccessState,
  type MobileAccessAuditEntry,
  type MobileAccessKey,
  type MobileAccessState,
  type MobileClientIdentity,
  type NormalizedMobileAccessState,
} from "./mobile-access.js";

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function mobileCommandClient(
  request: unknown,
  mobileAccess: MobileAccessManager | undefined,
): MobileClientIdentity | null {
  if (!mobileAccess || !request || typeof request !== "object") return null;
  return (request as { mobileClient?: MobileClientIdentity }).mobileClient || null;
}

function sendCommandError(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  error: unknown,
): unknown {
  if (error instanceof ControlCommandError) {
    if (error.code === "invalid") {
      return reply.code(400).send({ error: "The desktop rejected invalid command input." });
    }
    if (error.code === "not_found") {
      return reply.code(404).send({ error: "The requested desktop resource was not found." });
    }
    if (error.code === "conflict") {
      return reply.code(409).send({ error: "The desktop rejected the command in its current state." });
    }
    return reply.code(503).send({ error: "Desktop task control is temporarily unavailable." });
  }
  return reply.code(500).send({ error: "Desktop task control failed." });
}

function parseIdempotencyKey(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9._:-]{8,200}$/.test(normalized) ? normalized : null;
}

function commandFingerprint(command: string, value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson({ command, value }))).digest("hex");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  );
}

function extractAccessKey(
  authorization: string | undefined,
  websocketProtocol: string | string[] | undefined,
): string | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization || "")?.[1]?.trim();
  if (bearer) return bearer;
  const protocols = (Array.isArray(websocketProtocol) ? websocketProtocol : String(websocketProtocol || "").split(","))
    .map((value) => value.trim());
  const protocol = protocols.find((value) => value.startsWith("rhzycode.auth."));
  return protocol ? protocol.slice("rhzycode.auth.".length) : null;
}
