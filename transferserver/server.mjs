import { constants as cryptoConstants } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createTransferServer } from "./app.mjs";

export async function startTransferServer(env = process.env) {
  const { host, port, trustProxy, requireTls, allowPublicHttp, https } = resolveTransferServerConfig(env);
  const { app } = await createTransferServer({
    trustProxy,
    requireTls: requireTls || Boolean(https),
    ...(https ? { https } : {}),
  });
  await app.listen({ host, port });
  console.log(`[transferserver] listening on ${host}:${port} (${https ? "TLS" : trustProxy ? "trusted proxy" : allowPublicHttp ? "public HTTP" : "local development"})`);
  return app;
}

export function resolveTransferServerConfig(env = process.env) {
  const host = String(env.RHZYCODE_TRANSFER_HOST || "0.0.0.0");
  const port = Number(env.RHZYCODE_TRANSFER_PORT || 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("RHZYCODE_TRANSFER_PORT is invalid.");
  const trustProxy = env.RHZYCODE_TRANSFER_TRUST_PROXY === "1";
  const requireTls = env.RHZYCODE_TRANSFER_REQUIRE_TLS !== "0";
  const allowPublicHttp = env.RHZYCODE_TRANSFER_ALLOW_PUBLIC_HTTP === "1";
  const https = loadHttpsOptions(env);
  validateNetworkBoundary({ host, trustProxy, requireTls, allowPublicHttp, hasNativeTls: Boolean(https) });
  if ((requireTls || trustProxy || allowPublicHttp || https) && !String(env.RHZYCODE_TRANSFER_ALLOWED_HOSTS || "").trim()) {
    throw new Error("RHZYCODE_TRANSFER_ALLOWED_HOSTS is required for a production listener.");
  }
  return { host, port, trustProxy, requireTls, allowPublicHttp, https };
}

function loadHttpsOptions(env) {
  const certPath = String(env.RHZYCODE_TRANSFER_TLS_CERT || "").trim();
  const keyPath = String(env.RHZYCODE_TRANSFER_TLS_KEY || "").trim();
  const caPath = String(env.RHZYCODE_TRANSFER_TLS_CA || "").trim();
  if (!certPath && !keyPath && !caPath) return null;
  if (!certPath || !keyPath) {
    throw new Error("RHZYCODE_TRANSFER_TLS_CERT and RHZYCODE_TRANSFER_TLS_KEY must be configured together.");
  }
  assertPrivateKeyPermissions(keyPath);
  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
    ...(caPath ? { ca: fs.readFileSync(caPath) } : {}),
    minVersion: "TLSv1.2",
    honorCipherOrder: true,
    secureOptions: cryptoConstants.SSL_OP_NO_COMPRESSION | cryptoConstants.SSL_OP_NO_RENEGOTIATION,
  };
}

function validateNetworkBoundary({ host, trustProxy, requireTls, allowPublicHttp, hasNativeTls }) {
  const loopback = isLoopbackHost(host);
  if (trustProxy && hasNativeTls) throw new Error("Choose native TLS or trusted-proxy mode, not both.");
  if (trustProxy && !loopback) {
    throw new Error("Trusted-proxy mode must bind RHZYCODE_TRANSFER_HOST to 127.0.0.1 or ::1.");
  }
  if (hasNativeTls) return;
  if (trustProxy) return;
  if (requireTls) {
    throw new Error("TLS is required: configure a certificate/key or bind to loopback behind a trusted reverse proxy.");
  }
  if (!loopback && !allowPublicHttp) {
    throw new Error("Public plain HTTP requires RHZYCODE_TRANSFER_ALLOW_PUBLIC_HTTP=1.");
  }
}

function assertPrivateKeyPermissions(keyPath) {
  if (process.platform === "win32") return;
  const mode = fs.statSync(keyPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error("The TLS private key must not be readable or writable by group/other users (use chmod 600). ");
  }
}

function isLoopbackHost(host) {
  const normalized = String(host).trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function installShutdownHandlers(app) {
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    app.close().then(() => {
      clearTimeout(forceExit);
      process.exit(0);
    }).catch(() => process.exit(1));
    console.log(`[transferserver] received ${signal}; shutting down`);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  startTransferServer().then(installShutdownHandlers).catch((error) => {
    console.error(`[transferserver] startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
