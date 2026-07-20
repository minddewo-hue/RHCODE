import assert from "node:assert/strict";
import test from "node:test";
import { createControlPlane, MobileAccessManager } from "../../desktop/src/main/control-plane/app";
import { ControlClient, ControlClientError } from "../src/api/control-client";

test("connects the mobile client to the real desktop control contract", async () => {
  const mobileAccess = new MobileAccessManager();
  const firstKey = mobileAccess.rotateAccessKey();
  const controlPlane = await createControlPlane({ logLevel: "silent", mobileAccess });
  const address = await controlPlane.start({ host: "127.0.0.1", port: 0 });
  const client = new ControlClient("127.0.0.1", address.port, firstKey.key);

  try {
    const snapshot = await client.getSnapshot();
    assert.equal(snapshot.lastSequence, 0);

    const descriptor = client.eventSocket(snapshot.lastSequence);
    const socket = new WebSocket(descriptor.url, descriptor.protocols);
    await waitForSocket(socket, "open");
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
      "127.0.0.1",
      address.port,
      replacement.key,
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
  const firstClient = new ControlClient("127.0.0.1", firstAddress.port, firstAccess.rotateAccessKey().key);
  const secondClient = new ControlClient("127.0.0.1", secondAddress.port, secondAccess.rotateAccessKey().key);
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
