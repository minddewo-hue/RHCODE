import path from "node:path";
import { loadDotEnv, loadGatewayConfig } from "./config.js";
import { createGatewayServer } from "./gateway.js";
import { applyGemma31bModelPolicy } from "./gemma-31b-policy.js";

export async function startEmbeddedGateway(options) {
  const rootDir = path.resolve(options.rootDir);
  const host = options.host || "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const envPath = options.envPath || path.join(rootDir, ".env");

  loadDotEnv(envPath);
  const configuredPath = options.configPath || process.env.GATEWAY_CONFIG || "gateway.config.json";
  const configPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(rootDir, configuredPath);
  const config = loadGatewayConfig({ configPath });
  await discoverProviderModels(config, options.discoveryTimeoutMs ?? 5000);
  addAutomaticModelProtocolRoutes(config);
  if (config.models.size === 0) {
    throw new Error(
      "Gateway config has no models. Add model IDs to the provider or use an upstream that supports GET /models.",
    );
  }
  const server = createGatewayServer(config);
  const providers = [...config.providers.values()].map((provider) => ({
    id: provider.id,
    protocol: provider.protocol,
    health: {
      state: "unknown",
      latencyMs: null,
      checkedAt: null,
      httpStatus: null,
      circuitState: "closed",
      lastError: null,
    },
  }));

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Embedded gateway did not bind to a TCP address.");
  }

  let stopped = false;
  return {
    host,
    port: address.port,
    baseUrl: `http://${host}:${address.port}/v1`,
    configSource: config.source,
    providerCount: config.providers.size,
    modelCount: config.models.size,
    providers,
    models: [...config.models.values()].map((model) => ({
      id: model.id,
      ownedBy: model.ownedBy,
      capabilities: model.capabilities,
      providerId: model.routes[0].provider.id,
      upstreamModel: model.routes[0].upstreamModel,
      protocol: model.routes[0].protocol,
      contextWindow: model.contextWindow,
      runtimeInstructions: model.runtimeInstructions,
    })),
    async probeProviders(options = {}) {
      const timeoutMs = options.timeoutMs ?? 5000;
      const results = await Promise.all(
        [...config.providers.values()].map((provider) => probeProvider(provider, timeoutMs)),
      );
      const circuitHealth = server.gatewayHealth?.().providers || {};
      for (const result of results) {
        result.circuitState = circuitHealth[result.id]?.status === "degraded" ? "open" : "closed";
        const target = providers.find((provider) => provider.id === result.id);
        if (target) target.health = {
          state: result.state,
          latencyMs: result.latencyMs,
          checkedAt: result.checkedAt,
          httpStatus: result.httpStatus,
          circuitState: result.circuitState,
          lastError: result.lastError,
        };
      }
      return providers;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function discoverProviderModels(config, timeoutMs) {
  await Promise.all([...config.providers.values()].map(async (provider) => {
    if (!provider.modelDiscovery) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetch(`${provider.baseUrl}/models`, {
        headers: providerRequestHeaders(provider),
        signal: controller.signal,
      });
      if (!response.ok) return;
      const body = await response.json();
      for (const item of Array.isArray(body?.data) ? body.data : []) {
        const upstreamModel = typeof item?.id === "string" ? item.id.trim() : "";
        if (!upstreamModel || hasProviderRoute(config, provider.id, upstreamModel)) continue;
        const rule = provider.modelDiscovery.rules.find((candidate) => candidate.pattern.test(upstreamModel));
        const publicId = `${rule?.prefix || provider.modelDiscovery.prefix}${upstreamModel}`;
        if (config.disabledModels.has(publicId)) continue;
        if (config.models.has(publicId)) continue;
        config.models.set(publicId, {
          id: publicId,
          object: "model",
          created: Number.isInteger(item.created) ? item.created : 0,
          ownedBy: rule?.ownedBy || provider.modelDiscovery.ownedBy,
          contextWindow: null,
          maxOutputTokens: null,
          capabilities: {},
          forceSerialToolCalls: false,
          bufferChatStream: false,
          preOutputRetries: 0,
          maxBufferedStreamBytes: 8 * 1024 * 1024,
          runtimeInstructions: null,
          routes: [{
            key: `${provider.id}\u0000${upstreamModel}\u0000${provider.protocol}`,
            provider,
            upstreamModel,
            protocol: provider.protocol,
            path: provider.path,
            protocolExplicit: false,
          }],
        });
      }
    } catch {
      // The configured catalog remains available when discovery is offline.
    } finally {
      clearTimeout(timeout);
    }
  }));
}

function addAutomaticModelProtocolRoutes(config) {
  for (const model of config.models.values()) {
    const routes = model.routes.flatMap((route) => {
      if (!route.provider.modelDiscovery?.detectProtocol || route.protocolExplicit) return [route];
      const protocols = [
        route.protocol,
        ...["responses", "chat_completions", "anthropic_messages"].filter(
          (protocol) => protocol !== route.protocol,
        ),
      ];
      return protocols.map((protocol) => ({
        ...route,
        key: `${route.provider.id}\u0000${route.upstreamModel}\u0000${protocol}`,
        protocol,
        path: endpointPath(protocol),
      }));
    });
    model.routes = routes.filter((route, index) =>
      routes.findIndex((candidate) => candidate.key === route.key) === index);
    applyGemma31bModelPolicy(model);
  }
}

function endpointPath(protocol) {
  if (protocol === "responses") return "/responses";
  if (protocol === "anthropic_messages") return "/messages";
  return "/chat/completions";
}

function hasProviderRoute(config, providerId, upstreamModel) {
  return [...config.models.values()].some((model) =>
    model.routes.some((route) => route.provider.id === providerId && route.upstreamModel === upstreamModel));
}

async function probeProvider(provider, timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(`${provider.baseUrl}/models`, {
      method: "GET",
      headers: providerRequestHeaders(provider),
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    const healthy = response.ok;
    return {
      id: provider.id,
      state: healthy ? "healthy" : "degraded",
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      httpStatus: response.status,
      circuitState: "closed",
      lastError: healthy ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      id: provider.id,
      state: "degraded",
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      httpStatus: null,
      circuitState: "closed",
      lastError: timedOut ? `Timed out after ${timeoutMs} ms` : sanitizeProbeError(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function providerRequestHeaders(provider, protocol = provider.protocol) {
  if (!provider.apiKey) return {};
  if (protocol === "anthropic_messages") {
    return {
      authorization: `Bearer ${provider.apiKey}`,
      "x-api-key": provider.apiKey,
      "anthropic-version": provider.anthropicVersion,
    };
  }
  return { authorization: `Bearer ${provider.apiKey}` };
}

function sanitizeProbeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/gi, "upstream").slice(0, 240) || "Provider probe failed";
}
