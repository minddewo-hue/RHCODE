import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { publicObjectUrl, uploadBuffer } from "../scripts/minio-client.mjs";

test("uploads an object with AWS Signature V4 headers", async (context) => {
  let received;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");

  await uploadBuffer({
    endpoint: `http://127.0.0.1:${address.port}`,
    bucket: "wxfile",
    objectName: "rhzycode/version.json",
    region: "us-east-1",
    accessKey: "test-access",
    secretKey: "test-secret",
    body: "{}\n",
    contentType: "application/json; charset=utf-8",
    cacheControl: "no-store",
    now: new Date("2026-07-23T00:00:00.000Z"),
  });

  assert.equal(received.url, "/wxfile/rhzycode/version.json");
  assert.equal(received.body, "{}\n");
  assert.equal(received.headers["cache-control"], "no-store");
  assert.equal(received.headers["x-amz-date"], "20260723T000000Z");
  assert.match(received.headers.authorization, /^AWS4-HMAC-SHA256 Credential=test-access\/20260723\/us-east-1\/s3\/aws4_request,/);
});

test("builds the public path-style MinIO URL", () => {
  assert.equal(publicObjectUrl({
    endpoint: "https://minio.example.test/",
    bucket: "releases",
  }, "rhzycode/android/app.apk"), "https://minio.example.test/releases/rhzycode/android/app.apk");
});
