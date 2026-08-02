import { parseUpdateManifest } from "@rhzycode/update-contract";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_UPDATE_MANIFEST_BYTES = 256 * 1024;

export const defaultUpdatesDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "updates");

export function registerUpdateRoutes(app, { updatesDirectory, allowRequest }) {
  app.get("/v1/updates/manifest", async (request, reply) => {
    if (!allowRequest(request)) return reply.code(429).send({ error: "rate_limited" });
    try {
      const manifest = await readUpdateManifest(updatesDirectory);
      reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
      return manifest;
    } catch {
      return reply.code(502).send({ error: "invalid_update_manifest" });
    }
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/updates/*",
    handler: (request, reply) => serveUpdateArtifact(updatesDirectory, request, reply),
  });
}

async function readUpdateManifest(updatesDirectory) {
  const manifestPath = path.join(updatesDirectory, "version.json");
  const stat = await fs.promises.lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_UPDATE_MANIFEST_BYTES) {
    throw new Error("Update manifest is invalid.");
  }
  return parseUpdateManifest(JSON.parse(await fs.promises.readFile(manifestPath, "utf8")));
}

async function serveUpdateArtifact(updatesDirectory, request, reply) {
  const relativePath = String(request.params["*"] || "");
  const artifactPath = safeUpdateArtifactPath(updatesDirectory, relativePath);
  if (!artifactPath) return reply.code(404).send({ error: "not_found" });
  try {
    const [rootPath, resolvedPath, stat] = await Promise.all([
      fs.promises.realpath(updatesDirectory),
      fs.promises.realpath(artifactPath),
      fs.promises.lstat(artifactPath),
    ]);
    if (!resolvedPath.startsWith(`${rootPath}${path.sep}`) || !stat.isFile() || stat.isSymbolicLink()) {
      return reply.code(404).send({ error: "not_found" });
    }
    const range = parseByteRange(request.headers.range, stat.size);
    if (request.headers.range && !range) {
      reply.header("Content-Range", `bytes */${stat.size}`);
      return reply.code(416).send();
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? stat.size - 1;
    const length = end - start + 1;
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", updateContentType(resolvedPath));
    reply.header("Content-Length", String(length));
    reply.header("Cache-Control", isMutableUpdateFile(relativePath)
      ? "no-cache, no-store, must-revalidate"
      : "public, max-age=31536000, immutable");
    if (range) {
      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    }
    if (request.method === "HEAD") return reply.send();
    return reply.send(fs.createReadStream(resolvedPath, { start, end }));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return reply.code(404).send({ error: "not_found" });
    return reply.code(500).send({ error: "update_artifact_unavailable" });
  }
}

function safeUpdateArtifactPath(updatesDirectory, value) {
  if (!value || value.length > 1_024 || /[\\\0]/.test(value)) return null;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) return null;
  if (!/\.(?:apk|exe|blockmap|ya?ml|json|dmg|zip)$/i.test(segments.at(-1))) return null;
  const resolved = path.resolve(updatesDirectory, ...segments);
  return resolved.startsWith(`${path.resolve(updatesDirectory)}${path.sep}`) ? resolved : null;
}

function parseByteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!match || (!match[1] && !match[2]) || size < 1) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function isMutableUpdateFile(value) {
  return /(?:^|\/)(?:version\.json|latest(?:-mac)?\.ya?ml)$/i.test(value);
}

function updateContentType(value) {
  if (/\.apk$/i.test(value)) return "application/vnd.android.package-archive";
  if (/\.json$/i.test(value)) return "application/json; charset=utf-8";
  if (/\.ya?ml$/i.test(value)) return "application/yaml; charset=utf-8";
  if (/\.dmg$/i.test(value)) return "application/x-apple-diskimage";
  if (/\.zip$/i.test(value)) return "application/zip";
  return "application/octet-stream";
}
