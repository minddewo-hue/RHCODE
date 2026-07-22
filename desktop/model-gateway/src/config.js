import fs from "node:fs";
import path from "node:path";

const SUPPORTED_PROTOCOLS = new Set(["responses", "chat_completions", "anthropic_messages"]);

export function loadDotEnv(filePath = ".env") {
  if (!fs.existsSync(filePath)) return;

  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index <= 0) continue;

    const key = trimmed.slice(0, index).trim();
    if (process.env[key] != null) continue;

    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function loadGatewayConfig(options = {}) {
  const configPath = path.resolve(
    options.configPath || process.env.GATEWAY_CONFIG || "gateway.config.json",
  );
  const raw = fs.existsSync(configPath)
    ? parseConfigFile(configPath)
    : makeLegacyConfig();

  return normalizeConfig(raw, {
    source: fs.existsSync(configPath) ? configPath : "legacy environment variables",
    legacy: !fs.existsSync(configPath),
  });
}

function parseConfigFile(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to load gateway config ${configPath}: ${error.message}`);
  }
}

function makeLegacyConfig() {
  const publicModel = process.env.UPSTREAM_MODEL || "chat-model";
  return {
    providers: {
      legacy: {
        base_url: process.env.UPSTREAM_BASE_URL || "https://model.rhzy.ai/v1",
        protocol: "responses",
        path: process.env.UPSTREAM_RESPONSES_PATH || "/responses",
        api_key_env: process.env.UPSTREAM_API_KEY ? "UPSTREAM_API_KEY" : undefined,
        forward_client_authorization: !process.env.UPSTREAM_API_KEY,
      },
    },
    models: {
      [publicModel]: {
        provider: "legacy",
        upstream_model: publicModel,
      },
    },
  };
}

function normalizeConfig(raw, meta) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Gateway config must be a JSON object.");
  }

  const declaredProviders = new Map();
  for (const [id, value] of Object.entries(raw.providers || {})) {
    declaredProviders.set(id, normalizeProvider(id, value));
  }
  if (declaredProviders.size === 0) throw new Error("Gateway config has no providers.");

  const providers = new Map(
    [...declaredProviders].filter(([, provider]) => provider.credentialAvailable),
  );
  if (providers.size === 0) {
    const credentialNames = [...declaredProviders.values()]
      .map((provider) => provider.apiKeyEnv)
      .filter(Boolean);
    const requirement = credentialNames.length > 0
      ? ` Configure at least one provider credential: ${credentialNames.join(", ")}.`
      : "";
    throw new Error(`Gateway config has no available providers.${requirement}`);
  }

  const models = new Map();
  for (const [id, value] of Object.entries(raw.models || {})) {
    const model = normalizeModel(id, value, declaredProviders);
    if (model) models.set(id, model);
  }
  const disabledModels = normalizeDisabledModels(raw.disabled_models);
  for (const id of disabledModels.keys()) models.delete(id);
  const access = normalizeAccess(raw.access);
  if (access.length === 0 && process.env.PROXY_API_KEY) {
    access.push({ source: "PROXY_API_KEY", key: process.env.PROXY_API_KEY, models: ["*"] });
  }

  return {
    source: meta.source,
    legacy: meta.legacy,
    providers,
    models,
    disabledModels,
    access,
    authEnabled: access.length > 0,
    bodyLimit: parseByteSize(process.env.REQUEST_BODY_LIMIT || raw.request_body_limit || "50mb"),
    timeoutMs: parsePositiveInteger(
      process.env.UPSTREAM_TIMEOUT_MS || raw.upstream_timeout_ms || 600000,
      "upstream_timeout_ms",
    ),
    circuit: {
      failureThreshold: parsePositiveInteger(
        raw.circuit_breaker?.failure_threshold || 3,
        "circuit_breaker.failure_threshold",
      ),
      cooldownMs: parsePositiveInteger(
        raw.circuit_breaker?.cooldown_ms || 30000,
        "circuit_breaker.cooldown_ms",
      ),
    },
    stickyTtlMs: parsePositiveInteger(raw.sticky_ttl_ms || 3600000, "sticky_ttl_ms"),
    logLevel: process.env.LOG_LEVEL || raw.log_level || "info",
  };
}

function normalizeDisabledModels(value) {
  if (value == null) return new Map();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gateway disabled_models must be an object.");
  }

  const result = new Map();
  for (const [id, metadata] of Object.entries(value)) {
    if (!id.trim()) throw new Error("A disabled model requires a non-empty id.");
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error(`Disabled model ${id} must contain metadata.`);
    }
    const reason = String(metadata.reason || "").trim();
    if (!reason) throw new Error(`Disabled model ${id} requires a reason.`);
    result.set(id, {
      reason,
      verifiedAt: metadata.verified_at ? String(metadata.verified_at) : null,
    });
  }
  return result;
}

function normalizeProvider(id, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Provider ${id} must be an object.`);
  }
  if (value.api_key != null) {
    throw new Error(`Provider ${id} contains api_key; use api_key_env instead.`);
  }

  const protocol = value.protocol;
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new Error(
      `Provider ${id} has unsupported protocol ${JSON.stringify(protocol)}. ` +
        "Supported protocols: responses, chat_completions, anthropic_messages.",
    );
  }

  let baseUrl;
  try {
    baseUrl = new URL(value.base_url);
  } catch {
    throw new Error(`Provider ${id} has an invalid base_url.`);
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error(`Provider ${id} base_url must use http or https.`);
  }

  const apiKeyEnv = value.api_key_env || "";
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv]?.trim() || "" : "";

  const defaultPath = protocol === "responses"
    ? "/responses"
    : protocol === "anthropic_messages"
      ? "/messages"
      : "/chat/completions";
  return {
    id,
    baseUrl: stripTrailingSlash(value.base_url),
    protocol,
    path: normalizeEndpointPath(value.path || defaultPath),
    apiKeyEnv,
    apiKey,
    credentialAvailable: !apiKeyEnv || Boolean(apiKey),
    forwardClientAuthorization: Boolean(value.forward_client_authorization),
    anthropicVersion: String(value.anthropic_version || "2023-06-01"),
    customToolBridges: normalizeCustomToolBridges(value.custom_tool_bridges, id),
    emptyResponseRetries: parseNonNegativeInteger(
      value.empty_response_retries ?? 0,
      `providers.${id}.empty_response_retries`,
    ),
    modelDiscovery: normalizeModelDiscovery(value.model_discovery, id),
    timeoutMs:
      value.timeout_ms == null
        ? null
        : parsePositiveInteger(value.timeout_ms, `providers.${id}.timeout_ms`),
  };
}

function normalizeCustomToolBridges(value, providerId) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Provider ${providerId} custom_tool_bridges must be an array.`);
  }
  return value.map((name) => {
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`Provider ${providerId} has an invalid custom tool bridge name.`);
    }
    return name;
  });
}

function normalizeModelDiscovery(value, providerId) {
  if (value == null || value === false) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Provider ${providerId} model_discovery must be an object.`);
  }
  const prefix = String(value.prefix || `${providerId}/`);
  const rules = (value.rules || []).map((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`Provider ${providerId} model_discovery rule ${index} must be an object.`);
    }
    try {
      return {
        pattern: new RegExp(String(rule.pattern)),
        prefix: String(rule.prefix || prefix),
        ownedBy: String(rule.owned_by || providerId),
      };
    } catch (error) {
      throw new Error(`Provider ${providerId} model_discovery rule ${index} has an invalid pattern: ${error.message}`);
    }
  });
  if (value.detect_protocol != null && typeof value.detect_protocol !== "boolean") {
    throw new Error(`Provider ${providerId} model_discovery.detect_protocol must be boolean.`);
  }
  return {
    prefix,
    ownedBy: String(value.owned_by || providerId),
    rules,
    detectProtocol: Boolean(value.detect_protocol),
  };
}

function normalizeModel(id, value, providers) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Model ${id} must be an object.`);
  }

  const primary = normalizeRoute(id, value, providers);
  const routes = [primary];
  for (const fallback of value.fallbacks || []) {
    routes.push(normalizeRoute(id, fallback, providers));
  }

  const routeKeys = new Set();
  for (const route of routes) {
    if (routeKeys.has(route.key)) throw new Error(`Model ${id} contains a duplicate route ${route.key}.`);
    routeKeys.add(route.key);
  }
  const availableRoutes = routes.filter((route) => route.provider.credentialAvailable);

  const capabilities = normalizeCapabilities(value.capabilities);
  if (value.force_serial_tool_calls != null && typeof value.force_serial_tool_calls !== "boolean") {
    throw new Error(`Model ${id} force_serial_tool_calls must be boolean.`);
  }
  if (value.buffer_chat_stream != null && typeof value.buffer_chat_stream !== "boolean") {
    throw new Error(`Model ${id} buffer_chat_stream must be boolean.`);
  }
  if (value.runtime_instructions != null && typeof value.runtime_instructions !== "string") {
    throw new Error(`Model ${id} runtime_instructions must be a string.`);
  }
  if (availableRoutes.length === 0) return null;
  return {
    id,
    object: "model",
    created: Number.isInteger(value.created) ? value.created : 0,
    ownedBy: value.owned_by || availableRoutes[0].provider.id,
    contextWindow: optionalPositiveInteger(value.context_window, `models.${id}.context_window`),
    maxContextWindow: optionalPositiveInteger(
      value.max_context_window,
      `models.${id}.max_context_window`,
    ),
    effectiveContextWindowPercent: optionalPositiveInteger(
      value.effective_context_window_percent,
      `models.${id}.effective_context_window_percent`,
    ) || 90,
    contextWindowSource: value.context_window ? "gateway_config" : null,
    maxOutputTokens: optionalPositiveInteger(
      value.max_output_tokens,
      `models.${id}.max_output_tokens`,
    ),
    capabilities,
    forceSerialToolCalls: Boolean(value.force_serial_tool_calls),
    bufferChatStream: Boolean(value.buffer_chat_stream),
    preOutputRetries: parseNonNegativeInteger(
      value.pre_output_retries ?? 0,
      `models.${id}.pre_output_retries`,
    ),
    maxBufferedStreamBytes: parseByteSize(value.max_buffered_stream_size || "8mb"),
    runtimeInstructions: value.runtime_instructions?.trim() || null,
    routes: availableRoutes,
  };
}

function normalizeRoute(modelId, value, providers) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`A route for model ${modelId} must be an object.`);
  }
  const provider = providers.get(value.provider);
  if (!provider) throw new Error(`Model ${modelId} references unknown provider ${value.provider}.`);

  const upstreamModel = value.upstream_model;
  if (typeof upstreamModel !== "string" || !upstreamModel.trim()) {
    throw new Error(`Model ${modelId} requires a non-empty upstream_model.`);
  }
  const protocol = value.protocol || provider.protocol;
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new Error(
      `Model ${modelId} has unsupported route protocol ${JSON.stringify(protocol)}. ` +
        "Supported protocols: responses, chat_completions, anthropic_messages.",
    );
  }
  const defaultPath = protocol === "responses"
    ? "/responses"
    : protocol === "anthropic_messages"
      ? "/messages"
      : "/chat/completions";
  const routePath = value.path || (protocol === provider.protocol ? provider.path : defaultPath);
  return {
    key: `${provider.id}\u0000${upstreamModel}\u0000${protocol}`,
    provider,
    upstreamModel,
    protocol,
    path: normalizeEndpointPath(routePath),
    protocolExplicit: value.protocol != null,
  };
}

function normalizeCapabilities(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model capabilities must be an object.");
  }
  const keys = [
    "function_tools",
    "parallel_tool_calls",
    "image_input",
    "reasoning",
    "streaming",
  ];
  const result = {};
  for (const key of keys) {
    if (value[key] != null && typeof value[key] !== "boolean") {
      throw new Error(`Model capability ${key} must be boolean.`);
    }
    if (value[key] != null) result[key] = value[key];
  }
  return result;
}

function normalizeAccess(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("Gateway access must be an array.");

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Access entry ${index} must be an object.`);
    }
    if (entry.api_key != null) {
      throw new Error(`Access entry ${index} contains api_key; use api_key_env instead.`);
    }
    const source = entry.api_key_env;
    if (!source || !process.env[source]) {
      throw new Error(`Access entry ${index} requires missing environment variable ${source || "<empty>"}.`);
    }
    if (!Array.isArray(entry.models) || entry.models.length === 0) {
      throw new Error(`Access entry ${index} requires at least one model pattern.`);
    }
    return {
      source,
      key: process.env[source],
      models: entry.models.map((pattern) => String(pattern)),
    };
  });
}

function normalizeEndpointPath(value) {
  const pathValue = String(value);
  return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function optionalPositiveInteger(value, label) {
  return value == null ? null : parsePositiveInteger(value, label);
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function parseByteSize(value) {
  const match = /^(\d+)(b|kb|mb)?$/i.exec(String(value).trim());
  if (!match) throw new Error(`Invalid request_body_limit: ${value}`);

  const amount = Number.parseInt(match[1], 10);
  const unit = (match[2] || "b").toLowerCase();
  if (unit === "kb") return amount * 1024;
  if (unit === "mb") return amount * 1024 * 1024;
  return amount;
}
