import assert from "node:assert/strict";
import test from "node:test";
import type { ControlSnapshot, RemoteTurnStartRequest } from "@rhzycode/protocol";
import {
  createControlPlane,
  ControlStore,
  MobileAccessManager,
  type ControlCommandHandlers,
} from "../../desktop/src/main/control-plane/app";
import { ControlClient, ControlClientError } from "../src/api/control-client";
import { runControlCommandWithRetry } from "../src/api/control-connection-model";
import { refreshThreadTimeline } from "../src/api/timeline-refresh";
import {
  assistantDisplayContent,
  buildChatEntries,
  type PendingMessage,
} from "../src/components/chat-screen-model";
import {
  emptyControlSnapshot,
  hydrateThreadSnapshot,
  mergeControlSnapshot,
  mergeTimelineDelta,
} from "../src/state/control-reducer";

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
    const syncMessage = waitForSocket(socket, "message");
    await waitForSocket(socket, "open");
    const sync = client.parseSocketFrame(String((await syncMessage as MessageEvent).data));
    assert.equal(sync.type, "control.sync");
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

test("round-trips this conversation through desktop openThread and mobile chat state unchanged", async () => {
  const mobileAccess = new MobileAccessManager();
  const accessKey = mobileAccess.rotateAccessKey();
  const acceptedAt = "2026-10-16T08:00:00.000Z";
  const threadId = "thread-conversation-roundtrip";
  const thread = {
    id: threadId,
    hostId: "desktop-roundtrip",
    title: "Conversation data round-trip",
    projectPath: "D:\\work_space\\RHZYCODE",
    model: "test/model",
    status: "completed" as const,
    updatedAt: acceptedAt,
  };
  const expectedMessages = [
    {
      role: "user" as const,
      content: "当前的手机版 显示的数据还是不对。   和电脑版生成的 文字内容都  对不上。电脑版是对的。传输到手机版的数据 还是有问题。检查原因",
    },
    {
      role: "assistant" as const,
      content: "我会先沿着“电脑版生成内容 → 传输/存储 → 手机版读取与渲染”的链路检查，重点比对两端的数据结构、序列化和缓存逻辑；先定位差异来源，再用相关测试验证。",
    },
    {
      role: "user" as const,
      content: "你可以自己添加一个测试接口，模拟下获取对话。看看返回的数据和实际数据能对得上吗？  就使用本对话的内容就可以 。开始",
    },
    {
      role: "assistant" as const,
      content: [
        "现有控制面已经有真实的 `GET /v1/commands/threads/:threadId`，测试可以注入模拟桌面 `openThread`，再让真正的手机 `ControlClient` 发 HTTP 请求；不需要加暴露在生产环境的调试接口。",
        "",
        "接下来我会加一条端到端回归测试，使用本对话原文（含中文、空格、换行和 Markdown），逐站断言服务端原始数据、HTTP 返回、手机合并状态及聊天列表文本完全一致。",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: [
        "微信团队 安全考试 恢复账号 你已完成学习，请仔细阅读以下内容并勾选，完成后即可申请恢复账号:",
        "1.我已知悉，使用外挂、非官方客户端等违规工具，违反《微信个人账号使用规范》，且此类工具未经安全检测，会带来严重的账号与财产安全风险。 我已了解以上违规行为，并承诺立即纠正。",
        "2.我清楚知悉，微信对外挂的治理是常态化持续性的，不存在“风头已过\"的说法。若再次违规使用外挂，平台将升级处罚至永久限制。 我已知晓再次违规的严重后果，并保证不再使 用。",
        "3.我郑重承诺:立即彻底卸载所有相关违规软件，从微信官网或官方应用商店下载正版微信(卸载前务必《备份聊天记录》)，并保证今后自觉遵守平台规范。",
        "我承诺切实履行以上全部保证，规范使用账 申请恢复",
        "以上是微信回复申请的 截图内容 微信号 使用插件hook 微信安卓端。 现在触发 了风控。 帮我分析下 有什么办法避免",
        "你应该能搜索到这个对话吧？  我是这个对话出错的。 继续测试。",
      ].join("\n"),
    },
    {
      role: "assistant" as const,
      content: "可以，而且刚才已经做了**接口链路模拟**：模拟桌面返回本对话内容，再验证手机版收到和显示的文本是否一致，结果一致。\n\n但要模拟你遇到的**真实错误**，还需要桌面实际返回的那份对话数据。拿到它后，可以用同一份数据重放接口，并分别检查 HTTP 返回、手机解析、缓存合并和最终显示；也可以人为模拟截断、重复消息、旧缓存覆盖等情况，观察哪种能复现问题。\n\n所以目前验证了“模拟数据传过去没变”，还没验证“真实会话数据传过去没变”。",
    },
  ];
  const timeline = expectedMessages.map((message, index) => ({
    id: `turn-${index + 1}::message-${index + 1}`,
    logicalId: `turn-${index + 1}::message-${index + 1}`,
    turnId: `turn-${index + 1}`,
    threadId,
    kind: message.role,
    status: "completed" as const,
    title: message.role === "user" ? "You" : "RHZYCODE",
    content: message.content,
    createdAt: acceptedAt,
    orderKey: index + 1,
  }));
  const desktopPayload = { thread, timeline };
  const commands = {
    async openThread(requestedThreadId: string) {
      assert.equal(requestedThreadId, threadId);
      return desktopPayload;
    },
  } as Pick<ControlCommandHandlers, "openThread"> as ControlCommandHandlers;
  const controlPlane = await createControlPlane({ logLevel: "silent", mobileAccess, commands });
  const address = await controlPlane.start({ host: "127.0.0.1", port: 0 });
  const client = new ControlClient(accessKey.key, {
    controlUrl: `http://127.0.0.1:${address.port}`,
  });

  try {
    const fetched = await client.openThread(threadId);
    const mobileState = hydrateThreadSnapshot(emptyControlSnapshot, fetched);
    const entries = buildChatEntries({
      selectedThreadId: threadId,
      timeline: mobileState.timeline,
      pendingMessages: [],
      approvals: [],
      userInputs: [],
    }, false);
    const actualMessages = entries.flatMap((entry) => (
      entry.type === "timeline"
        ? [{ role: entry.item.kind, content: entry.item.content }]
        : []
    ));

    assert.deepEqual(fetched.timeline.map((item) => item.content), expectedMessages.map((item) => item.content));
    assert.deepEqual(actualMessages, expectedMessages);
    assert.deepEqual(
      entries.flatMap((entry) => entry.type === "timeline" && entry.item.kind === "assistant"
        ? [assistantDisplayContent(entry.item)]
        : []),
      expectedMessages.filter((item) => item.role === "assistant").map((item) => item.content),
    );
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
    const firstSync = waitForSocket(firstSocket, "message");
    const secondSync = waitForSocket(secondSocket, "message");
    await Promise.all([waitForSocket(firstSocket, "open"), waitForSocket(secondSocket, "open")]);
    await Promise.all([firstSync, secondSync]);
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

test("restores accepted command results after a desktop restart", async () => {
  const mobileAccess = new MobileAccessManager();
  const accessKey = mobileAccess.rotateAccessKey().key;
  let commandCalls = 0;
  const commands = {
    async startTurn(threadId: string) {
      commandCalls += 1;
      return { threadId, turnId: "turn-persisted", acceptedAt: new Date().toISOString() };
    },
  } as Pick<ControlCommandHandlers, "startTurn"> as ControlCommandHandlers;
  const first = await createControlPlane({ logLevel: "silent", mobileAccess, commands });
  const request = {
    method: "POST" as const,
    url: "/v1/commands/threads/thread-persisted/turns/start",
    headers: {
      authorization: `Bearer ${accessKey}`,
      "idempotency-key": "message-persisted:turn",
    },
    payload: { text: "run once", clientMessageId: "message-persisted" },
  };

  const firstResponse = await first.app.inject(request);
  assert.equal(firstResponse.statusCode, 202);
  const persistedState = first.store.exportState();
  await first.stop();

  const restoredStore = new ControlStore(persistedState);
  const second = await createControlPlane({
    logLevel: "silent",
    mobileAccess,
    commands,
    store: restoredStore,
  });
  try {
    const replay = await second.app.inject(request);
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.json().turnId, "turn-persisted");
    assert.equal(commandCalls, 1);
    assert.equal(restoredStore.clientMessageIdForTurn("turn-persisted"), "message-persisted");
  } finally {
    await second.stop();
  }
});

test("recovers one user row and the completed AI reply after socket and HTTP loss", async () => {
  const mobileAccess = new MobileAccessManager();
  const accessKey = mobileAccess.rotateAccessKey();
  const thread = {
    id: "thread-weak-network",
    hostId: "desktop-weak-network",
    title: "Weak network recovery",
    projectPath: "D:\\work",
    model: "test/model",
    status: "running" as const,
    updatedAt: new Date().toISOString(),
  };
  const canonicalUser = {
    id: "turn-weak::user-history",
    threadId: thread.id,
    kind: "user" as const,
    status: "completed" as const,
    title: "You",
    content: "Continue after reconnecting",
    createdAt: "2026-08-02T10:00:00.000Z",
  };
  const assistant = {
    id: "turn-weak::assistant-history",
    threadId: thread.id,
    kind: "assistant" as const,
    status: "completed" as const,
    title: "RHZYCODE",
    content: "The reply completed while the phone was disconnected.",
    createdAt: "2026-08-02T10:00:01.000Z",
  };
  let openCalls = 0;
  const commands = {
    async openThread() {
      openCalls += 1;
      return { thread: { ...thread, status: "completed" as const }, timeline: [canonicalUser, assistant] };
    },
  } as Pick<ControlCommandHandlers, "openThread"> as ControlCommandHandlers;
  const controlPlane = await createControlPlane({ logLevel: "silent", mobileAccess, commands });
  controlPlane.store.upsertThread(thread);
  controlPlane.store.publish({
    type: "timeline.upserted",
    item: {
      ...canonicalUser,
      id: "user-mobile-weak-network",
      clientMessageId: "mobile-weak-network",
    },
  });
  const address = await controlPlane.start({ host: "127.0.0.1", port: 0 });
  const controlUrl = `http://127.0.0.1:${address.port}`;
  let lostHistoryResponses = 0;
  const unstableFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).endsWith(`/commands/threads/${thread.id}`) && lostHistoryResponses < 2) {
      lostHistoryResponses += 1;
      await response.arrayBuffer();
      throw new TypeError("History response was lost after the desktop completed it");
    }
    return response;
  };
  const client = new ControlClient(accessKey.key, { controlUrl, fetchImpl: unstableFetch });
  const pending: PendingMessage = {
    id: "mobile-weak-network",
    threadId: thread.id,
    content: canonicalUser.content,
    createdAt: canonicalUser.createdAt,
    state: "sent",
  };
  let mobileState: ControlSnapshot = emptyControlSnapshot;
  const socketDescriptor = client.eventSocket(0);
  const socket = new WebSocket(socketDescriptor.url, socketDescriptor.protocols);

  try {
    await waitForSocket(socket, "open");
    const closed = waitForSocket(socket, "close");
    socket.close();
    await closed;

    controlPlane.store.publish({ type: "timeline.upserted", item: assistant });
    controlPlane.store.upsertThread({ ...thread, status: "completed" });
    mobileState = mergeControlSnapshot(mobileState, await client.getSnapshot());
    const history = await runControlCommandWithRetry(
      () => client.openThread(thread.id, 5_000),
      { sleep: async () => undefined },
    );
    mobileState = hydrateThreadSnapshot(mobileState, history);
    const entries = buildChatEntries({
      selectedThreadId: thread.id,
      timeline: mobileState.timeline,
      pendingMessages: [pending],
      approvals: [],
      userInputs: [],
    }, false);

    assert.equal(lostHistoryResponses, 2);
    assert.equal(openCalls, 3);
    assert.equal(entries.every((entry) => entry.type === "timeline"), true);
    assert.deepEqual(entries.flatMap((entry) => entry.type === "timeline"
      ? [[entry.item.kind, entry.item.content]]
      : []), [
      ["user", canonicalUser.content],
      ["assistant", assistant.content],
    ]);
  } finally {
    socket.close();
    await controlPlane.stop();
  }
});

test("refreshes cached running text over real HTTP across three turns with paginated history", async () => {
  const mobileAccess = new MobileAccessManager();
  const key = mobileAccess.rotateAccessKey();
  const thread = {
    id: "thread-running-cache",
    hostId: "local-desktop",
    title: "Streaming cache regression",
    projectPath: "D:\\work_space\\RHZYCODE",
    model: "test/model",
    status: "running" as const,
    updatedAt: "2026-10-16T00:00:00.000Z",
  };
  let authoritative: ControlSnapshot["timeline"] = [];
  const commands = {
    async openThread() { return { thread, timeline: [...authoritative].reverse() }; },
  } as Pick<ControlCommandHandlers, "openThread"> as ControlCommandHandlers;
  const plane = await createControlPlane({ logLevel: "silent", mobileAccess, commands });
  const address = await plane.start({ host: "127.0.0.1", port: 0 });
  const client = new ControlClient(key.key, { controlUrl: `http://127.0.0.1:${address.port}` });
  let mobile = emptyControlSnapshot;
  try {
    for (let round = 1; round <= 3; round += 1) {
      const partial = {
        id: `turn-${round}::assistant`,
        threadId: thread.id,
        kind: "assistant" as const,
        title: "Assistant",
        content: `round ${round}\n`,
        status: "running" as const,
        createdAt: thread.updatedAt,
        orderKey: round,
      };
      authoritative.push(partial);
      mobile = hydrateThreadSnapshot(mobile, { thread, timeline: [partial] });
      // Phone loses the socket while this same row grows; no new key is created.
      const complete = {
        ...partial,
        content: partial.content + "Unicode: \u5fae\u4fe1\u56e2\u961f\n".repeat(300),
        status: "completed" as const,
      };
      authoritative = authoritative.map((item) => item.id === complete.id ? complete : item);
      const oldDelta = await client.fetchThreadTimeline(thread.id, round, 1);
      assert.equal(oldDelta.timeline.length, 0, "position-only catch-up misses the changed body");
      const cursors: number[] = [];
      await refreshThreadTimeline(async (cursor) => {
        cursors.push(cursor);
        return client.fetchThreadTimeline(thread.id, cursor, 1);
      }, (page) => { mobile = mergeTimelineDelta(mobile, page); });
      assert.deepEqual(cursors, Array.from({ length: round }, (_, index) => index));
      assert.deepEqual(
        mobile.timeline.map(({ id, content, status }) => ({ id, content, status })),
        authoritative.map(({ id, content, status }) => ({ id, content, status })),
      );
    }
  } finally {
    await plane.stop();
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
