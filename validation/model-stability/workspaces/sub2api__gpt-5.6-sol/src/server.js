import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");
const sourceRoot = path.join(root, "src");

export function resolveRequestPath(rawUrl) {
  const rawPath = String(rawUrl).split(/[?#]/, 1)[0];
  let decodedPath;
  try { decodedPath = decodeURIComponent(rawPath); }
  catch { return null; }
  if (decodedPath.split(/[\\/]/).includes("..")) return null;
  const pathname = decodeURIComponent(new URL(rawUrl, "http://localhost").pathname);
  if (pathname.includes("\0")) return null;
  if (pathname === "/") return path.join(publicRoot, "index.html");
  const base = pathname.startsWith("/src/") ? sourceRoot : publicRoot;
  const relative = pathname.startsWith("/src/") ? pathname.slice(5) : pathname.slice(1);
  const resolved = path.resolve(base, relative);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`) ? resolved : null;
}

export function createServer() {
  return http.createServer(async (request, response) => {
    try {
      const filePath = resolveRequestPath(request.url || "/");
      if (!filePath) return send(response, 403, "text/plain; charset=utf-8", "Forbidden");
      const body = await fs.readFile(filePath);
      send(response, 200, contentType(filePath), body);
    } catch (error) {
      send(response, error?.code === "ENOENT" ? 404 : 500, "text/plain; charset=utf-8", "Not found");
    }
  });
}

function send(response, status, type, body) {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  response.end(body);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 4178);
  createServer().listen(port, host, () => console.log(`算力趋势研判台: http://${host}:${port}`));
}
