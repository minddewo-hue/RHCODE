#!/usr/bin/env node
import { loadDotEnv, loadGatewayConfig } from "./src/config.js";
import { createGatewayServer } from "./src/gateway.js";

loadDotEnv();

const HOST = process.env.HOST || "127.0.0.1";
const PORT = parsePort(process.env.PORT || "8787");

let config;
try {
  config = loadGatewayConfig();
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
