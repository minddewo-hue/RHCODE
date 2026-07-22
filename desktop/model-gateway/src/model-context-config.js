import fs from "node:fs";
import path from "node:path";

export const MODEL_CONTEXT_CONFIG_NAME = "model-context-windows.json";

export function loadModelContextConfig(rootDir, configPath) {
  const candidate = configPath || MODEL_CONTEXT_CONFIG_NAME;
  const resolvedPath = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(rootDir, candidate);
  if (!fs.existsSync(resolvedPath)) return null;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to load model context config ${resolvedPath}: ${error.message}`);
  }
  return normalizeModelContextConfig(raw, resolvedPath);
}

export function applyModelContextConfig(model, config) {
  if (!model || !config) return model;

  const candidates = [];
  for (const route of model.routes || []) {
    if (typeof route?.upstreamModel === "string") candidates.push(route.upstreamModel.trim());
  }
  if (typeof model.id === "string") {
    candidates.push(model.id.trim());
    const separator = model.id.indexOf("/");
    if (separator >= 0) candidates.push(model.id.slice(separator + 1).trim());
  }
  const key = candidates.find((candidate) => config.models.has(candidate));
  const entry = key ? config.models.get(key) : null;

  if (entry) {
    model.contextWindow = entry.contextWindow;
    model.maxContextWindow = entry.maxContextWindow;
    model.effectiveContextWindowPercent = entry.effectiveContextWindowPercent;
    model.contextWindowSource = entry.verification;
    return model;
  }

  if (!model.contextWindow) {
    model.contextWindow = config.default.contextWindow;
    model.maxContextWindow = config.default.maxContextWindow;
    model.effectiveContextWindowPercent = config.default.effectiveContextWindowPercent;
    model.contextWindowSource = config.default.verification;
  }
  return model;
}

function normalizeModelContextConfig(raw, source) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Model context config ${source} must be a JSON object.`);
  }
  if (raw.schema_version !== 1) {
    throw new Error(`Model context config ${source} has unsupported schema_version.`);
  }

  const defaultEntry = normalizeEntry(raw.default, `${source} default`);
  const models = new Map();
  for (const [id, value] of Object.entries(raw.models || {})) {
    const normalizedId = id.trim();
    if (!normalizedId) throw new Error(`Model context config ${source} contains an empty model id.`);
    models.set(normalizedId, normalizeEntry(value, `${source} model ${normalizedId}`));
  }
  return { source, default: defaultEntry, models };
}

function normalizeEntry(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const contextWindow = positiveInteger(value.context_window, `${label}.context_window`);
  const maxContextWindow = positiveInteger(
    value.max_context_window ?? contextWindow,
    `${label}.max_context_window`,
  );
  if (maxContextWindow < contextWindow) {
    throw new Error(`${label}.max_context_window cannot be smaller than context_window.`);
  }
  const effectiveContextWindowPercent = positiveInteger(
    value.effective_context_window_percent ?? 90,
    `${label}.effective_context_window_percent`,
  );
  if (effectiveContextWindowPercent > 100) {
    throw new Error(`${label}.effective_context_window_percent cannot exceed 100.`);
  }
  return {
    contextWindow,
    maxContextWindow,
    effectiveContextWindowPercent,
    verification: String(value.verification || "unspecified"),
  };
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}
