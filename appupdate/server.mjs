import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { publicObjectUrl } from "./scripts/minio-client.mjs";
import { parseUpdateForPlatform } from "@rhzycode/update-contract";

const serviceRoot = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(root = serviceRoot) {
  return JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
}

export function createLegacyUpdateServer({ config = loadConfig(), fetchImpl = fetch } = {}) {
  const prefix = String(config.objectPrefix).replace(/^\/+|\/+$/g, "");
  const manifestUrl = publicObjectUrl(config, `${prefix}/${config.manifestFile}`);
  const windowsUrl = publicObjectUrl(config, `${prefix}/windows`).replace(/\/+$/, "");
  const androidUrl = publicObjectUrl(config, `${prefix}/android`).replace(/\/+$/, "");

  return http.createServer((request, response) => {
    void handleRequest(request, response, { manifestUrl, windowsUrl, androidUrl, fetchImpl }).catch((error) => {
      sendJson(response, 502, { error: "minio_unavailable", message: error instanceof Error ? error.message : String(error) });
    });
  });
}

async function handleRequest(request, response, context) {
  const requestUrl = new URL(request.url || "/", "http://localhost");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendJson(response, 405, { error: "method_not_allowed" }, request.method === "HEAD");
    return;
  }
  if (requestUrl.pathname === "/" || requestUrl.pathname === "/health") {
    sendJson(response, 200, { status: "ok", service: "RHZYCODE MinIO compatibility service", manifestUrl: context.manifestUrl }, request.method === "HEAD");
    return;
  }
  if (requestUrl.pathname === "/manifest.json") {
    const upstream = await context.fetchImpl(context.manifestUrl, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!upstream.ok) throw new Error(`MinIO manifest returned HTTP ${upstream.status}.`);
    const manifest = await upstream.json();
    sendJson(response, 200, legacyManifest(manifest), request.method === "HEAD");
    return;
  }
  if (requestUrl.pathname === "/desktop/latest.yml") {
    redirect(response, `${context.windowsUrl}/latest.yml`);
    return;
  }
  const desktopFile = singleFile(requestUrl.pathname, "/desktop/");
  if (desktopFile) {
    redirect(response, `${context.windowsUrl}/${encodeURIComponent(desktopFile)}`);
    return;
  }
  const androidFile = singleFile(requestUrl.pathname, "/mobile/");
  if (androidFile) {
    redirect(response, `${context.androidUrl}/${encodeURIComponent(androidFile)}`);
    return;
  }
  sendJson(response, 404, { error: "not_found" }, request.method === "HEAD");
}

function legacyManifest(value) {
  const android = parseUpdateForPlatform(value, "android");
  const { platform: _platform, downloadUrl, ...metadata } = android;
  return {
    schemaVersion: 1,
    publishedAt: value.publishedAt,
    android: { ...metadata, apkUrl: downloadUrl },
  };
}

function singleFile(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const name = decodeURIComponent(pathname.slice(prefix.length));
  return name && !name.includes("/") && name !== "." && name !== ".." ? name : null;
}

function redirect(response, location) {
  response.statusCode = 302;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Location", location);
  response.end();
}

function sendJson(response, statusCode, value, headOnly = false) {
  if (response.headersSent) return;
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  response.statusCode = statusCode;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", body.length);
  if (headOnly) response.end();
  else response.end(body);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const config = loadConfig();
  const host = String(config.legacyServer?.host || "0.0.0.0");
  const port = Number(config.legacyServer?.port || 8791);
  const server = createLegacyUpdateServer({ config });
  server.listen(port, host, () => {
    console.log(`[appupdate] legacy compatibility service listening on ${host}:${port}`);
    console.log(`[appupdate] new clients access ${publicObjectUrl(config, `${config.objectPrefix}/${config.manifestFile}`)} directly`);
  });
}
