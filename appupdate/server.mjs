import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = path.dirname(fileURLToPath(import.meta.url));
const mimeTypes = new Map([
  [".apk", "application/vnd.android.package-archive"],
  [".blockmap", "application/octet-stream"],
  [".exe", "application/octet-stream"],
  [".json", "application/json; charset=utf-8"],
  [".yml", "application/yaml; charset=utf-8"],
  [".yaml", "application/yaml; charset=utf-8"],
]);

export function loadConfig(root = serviceRoot) {
  const value = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  return {
    host: String(value.host || "0.0.0.0"),
    port: Number(value.port || 8791),
    publicBaseUrl: String(value.publicBaseUrl || "").replace(/\/+$/, ""),
    artifactsDirectory: String(value.artifactsDirectory || "artifacts"),
    channelFile: String(value.channelFile || "channel.json"),
  };
}

export function createUpdateServer({ root = serviceRoot, config = loadConfig(root) } = {}) {
  const artifactsRoot = path.resolve(root, config.artifactsDirectory);
  const channelPath = path.resolve(root, config.channelFile);

  return http.createServer((request, response) => {
    void handleRequest(request, response, { artifactsRoot, channelPath, config }).catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { error: "internal_error" });
      else response.destroy();
      console.error(`[appupdate] ${error instanceof Error ? error.stack || error.message : String(error)}`);
    });
  });
}

async function handleRequest(request, response, context) {
  const requestUrl = new URL(request.url || "/", "http://localhost");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  if (requestUrl.pathname === "/" || requestUrl.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "RHZYCODE Update Service",
      baseUrl: context.config.publicBaseUrl,
    }, request.method === "HEAD");
    return;
  }

  if (requestUrl.pathname === "/manifest.json") {
    let channel;
    try {
      channel = JSON.parse(fs.readFileSync(context.channelPath, "utf8"));
    } catch {
      sendJson(response, 503, { error: "channel_not_published" });
      return;
    }
    const manifest = publicManifest(channel, context.config.publicBaseUrl);
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 200, manifest, request.method === "HEAD");
    return;
  }

  const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
  if (!relativePath.startsWith("desktop/") && !relativePath.startsWith("mobile/")) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  const filePath = path.resolve(context.artifactsRoot, relativePath);
  if (!isWithin(context.artifactsRoot, filePath)) {
    sendJson(response, 400, { error: "invalid_path" });
    return;
  }
  await sendFile(request, response, filePath);
}

function publicManifest(channel, baseUrl) {
  const absoluteUrl = (relativePath) => `${baseUrl}/${String(relativePath).replace(/^\/+/, "")}`;
  return {
    schemaVersion: 1,
    publishedAt: channel.publishedAt,
    desktop: channel.desktop ? {
      ...channel.desktop,
      feedUrl: `${baseUrl}/desktop`,
      downloadUrl: absoluteUrl(channel.desktop.path),
    } : null,
    android: channel.android ? {
      ...channel.android,
      apkUrl: absoluteUrl(channel.android.path),
    } : null,
  };
}

async function sendFile(request, response, filePath) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    sendJson(response, 404, { error: "artifact_not_found" });
    return;
  }
  if (!stat.isFile()) {
    sendJson(response, 404, { error: "artifact_not_found" });
    return;
  }

  const range = parseRange(request.headers.range, stat.size);
  if (range === false) {
    response.statusCode = 416;
    response.setHeader("Content-Range", `bytes */${stat.size}`);
    response.end();
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  const contentLength = Math.max(0, end - start + 1);
  response.statusCode = range ? 206 : 200;
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", extension === ".yml" || extension === ".yaml" ? "no-cache" : "public, max-age=3600");
  response.setHeader("Content-Length", contentLength);
  response.setHeader("Content-Type", mimeTypes.get(extension) || "application/octet-stream");
  if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  if (extension === ".apk" || extension === ".exe") {
    response.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
  }
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  fs.createReadStream(filePath, { start, end }).pipe(response);
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return false;
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return false;
  }
  return { start, end: Math.min(end, size - 1) };
}

function sendJson(response, statusCode, value, headOnly = false) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  response.statusCode = statusCode;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", body.length);
  if (headOnly) response.end();
  else response.end(body);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const config = loadConfig();
  const server = createUpdateServer({ config });
  server.on("error", (error) => {
    console.error(`[appupdate] Unable to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`[appupdate] listening on ${config.host}:${config.port}`);
    console.log(`[appupdate] public URL ${config.publicBaseUrl}`);
  });
}
