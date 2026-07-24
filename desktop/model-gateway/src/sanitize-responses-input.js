/**
 * Strip oversized binary payloads from Responses API request history before
 * proxying upstream. Codex app-server keeps image_generation_call.result as
 * inline base64 in rollout history (store:false full replay). Resending those
 * multi-MB blobs after a model switch commonly makes upstream return a generic
 * 502 "Upstream request failed", even when the prompt itself is tiny.
 */

const DEFAULT_MAX_INLINE_BINARY_CHARS = 4_096;

/**
 * @param {unknown} body
 * @param {{ maxInlineBinaryChars?: number }} [options]
 * @returns {{ body: any, strippedCount: number, strippedBytes: number }}
 */
export function sanitizeResponsesRequestBody(body, options = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { body, strippedCount: 0, strippedBytes: 0 };
  }

  const maxInlineBinaryChars = Math.max(
    0,
    Number(options.maxInlineBinaryChars ?? DEFAULT_MAX_INLINE_BINARY_CHARS) || DEFAULT_MAX_INLINE_BINARY_CHARS,
  );
  const stats = { strippedCount: 0, strippedBytes: 0 };

  if (!Object.prototype.hasOwnProperty.call(body, "input")) {
    return { body, strippedCount: 0, strippedBytes: 0 };
  }

  const input = sanitizeValue(body.input, maxInlineBinaryChars, stats);
  if (stats.strippedCount === 0) {
    return { body, strippedCount: 0, strippedBytes: 0 };
  }

  return {
    body: { ...body, input },
    strippedCount: stats.strippedCount,
    strippedBytes: stats.strippedBytes,
  };
}

function sanitizeValue(value, maxInlineBinaryChars, stats) {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const sanitized = sanitizeValue(entry, maxInlineBinaryChars, stats);
      if (sanitized !== entry) changed = true;
      return sanitized;
    });
    return changed ? next : value;
  }

  if (!value || typeof value !== "object") return value;

  if (value.type === "image_generation_call") {
    return sanitizeImageGenerationCall(value, maxInlineBinaryChars, stats);
  }

  let changed = false;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    const sanitized = sanitizeValue(child, maxInlineBinaryChars, stats);
    next[key] = sanitized;
    if (sanitized !== child) changed = true;
  }
  return changed ? next : value;
}

function sanitizeImageGenerationCall(item, maxInlineBinaryChars, stats) {
  if (typeof item.result !== "string") return item;
  if (!shouldStripInlineBinary(item.result, maxInlineBinaryChars)) return item;

  stats.strippedCount += 1;
  stats.strippedBytes += Buffer.byteLength(item.result, "utf8");

  const next = { ...item };
  delete next.result;
  // Keep a short marker so models still see that an image was produced.
  if (typeof next.revised_prompt === "string" && next.revised_prompt.trim()) {
    next.output = `[generated image omitted from history: ${truncate(next.revised_prompt.trim(), 240)}]`;
  } else {
    next.output = "[generated image omitted from history]";
  }
  return next;
}

function shouldStripInlineBinary(value, maxInlineBinaryChars) {
  if (value.length <= maxInlineBinaryChars) return false;
  if (value.startsWith("data:image/")) return true;
  // Raw base64 PNG/JPEG/GIF/WEBP payloads observed in Codex rollouts.
  if (/^iVBORw0KGgo/i.test(value) || /^\/9j\//.test(value) || /^R0lGOD/i.test(value) || /^UklGR/.test(value)) {
    return true;
  }
  // Long base64-looking blobs without meaningful structure.
  if (value.length >= Math.max(maxInlineBinaryChars, 8_192) && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
    return true;
  }
  return false;
}

function truncate(value, maxChars) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}...`;
}