import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteTurnStartRequest } from "@rhzycode/protocol";
import {
  createControlPlane,
  MobileAccessManager,
  type ControlCommandHandlers,
} from "../../desktop/src/main/control-plane/app";
import { ControlClient, ControlClientError } from "../src/api/control-client";
import { runControlCommandWithRetry } from "../src/api/control-connection-model";
import { buildChatEntries, type PendingMessage } from "../src/components/chat-screen-model";

test("connects the mobile client to the real desktop control contract", async () => {
  const mobileAccess = new MobileAccessManager();
  const firstKey = mobileAccess.rotateAccessKey();
  const controlPlane = await createControlPlane({ logLevel: "silent", mobileAccess });
  const address = await controlPlane.start({ host: "127.0.0.1", port: 0 });
  const controlUrl = `http://127.0.0.1:${address.port}`;
  const client = new ControlClient(firstKey.key, { controlUrl });

  try {
    const snapshot = await client.getSnapshot();
    assert.equal(snapshot.lastSequence, 0);

    const descriptor = client.eventSocket(snapshot.lastSequence);
    const socket = new WebSocket(descriptor.url, descriptor.protocols);
    await waitForSocket(socket, "open");
    const pong = waitForSocket(socket, "message");
    socket.send(JSON.stringify({ type: "control.ping", id: "integration-heartbeat" }));
    assert.deepEqual(JSON.parse(String((await pong as MessageEvent).data)), {
      type: "control.pong",
      id: "integration-heartbeat",
    });
    const message = waitForSocket(socket, "message");
    controlPlane.store.upsertHost({
      id: "desktop-integration",
      name: "Desktop integration",
      platform: "windows",
      status: "online",
      lastSeenAt: new Date().toISOString(),
      activeTaskCount: 0,
    });
    const event = client.parseEvent(String((await message as MessageEvent).data));
    assert.equal(event.type, "host.status");

    const closed = waitForSocket(socket, "close");
    const replacement = mobileAccess.rotateAccessKey();
    assert.equal((await closed as CloseEvent).code, 4001);
    await assert.rejects(
      () => client.getSnapshot(),
      (error: unknown) => error instanceof ControlClientError && error.code === "unauthorized",
    );
    const replacementSnapshot = await new ControlClient(
      replacement.key,
      { controlUrl },
    ).getSnapshot();
    assert.equal(replacementSnapshot.hosts.some((host) => host.id === "desktop-integration"), true);
  } finally {
    await controlPlane.stop();
  }
});

test("keeps two desktop event streams connected and isolated", async () => {
  const firstAccess = new MobileAccessManager();
  const secondAccess = new MobileAccessManager();
  const firstControl = await createControlPlane({ logLevel: "silent", mobileAccess: firstAccess });
  const secondControl = await createControlPlane({ logLevel: "silent", mobileAccess: secondAccess });
  const firstAddress = await firstControl.start({ host: "127.0.0.1", port: 0 });
  const secondAddress = await secondControl.start({ host: "127.0.0.1", port: 0 });
  const firstClient = new ControlClient(firstAccess.rotateAccessKey().key, {
    controlUrl: `http://127.0.0.1:${firstAddress.port}`,
  });
  const secondClient = new ControlClient(secondAccess.rotateAccessKey().key, {
    controlUrl: `http://127.0.0.1:${secondAddress.port}`,
  });
  const firstSocket = new WebSocket(firstClient.eventSocket(0).url, firstClient.eventSocket(0).protocols);
  const secondSocket = new WebSocket(secondClient.eventSocket(0).url, secondClient.eventSocket(0).protocols);

  try {
    await Promise.all([waitForSocket(firstSocket, "open"), waitForSocket(secondSocket, "open")]);
    const firstMessage = waitForSocket(firstSocket, "message");
    const secondMessage = waitForSocket(secondSocket, "message");
    firstControl.store.upsertHost(createHost("desktop-one", "Desktop one"));
    secondControl.store.upsertHost(createHost("desktop-two", "Desktop two"));

    const [firstEvent, secondEvent] = await Promise.all([firstMessage, secondMessage]);
    const parsedFirst = firstClient.parseEvent(String((firstEvent as MessageEvent).data));
    const parsedSecond = secondClient.parseEvent(String((secondEvent as MessageEvent).data));
    assert.equal(parsedFirst.type === "host.status" && parsedFirst.host.id, "desktop-one");
    assert.equal(parsedSecond.type === "host.status" && parsedSecond.host.id, "desktop-two");
  } finally {
    firstSocket.close();
    secondSocket.close();
    await Promise.all([firstControl.stop(), secondControl.stop()]);
  }
});

test("replays one accepted turn after multiple lost mobile responses without duplicating it", async () => {
  const mobileAccess = new MobileAccessManager();
  const accessKey = mobileAccess.rotateAccessKey();
  let commandCalls = 0;
  let controlPlane: Awaited<ReturnType<typeof createControlPlane>>;
  const commands = {
    async startTurn(threadId: string, request: RemoteTurnStartRequest) {
      commandCalls += 1;
      const acceptedAt = new Date().toISOString();
      controlPlane.store.publish({
        type: "timeline.upserted",
        item: {
          id: "user-mobile-message-loss-1",
          threadId,
          clientMessageId: request.clientMessageId,
          kind: "user",
          status: "completed",
          title: "你",
          content: request.text,
          createdAt: acceptedAt,
        },
      });
      return { threadId, turnId: "turn-loss-1", acceptedAt };
    },
  } as Pick<ControlCommandHandlers, "startTurn"> as ControlCommandHandlers;
  controlPlane = await createControlPlane({ logLevel: "silent", mobileAccess, commands });
  const address = await controlPlane.start({ host: "127.0.0.1", port: 0 });
  let turnHttpAttempts = 0;
  const unstableFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).endsWith("/turns/start")) {
      turnHttpAttempts += 1;
      if (turnHttpAttempts <= 2) {
        await response.arrayBuffer();
        throw new TypeError("Network response was lost");
      }
    }
    return response;
  };
  const client = new ControlClient(accessKey.key, {
    controlUrl: `http://127.0.0.1:${address.port}`,
    fetchImpl: unstableFetch,
  });
  const pending: PendingMessage = {
    id: "mobile-message-loss-1",
    threadId: "thread-loss-1",
    content: "Continue through the tunnel",
    createdAt: new Date().toISOString(),
    state: "sending",
  };

  try {
    const result = await runControlCommandWithRetry(() => client.startTurn(
      pending.threadId,
      { text: pending.content },
      5_000,
      `${pending.id}:turn`,
    ), { sleep: async () => undefined });
    const snapshot = await client.getSnapshot();
    const entries = buildChatEntries({
      selectedThreadId: pending.threadId,
      timeline: snapshot.timeline,
      pendingMessages: [pending],
      approvals: [],
      userInputs: [],
    }, false);

    assert.equal(result.turnId, "turn-loss-1");
    assert.equal(turnHttpAttempts, 3);
    assert.equal(commandCalls, 1);
    assert.equal(snapshot.timeline.length, 1);
    assert.deepEqual(entries.map((entry) => entry.id), ["timeline:user-mobile-message-loss-1"]);
  } finally {
    await controlPlane.stop();
  }
});

function createHost(id: string, name: string) {
  return {
    id,
    name,
    platform: "windows" as const,
    status: "online" as const,
    lastSeenAt: new Date().toISOString(),
    activeTaskCount: 0,
  };
}

function waitForSocket(socket: WebSocket, event: "open" | "message" | "close"): Promise<Event | MessageEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for WebSocket ${event}`)), 3000);
    socket.addEventListener(event, (value) => {
      clearTimeout(timeout);
      resolve(value);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket failed"));
    }, { once: true });
  });
}
