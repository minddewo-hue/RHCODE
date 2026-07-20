#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv, loadGatewayConfig } from "./src/config.js";
import { createGatewayServer } from "./src/gateway.js";

const gatewayRoot = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.dirname(gatewayRoot);
loadDotEnv(path.join(desktopRoot, ".env"));

const HOST = process.env.HOST || "127.0.0.1";
const PORT = parsePort(process.env.PORT || "8787");

let config;
try {
  const configuredPath = process.env.GATEWAY_CONFIG || "gateway.config.json";
  config = loadGatewayConfig({
    configPath: path.isAbsolute(configuredPath)
      ? configuredPath
      : path.join(gatewayRoot, configuredPath),
  });
} catch (error) {
  console.error(`Gateway configuration error: ${error.message}`);
  process.exitCode = 1;
  throw error;
}

const server = createGatewayServer(config);
server.listen(PORT, HOST, () => {
  console.log(`Codex multi-model gateway listening on http://${HOST}:${PORT}/v1`);
  console.log(
    `Loaded ${config.providers.size} provider(s) and ${config.models.size} model(s) from ${config.source}.`,
  );
  if (config.legacy) {
    console.log("Running in legacy single-provider mode; set GATEWAY_CONFIG to enable model routing.");
  }
});

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}
