import assert from "node:assert/strict";
import test from "node:test";
import type { ControlSnapshot } from "@rhzycode/protocol";
import { ControlClient, ControlClientError, verifyControlAccess } from "../src/api/control-client";

const now = "2026-07-15T10:00:00.000Z";
const accessKey = `rhzy_${"A".repeat(43)}`;
const snapshot: ControlSnapshot = {
  hosts: [],
  threads: [],
  timeline: [],
  approvals: [],
  userInputs: [],
  lastSequence: 7,
};

test("loads a validated snapshot with HTTP Bearer authentication", async () => {
  let requestedUrl = "";
  let authorization = "";
  const fetchMock: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization || "");
    return Response.json(snapshot);
  };
  const client = new ControlClient("192.168.1.20", 8790, accessKey, fetchMock);

  assert.deepEqual(await client.getSnapshot(), snapshot);
  assert.equal(requestedUrl, "http://192.168.1.20:8790/v1/snapshot");
  assert.match(authorization, /^Bearer /);
});

test("keeps the WebSocket credential in subprotocols and the cursor in the URL", () => {
  const client = new ControlClient("192.168.1.20", 8790, accessKey);
  const descriptor = client.eventSocket(12.9);

  assert.equal(descriptor.url, "ws://192.168.1.20:8790/v1/events?after=12");
  assert.equal(descriptor.protocols[0], "rhzycode.v1");
  assert.match(descriptor.protocols[1], /^rhzycode\.auth\./);
  assert.doesNotMatch(descriptor.url, /credential/);
});

test("builds authenticated generated image sources without exposing the key in the URL", () => {
  const client = new ControlClient("192.168.1.20", 8790, accessKey);
  const source = client.generatedImageSource("generated-image-a1b2c3d4e5f60708.png");

  assert.equal(
    source.uri,
    "http://192.168.1.20:8790/v1/generated-images/generated-image-a1b2c3d4e5f60708.png",
  );
  assert.equal(source.headers.Authorization, `Bearer ${accessKey}`);
  assert.doesNotMatch(source.uri, /rhzy_/);
});

test("builds authenticated managed file downloads without exposing the key in the URL", () => {
  const client = new ControlClient("192.168.1.20", 8790, accessKey);
  const request = client.managedFileRequest("file-report-1");

  assert.equal(request.url, "http://192.168.1.20:8790/v1/files/file-report-1");
  assert.equal(request.headers.Authorization, `Bearer ${accessKey}`);
  assert.doesNotMatch(request.url, /rhzy_/);
});

test("verifies a long-lived KEY before saving and validates events at runtime", async () => {
  let authorization = "";
  const fetchMock: typeof fetch = async (_input, init) => {
    authorization = String((init?.headers as Record<string, string>).Authorization);
    return Response.json(snapshot);
  };
  const result = await verifyControlAccess({
    host: "192.168.1.20",
    port: 8790,
    accessKey,
  }, fetchMock);
  assert.deepEqual(result, snapshot);
  assert.equal(authorization, `Bearer ${accessKey}`);

  const client = new ControlClient("192.168.1.20", 8790, accessKey);
  assert.equal(client.parseEvent(JSON.stringify({
    type: "thread.removed",
    sequence: 8,
    threadId: "thread-1",
  })).sequence, 8);
  assert.throws(() => client.parseEvent('{"type":"unknown"}'), isCode("invalid_response"));
});

test("maps HTTP authorization, permission, and conflict statuses", async () => {
  for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [404, "not_found"], [409, "conflict"]] as const) {
    const client = new ControlClient(
      "192.168.1.20",
      8790,
      accessKey,
      async () => Response.json({ error: "Test failure" }, { status }),
    );
    await assert.rejects(() => client.getSnapshot(), isCode(code));
  }
});

test("distinguishes timeout, certificate, and malformed response failures", async () => {
  const timeoutClient = new ControlClient(
    "192.168.1.20",
    8790,
    accessKey,
    async () => { throw new DOMException("Aborted", "AbortError"); },
  );
  await assert.rejects(() => timeoutClient.getSnapshot(), isCode("timeout"));

  const certificateClient = new ControlClient(
    "192.168.1.20",
    8790,
    accessKey,
    async () => { throw new TypeError("SSL certificate validation failed"); },
  );
  await assert.rejects(() => certificateClient.getSnapshot(), isCode("certificate"));

  const invalidClient = new ControlClient(
    "192.168.1.20",
    8790,
    accessKey,
    async () => Response.json({ lastSequence: 1 }),
  );
  await assert.rejects(() => invalidClient.getSnapshot(), isCode("invalid_response"));
});

test("sends remote task commands with bearer auth and idempotency keys", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/threads/start")) {
      return Response.json({ threadId: "thread-new", acceptedAt: now }, { status: 201 });
    }
    if (url.endsWith("/threads/thread-new")) {
      return Response.json({
        thread: {
          id: "thread-new",
          hostId: "local-desktop",
          title: "Restored task",
          projectPath: "D:\\work",
          model: "sub2api/gpt-test",
          status: "completed",
          updatedAt: now,
        },
        timeline: [],
      });
    }
    return Response.json({ threadId: "thread-new", turnId: "turn-1", acceptedAt: now }, { status: 202 });
  };
  let sequence = 0;
  const client = new ControlClient(
    "192.168.1.20",
    8790,
    accessKey,
    fetchMock,
    () => `command-${++sequence}`,
  );

  assert.equal((await client.startThread({
    projectPath: "D:\\work",
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
  })).threadId, "thread-new");
  assert.equal((await client.openThread("thread-new")).thread.id, "thread-new");
  assert.equal((await client.startTurn("thread-new", {
    text: "Run the tests",
    model: "sub2api/gpt-test",
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
    reasoningEffort: "xhigh",
  })).turnId, "turn-1");
  assert.equal((await client.setThreadModel("thread-new", "sub2api/gpt-switched")).threadId, "thread-new");
  assert.equal((await client.archiveThread("thread-new")).threadId, "thread-new");
  assert.equal((await client.unarchiveThread("thread-new")).threadId, "thread-new");
  assert.equal(calls.length, 6);
  assert.equal(calls[0]?.url, "http://192.168.1.20:8790/v1/commands/threads/start");
  assert.equal(calls[1]?.url, "http://192.168.1.20:8790/v1/commands/threads/thread-new");
  assert.equal(calls[2]?.url, "http://192.168.1.20:8790/v1/commands/threads/thread-new/turns/start");
  assert.equal(calls[3]?.url, "http://192.168.1.20:8790/v1/commands/threads/thread-new/model");
  assert.equal(calls[4]?.url, "http://192.168.1.20:8790/v1/commands/threads/thread-new/archive");
  assert.equal(calls[5]?.url, "http://192.168.1.20:8790/v1/commands/threads/thread-new/unarchive");
  assert.equal((calls[0]?.init?.headers as Record<string, string>)["Idempotency-Key"], "command-1");
  assert.equal((calls[1]?.init?.headers as Record<string, string>)["Idempotency-Key"], undefined);
  assert.equal((calls[2]?.init?.headers as Record<string, string>)["Idempotency-Key"], "command-2");
  assert.equal((calls[3]?.init?.headers as Record<string, string>)["Idempotency-Key"], "command-3");
  assert.equal((calls[4]?.init?.headers as Record<string, string>)["Idempotency-Key"], "command-4");
  assert.equal((calls[5]?.init?.headers as Record<string, string>)["Idempotency-Key"], "command-5");
  assert.match(String((calls[0]?.init?.headers as Record<string, string>).Authorization), /^Bearer /);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    projectPath: "D:\\work",
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
  });
  assert.equal(calls[1]?.init?.body, undefined);
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
    text: "Run the tests",
    model: "sub2api/gpt-test",
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
    reasoningEffort: "xhigh",
  });
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), {
    model: "sub2api/gpt-switched",
  });
});

test("validates archived thread command responses", async () => {
  let requestedUrl = "";
  const client = new ControlClient(
    "192.168.1.20",
    8790,
    accessKey,
    async (input) => {
      requestedUrl = String(input);
      return Response.json({ threads: [] });
    },
  );
  assert.deepEqual(await client.listArchivedThreads("older work"), { threads: [] });
  assert.equal(requestedUrl, "http://192.168.1.20:8790/v1/commands/threads/archived?searchTerm=older+work");
});

test("lists and opens synchronized desktop project directories", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new ControlClient(
    "192.168.1.20",
    8790,
    accessKey,
    async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === "POST") {
        return Response.json({
          project: { path: "D:\\work_space\\mobile-new", name: "mobile-new" },
          created: false,
        });
      }
      if (init?.method === "DELETE") return Response.json({ projects: [] });
      return Response.json({ projects: [{ path: "D:\\work_space\\test", name: "test" }] });
    },
    () => "project-command-1",
  );

  assert.equal((await client.listProjects()).projects[0]?.name, "test");
  const opened = await client.openProject("D:\\work_space\\mobile-new");
  assert.equal(opened.created, false);
  assert.equal(opened.project.name, "mobile-new");
  assert.equal(calls[0]?.url, "http://192.168.1.20:8790/v1/commands/projects");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { path: "D:\\work_space\\mobile-new" });
  assert.equal((calls[1]?.init?.headers as Record<string, string>)["Idempotency-Key"], "project-command-1");

  await client.openProject("D:\\work_space\\created", true);
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
    path: "D:\\work_space\\created",
    create: true,
  });

  assert.deepEqual(await client.removeProject("D:\\work_space\\mobile-new"), { projects: [] });
  assert.equal(calls[3]?.url, "http://192.168.1.20:8790/v1/commands/projects");
  assert.equal(calls[3]?.init?.method, "DELETE");
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { path: "D:\\work_space\\mobile-new" });

});

test("browses desktop directories remotely without a desktop dialog", async () => {
  let requestedUrl = "";
  const client = new ControlClient("192.168.1.20", 8790, accessKey, async (input) => {
    requestedUrl = String(input);
    return Response.json({
      path: "D:\\work_space",
      parentPath: "D:\\",
      directories: [{ path: "D:\\work_space\\test", name: "test" }],
    });
  });
  const result = await client.browseDirectories("D:\\work_space");
  assert.equal(result.directories[0]?.name, "test");
  assert.equal(requestedUrl, "http://192.168.1.20:8790/v1/commands/projects/browse?path=D%3A%5Cwork_space");
});

test("loads the model catalog from the selected desktop", async () => {
  let requestedUrl = "";
  const client = new ControlClient(
    "192.168.1.20",
    8790,
    accessKey,
    async (input) => {
      requestedUrl = String(input);
      return Response.json({
        models: [{
          id: "model-test",
          model: "sub2api/gpt-test",
          displayName: "GPT Test",
          source: "Sub2API",
          sourceModelName: "gpt-test",
          description: "Test model",
          defaultReasoningEffort: "medium",
          reasoningEfforts: ["low", "medium", "high", "xhigh"],
          isDefault: true,
        }],
      });
    },
  );

  const model = (await client.listModels()).models[0];
  assert.equal(model?.displayName, "GPT Test");
  assert.equal(model?.source, "Sub2API");
  assert.equal(model?.sourceModelName, "gpt-test");
  assert.deepEqual(model?.reasoningEfforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(requestedUrl, "http://192.168.1.20:8790/v1/commands/models");
});

function isCode(code: ControlClientError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ControlClientError && error.code === code;
}
