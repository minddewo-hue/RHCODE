export type LlmProtocol = "responses" | "chat_completions" | "anthropic_messages";
export type LlmProtocolMode = "auto" | LlmProtocol;

export interface LlmProtocolDetection {
  baseUrl: string;
  protocol: LlmProtocol;
  endpoint: string;
}

const PROTOCOL_ENDPOINTS: Record<LlmProtocol, string> = {
  responses: "/responses",
  chat_completions: "/chat/completions",
  anthropic_messages: "/messages",
};

export function normalizeLlmBaseUrl(value: string): {
  baseUrl: string;
  hintedProtocol: LlmProtocol | null;
} {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Provider URL must be a valid HTTP or HTTPS URL.");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("Provider URL must use HTTP or HTTPS.");
  }
  url.search = "";
  url.hash = "";
  const pathname = url.pathname.replace(/\/+$/, "");
  const suffixes: Array<[RegExp, LlmProtocol]> = [
    [/\/chat\/completions$/i, "chat_completions"],
    [/\/responses$/i, "responses"],
    [/\/messages$/i, "anthropic_messages"],
  ];
  for (const [pattern, protocol] of suffixes) {
    if (!pattern.test(pathname)) continue;
    url.pathname = pathname.replace(pattern, "") || "/";
    return { baseUrl: url.toString().replace(/\/$/, ""), hintedProtocol: protocol };
  }
  url.pathname = pathname || "/";
  return { baseUrl: url.toString().replace(/\/$/, ""), hintedProtocol: null };
}

export async function detectLlmProtocol(
  input: { baseUrl: string; apiKey: string; protocol: LlmProtocolMode; timeoutMs?: number },
  fetcher: typeof fetch = fetch,
): Promise<LlmProtocolDetection> {
  const normalized = normalizeLlmBaseUrl(input.baseUrl);
  if (input.protocol !== "auto") {
    return {
      baseUrl: normalized.baseUrl,
      protocol: input.protocol,
      endpoint: `${normalized.baseUrl}${PROTOCOL_ENDPOINTS[input.protocol]}`,
    };
  }

  const baseUrls = [normalized.baseUrl];
  const parsed = new URL(normalized.baseUrl);
  if (!parsed.pathname || parsed.pathname === "/") baseUrls.push(`${normalized.baseUrl}/v1`);
  const priority: LlmProtocol[] = ["responses", "chat_completions", "anthropic_messages"];
  if (normalized.hintedProtocol) {
    priority.splice(priority.indexOf(normalized.hintedProtocol), 1);
    priority.unshift(normalized.hintedProtocol);
  }

  const failures: string[] = [];
  for (const baseUrl of baseUrls) {
    const results = await Promise.all(priority.map(async (protocol) => {
      const endpoint = `${baseUrl}${PROTOCOL_ENDPOINTS[protocol]}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 5000);
      timeout.unref?.();
      try {
        const response = await fetcher(endpoint, {
          method: "POST",
          headers: protocolHeaders(protocol, input.apiKey),
          body: JSON.stringify(protocolProbeBody(protocol)),
          signal: controller.signal,
        });
        const responseText = await response.text().catch(() => "");
        if (isSupportedEndpoint(response.status, responseText)) {
          return { baseUrl, protocol, endpoint };
        }
        failures.push(`${protocol}: HTTP ${response.status}`);
      } catch (error) {
        failures.push(`${protocol}: ${controller.signal.aborted ? "timeout" : safeError(error)}`);
      } finally {
        clearTimeout(timeout);
      }
      return null;
    }));
    const detected = results.find((result): result is LlmProtocolDetection => Boolean(result));
    if (detected) return detected;
  }

  throw new Error(
    `Could not detect a supported LLM protocol at ${normalized.baseUrl}. ` +
      `Checked Responses, Chat Completions, and Anthropic Messages (${failures.join(", ")}).`,
  );
}

export function protocolHeaders(protocol: LlmProtocol, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (protocol === "anthropic_messages") {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) headers["x-api-key"] = apiKey;
  }
  return headers;
}

function protocolProbeBody(protocol: LlmProtocol): Record<string, unknown> {
  if (protocol === "responses") {
    return { model: "__rhzycode_protocol_probe__", input: "probe", max_output_tokens: 1 };
  }
  if (protocol === "chat_completions") {
    return {
      model: "__rhzycode_protocol_probe__",
      messages: [{ role: "user", content: "probe" }],
      max_tokens: 1,
    };
  }
  return {
    model: "__rhzycode_protocol_probe__",
    messages: [{ role: "user", content: "probe" }],
    max_tokens: 1,
  };
}

function isSupportedEndpoint(status: number, body: string): boolean {
  if ([400, 402, 403, 409, 422, 429].includes(status)) return true;
  if (status >= 200 && status < 400) return true;
  if (status === 404) return /model|model_not_found|not_found_error/i.test(body);
  return false;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/gi, "upstream")
    .slice(0, 120);
}
