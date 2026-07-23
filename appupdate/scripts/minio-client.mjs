import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

export async function uploadFile(options) {
  const stat = await fs.promises.stat(options.filePath);
  if (!stat.isFile()) throw new Error(`Upload source is not a file: ${options.filePath}`);
  const payloadHash = await hashFile(options.filePath);
  return putObject({
    ...options,
    bodyLength: stat.size,
    payloadHash,
    createBody: () => fs.createReadStream(options.filePath),
  });
}

export async function uploadBuffer(options) {
  const body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
  return putObject({
    ...options,
    bodyLength: body.length,
    payloadHash: createHash("sha256").update(body).digest("hex"),
    createBody: () => body,
  });
}

export function publicObjectUrl(config, objectName) {
  const endpoint = String(config.endpoint).replace(/\/+$/, "");
  const objectPath = [config.bucket, objectName]
    .flatMap((part) => String(part).split("/"))
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `${endpoint}/${objectPath}`;
}

async function putObject(options) {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("MinIO endpoint must use HTTP or HTTPS.");
  }
  if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("MinIO endpoint must not contain a path, query, or fragment.");
  }

  const canonicalUri = `/${[options.bucket, options.objectName]
    .flatMap((part) => String(part).split("/"))
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/")}`;
  const url = new URL(canonicalUri, endpoint);
  const now = options.now || new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = options.region || "us-east-1";
  const service = "s3";
  const headers = {
    "cache-control": options.cacheControl || "public, max-age=3600",
    "content-type": options.contentType || "application/octet-stream",
    host: endpoint.host,
    "x-amz-content-sha256": options.payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${normalizeHeader(headers[name])}\n`)
    .join("");
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    options.payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signingKey = signatureKey(options.secretKey, dateStamp, region, service);
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${options.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  await sendRequest(url, {
    ...headers,
    Authorization: authorization,
    "Content-Length": String(options.bodyLength),
  }, options.createBody, options.timeoutMs || 120_000);
  return { url: url.toString(), bytes: options.bodyLength };
}

function sendRequest(url, headers, createBody, timeoutMs) {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method: "PUT", headers }, (response) => {
      const chunks = [];
      let responseBytes = 0;
      response.on("data", (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes <= 8_192) chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
          return;
        }
        const detail = Buffer.concat(chunks).toString("utf8").slice(0, 8_192);
        reject(new Error(`MinIO PUT ${url.pathname} returned HTTP ${response.statusCode}: ${detail}`));
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`MinIO PUT timed out after ${timeoutMs}ms.`)));
    request.on("error", reject);
    const body = createBody();
    if (Buffer.isBuffer(body)) request.end(body);
    else {
      body.on("error", (error) => request.destroy(error));
      body.pipe(request);
    }
  });
}

function normalizeHeader(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

function signatureKey(secretKey, dateStamp, region, service) {
  const dateKey = createHmac("sha256", `AWS4${secretKey}`).update(dateStamp).digest();
  const regionKey = createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = createHmac("sha256", regionKey).update(service).digest();
  return createHmac("sha256", serviceKey).update("aws4_request").digest();
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
