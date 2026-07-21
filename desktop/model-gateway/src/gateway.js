import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  chatToResponse,
  makeResponseId,
  responsesToChatRequest,
  streamChatAsResponses,
} from "./chat-adapter.js";
import {
  anthropicToResponse,
  responsesToAnthropicRequest,
  streamAnthropicAsResponses,
} from "./anthropic-adapter.js";
import { applyGemma31bChatRequestPolicy } from "./gemma-31b-policy.js";

export function createGatewayServer(config) {
  const state = {
    circuits: new Map(),
    stickyResponses: new Map(),
    gammaTurns: new Map(),
  };

  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    res.setHeader("x-request-id", requestId);
    setCorsHeaders(res);

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const path = normalizePath(url.pathname);

      if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
        writeJson(res, 200, makeHealth(config, state));
        return;
      }

      if (req.method === "GET" && (path === "/models" || path === "/v1/models")) {
        const access = authorize(req, config);
        if (!access.authorized) throw unauthorizedError();
        writeJson(res, 200, makeModels(config, access));
        return;
      }

      if (req.method === "POST" && (path === "/responses" || path === "/v1/responses")) {
        const access = authorize(req, config);
        if (!access.authorized) throw unauthorizedError();
        const body = await readJsonBody(req, config.bodyLimit);
        await handleResponses({ req, res, body, requestId, startedAt, config, state, access });
        return;
      }

      throw new HttpError(404, `No route for ${req.method} ${path}`, "not_found");
    } catch (error) {
      const normalized = normalizeThrownError(error);
      log(config, normalized.status >= 500 ? "error" : "warn", {
        event: "request_failed",
        request_id: requestId,
        method: req.method,
        path: req.url,
        status: normalized.status,
        code: normalized.code,
        latency_ms: Date.now() - startedAt,
        message: normalized.status >= 500 ? normalized.message : undefined,
      });
      if (!res.headersSent) {
        if (normalized.status === 401) res.setHeader("WWW-Authenticate", "Bearer");
        writeJson(res, normalized.status, {
          error: {
            message: normalized.message,
            type: normalized.type,
            code: normalized.code,
          },
        });
      } else if (!res.writableEnded) {
        res.destroy(error instanceof Error ? error : undefined);
      }
    }
  });

  Object.defineProperty(server, "gatewayHealth", {
    value: () => makeHealth(config, state),
    enumerable: false,
  });

  return server;
}

async function handleResponses({
  req,
  res,
  body,
  requestId,
  startedAt,
  config,
  state,
  access,
}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.", "invalid_request");
  }
  if (typeof body.model !== "string" || !body.model) {
    throw new HttpError(400, "The model field is required.", "model_required");
  }

  const model = config.models.get(body.model);
  if (!model) throw new HttpError(404, `Model ${body.model} was not found.`, "model_not_found");
  if (!canUseModel(access, model.id)) {
    throw new HttpError(403, `Access to model ${model.id} is not allowed.`, "model_not_allowed");
  }
  if (model.forceSerialToolCalls && body.parallel_tool_calls !== false) {
    body = { ...body, parallel_tool_calls: false };
  }
  validateCapabilities(model, body);
  if (model.capabilities.parallel_tool_calls === false && body.parallel_tool_calls == null) {
    body = { ...body, parallel_tool_calls: false };
  }

  const routes = routesForRequest(model, body.previous_response_id, state, config);
  const selected = await selectUpstream({
    routes,
    model,
    body,
    req,
    res,
    requestId,
    config,
    state,
  });

  if (selected.error) {
    const upstreamMessage = extractUpstreamErrorMessage(selected.error.status, selected.error.body);
    writeNormalizedUpstreamError(res, selected.error.status, selected.error.body, selected.route.provider.id);
    log(config, "warn", {
      event: "upstream_rejected",
      request_id: requestId,
      provider: selected.route.provider.id,
      public_model: model.id,
      upstream_model: selected.route.upstreamModel,
      protocol: selected.route.protocol,
      status: selected.error.status,
      reason: upstreamMessage,
    });
    logRequest(config, {
      requestId,
      model,
      route: selected.route,
      status: selected.error.status,
      startedAt,
      streamed: Boolean(body.stream),
    });
    return;
  }

  if (selected.route.protocol === "responses") {
    if (body.stream) {
      await pipeNativeResponsesStream({
        selected,
        res,
        state,
        config,
        model,
        requestId,
        startedAt,
      });
      return;
    }

    rememberNativeResponse(selected.body, selected.route, model, state, config);
    copySafeResponseHeaders(selected.response, res, false);
    res.writeHead(selected.response.status);
    res.end(selected.body);
    selected.cleanup();
    logRequest(config, {
      requestId,
      model,
      route: selected.route,
      status: selected.response.status,
      startedAt,
      streamed: false,
    });
    return;
  }

  const responseId = makeResponseId();
  rememberResponse(responseId, selected.route, model, state, config, selected.gammaState);
  if (body.stream) {
    try {
      const streamAdapter = selected.route.protocol === "anthropic_messages"
        ? streamAnthropicAsResponses
        : streamChatAsResponses;
      await streamAdapter({
        reader: selected.reader,
        firstChunk: selected.firstChunk,
        clientRes: res,
        request: selected.responseRequest || body,
        responseId,
        publicModel: model.id,
        debugLog: (message) => log(config, "debug", { event: "chat_stream", message }),
        onComplete: () =>
          logRequest(config, {
            requestId,
            model,
            route: selected.route,
            status: 200,
            startedAt,
            streamed: true,
          }),
        onError: (error) =>
          log(config, "error", {
            event: "stream_interrupted",
            request_id: requestId,
            provider: selected.route.provider.id,
            public_model: model.id,
            message: sanitizeMessage(error?.message || String(error)),
          }),
      });
    } finally {
      selected.cleanup();
    }
    return;
  }

  try {
    const upstreamResponse = parseJson(
      selected.body.toString("utf8"),
      selected.route.protocol === "anthropic_messages"
        ? "upstream Anthropic response"
        : "upstream chat response",
    );
    const response = selected.route.protocol === "anthropic_messages"
      ? anthropicToResponse(selected.responseRequest || body, upstreamResponse, responseId, model.id)
      : chatToResponse(selected.responseRequest || body, upstreamResponse, responseId, model.id);
    writeJson(res, 200, response);
    logRequest(config, {
      requestId,
      model,
      route: selected.route,
      status: 200,
      startedAt,
      streamed: false,
      usage: response.usage,
    });
  } catch (error) {
    recordFailure(selected.route, state, config, 502);
    throw new HttpError(
      502,
      `Provider ${selected.route.provider.id} returned an invalid ${
        selected.route.protocol === "anthropic_messages"
          ? "Anthropic Messages"
          : "Chat Completions"
      } response.`,
      "invalid_upstream_response",
      { cause: error },
    );
  } finally {
    selected.cleanup();
  }
}

async function selectUpstream({ routes, model, body, req, res, requestId, config, state }) {
  const compatibleRoutes = routes.filter((route) => routeCanRepresentRequest(route, body));
  if (compatibleRoutes.length === 0) {
    const unsupported = routes
      .flatMap((route) => unsupportedRouteFeatures(route, body))
      .filter((value, index, values) => values.indexOf(value) === index);
    throw new HttpError(
      400,
      `The configured routes for model ${model.id} cannot represent this Responses request` +
        `${unsupported.length > 0 ? ` (${unsupported.join(", ")})` : ""}.`,
      "request_not_supported_by_route",
    );
  }
  const candidates = availableRoutes(compatibleRoutes, state);
  let lastFailure = null;
  const gammaState = model.bufferChatStream
    ? gammaStateForRequest(body, model, state, config)
    : null;

  routeLoop:
  for (let index = 0; index < candidates.length; index += 1) {
    const route = candidates[index];
    const provider = route.provider;
    const responseRequest = route.protocol !== "responses"
      ? withBridgedCustomTools(body, provider.customToolBridges)
      : body;
    let requestBody =
      route.protocol === "responses"
        ? { ...body, model: route.upstreamModel }
        : route.protocol === "anthropic_messages"
          ? responsesToAnthropicRequest(responseRequest, route.upstreamModel, (anthropic) =>
              log(config, "debug", {
                event: "anthropic_request",
                request_id: requestId,
                provider: provider.id,
                public_model: model.id,
                request: anthropic,
              }),
            )
          : responsesToChatRequest(responseRequest, route.upstreamModel);
    if (route.protocol === "chat_completions") {
      requestBody = applyGemma31bChatRequestPolicy(requestBody, route.upstreamModel);
      log(config, "debug", {
        event: "chat_request",
        request_id: requestId,
        provider: provider.id,
        public_model: model.id,
        request: requestBody,
      });
    }
    if (route.protocol === "chat_completions" && model.bufferChatStream) {
      updateGammaFailureState(requestBody.messages, gammaState);
      requestBody = withGammaToolResultFeedback(requestBody, gammaState);
    }

    let upstream;
    let preOutputAttempt = 0;
    let emptyResponseAttempt = 0;
    while (true) {
      try {
        upstream = await fetchRoute({ route, requestBody, req, res, requestId, config });
        if (!upstream.response.ok) {
          const errorBody = await readResponseBuffer(upstream.response);
          const status = upstream.response.status;
          const protocolMismatch = isProtocolRouteMismatch(status, errorBody);
          upstream.cleanup();
          upstream = null;
          if (isRetryableStatus(status) && preOutputAttempt < model.preOutputRetries) {
            preOutputAttempt += 1;
            logPreOutputRetry(config, requestId, model, route, status, preOutputAttempt);
            continue;
          }
          if ((isRetryableStatus(status) || protocolMismatch) && index < candidates.length - 1) {
            if (protocolMismatch) logProtocolFallback(config, requestId, model, route, status);
            else {
              recordFailure(route, state, config, status);
              logFailover(config, requestId, model, route, status);
            }
            lastFailure = { status, message: `Provider ${provider.id} returned HTTP ${status}.` };
            continue routeLoop;
          }
          if (status >= 500 || status === 408) recordFailure(route, state, config, status);
          else recordSuccess(route, state, status);
          return { error: { status, body: errorBody }, route };
        }

        if (body.stream) {
          const reader = upstream.response.body?.getReader();
          if (!reader) throw new Error("Upstream streaming response has no body.");
          const first = await reader.read();
          if (first.done || !first.value?.length) {
            await reader.cancel().catch(() => {});
            throw new Error("Upstream stream ended before its first byte.");
          }
          let firstChunk = first.value;
          if (route.protocol === "chat_completions" && model.bufferChatStream) {
            const buffered = await bufferAndValidateChatStream(
              reader,
              firstChunk,
              model.maxBufferedStreamBytes,
              blockedGammaCommands(requestBody.messages, gammaState),
            );
            if (!buffered.valid) {
              throw new Error(`Provider ${provider.id} returned an invalid buffered stream: ${buffered.reason}`);
            }
            firstChunk = buffered.firstChunk;
          } else if (route.protocol === "chat_completions" && provider.emptyResponseRetries > 0) {
            const probe = await probeChatStream(reader, firstChunk);
            if (!probe.meaningful) {
              await reader.cancel().catch(() => {});
              upstream.cleanup();
              upstream = null;
              if (emptyResponseAttempt < provider.emptyResponseRetries) {
                emptyResponseAttempt += 1;
                log(config, "warn", {
                  event: "empty_response_retry",
                  request_id: requestId,
                  provider: provider.id,
                  public_model: model.id,
                  upstream_model: route.upstreamModel,
                  attempt: emptyResponseAttempt,
                });
                continue;
              }
              throw new Error(`Provider ${provider.id} returned an empty streaming response.`);
            }
            firstChunk = probe.firstChunk;
          }
          recordSuccess(route, state, upstream.response.status);
          return { ...upstream, route, reader, firstChunk, responseRequest, gammaState };
        }

        const responseBody = await readResponseBuffer(upstream.response);
        recordSuccess(route, state, upstream.response.status);
        return { ...upstream, route, body: responseBody, responseRequest, gammaState };
      } catch (error) {
        upstream?.cleanup();
        upstream = null;
        if (
          route.protocol === "chat_completions" &&
          model.bufferChatStream &&
          body.stream &&
          isRepeatedGammaCommandError(error)
        ) {
          recordSuccess(route, state, 200);
          return makeGammaGuardSelection(route, responseRequest, gammaState);
        }
        const timedOut = error?.name === "AbortError" || error?.cause?.code === "UND_ERR_CONNECT_TIMEOUT";
        const status = timedOut ? 504 : 502;
        if (preOutputAttempt < model.preOutputRetries) {
          preOutputAttempt += 1;
          if (!timedOut && route.protocol === "chat_completions") {
            requestBody = withPreOutputRetryFeedback(requestBody, error);
          }
          logPreOutputRetry(config, requestId, model, route, status, preOutputAttempt, error);
          continue;
        }
        recordFailure(route, state, config, status);
        lastFailure = {
          status,
          message: timedOut
            ? `Provider ${provider.id} timed out before responding.`
            : sanitizeMessage(error?.message || `Provider ${provider.id} could not be reached.`),
        };
        if (index < candidates.length - 1) {
          logFailover(config, requestId, model, route, status);
          continue routeLoop;
        }
        break;
      }
    }
  }

  throw new HttpError(
    lastFailure?.status || 502,
    lastFailure?.message || `No route is currently available for model ${model.id}.`,
    lastFailure?.status === 504 ? "upstream_timeout" : "upstream_unavailable",
  );
}

function isRepeatedGammaCommandError(error) {
  return /identical shell command already returned a nonzero exit at least twice/i.test(
    error?.message || String(error),
  );
}

async function makeGammaGuardSelection(route, responseRequest, gammaState) {
  const id = `chatcmpl_gamma_guard_${randomUUID().replaceAll("-", "")}`;
  const content =
    "Gamma runtime stopped this turn because the same shell command already failed twice and the model attempted to replay it. Change the command or report the external blocker before continuing.";
  const stream = [
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const response = new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
  const reader = response.body.getReader();
  const first = await reader.read();
  return {
    response,
    cleanup: () => {},
    route,
    reader,
    firstChunk: first.value,
    responseRequest,
    gammaState,
  };
}

async function probeChatStream(reader, firstChunk) {
  const chunks = [Buffer.from(firstChunk)];
  let totalBytes = chunks[0].length;
  const probe = new ChatStreamProbe();
  probe.feed(firstChunk);

  while (!probe.meaningful && !probe.ended) {
    const next = await reader.read();
    if (next.done) {
      probe.finish();
      break;
    }
    chunks.push(Buffer.from(next.value));
    totalBytes += next.value.length;
    probe.feed(next.value);
    if (totalBytes > 1024 * 1024) {
      throw new Error("Upstream Chat stream exceeded the empty-response probe limit.");
    }
  }

  return {
    meaningful: probe.meaningful,
    firstChunk: Buffer.concat(chunks),
  };
}

async function bufferAndValidateChatStream(reader, firstChunk, maxBytes, blockedCommands = new Set()) {
  const chunks = [Buffer.from(firstChunk)];
  let totalBytes = chunks[0].length;
  const validator = new BufferedChatStreamValidator(blockedCommands);
  validator.feed(firstChunk);

  while (!validator.ended) {
    const next = await reader.read();
    if (next.done) {
      validator.finish();
      break;
    }
    chunks.push(Buffer.from(next.value));
    totalBytes += next.value.length;
    if (totalBytes > maxBytes) {
      throw new Error(`Buffered Chat stream exceeded ${maxBytes} bytes.`);
    }
    validator.feed(next.value);
  }

  if (validator.ended) await reader.cancel().catch(() => {});
  const validation = validator.validate();
  return {
    ...validation,
    firstChunk: Buffer.concat(chunks),
  };
}

function withPreOutputRetryFeedback(requestBody, error) {
  const marker = "[RHZY Gamma runtime retry]";
  const messages = (requestBody.messages || []).filter(
    (message) => !(message.role === "system" && String(message.content || "").startsWith(marker)),
  );
  messages.push({
    role: "system",
    content:
      `${marker} The previous draft was rejected before any tool executed: ` +
      `${sanitizeMessage(error?.message || String(error))}. ` +
      "Return one corrected tool call or a non-empty final response.",
  });
  return { ...requestBody, messages };
}

function withGammaToolResultFeedback(requestBody, gammaState = null) {
  const marker = "[RHZY Gamma tool result]";
  const messages = (requestBody.messages || []).filter(
    (message) => !(message.role === "system" && String(message.content || "").startsWith(marker)),
  );
  const timedOut = messages.some(
    (message) => message.role === "tool" && /(?:Exit code:\s*124|timed out)/i.test(String(message.content || "")),
  );
  const repeatedFailures = blockedGammaCommands(messages, gammaState);
  if (!timedOut && repeatedFailures.size === 0) return requestBody;
  const feedback = [];
  if (timedOut) {
    feedback.push(
      "A previous shell tool timed out with exit code 124. Do not repeat that command shape. Replace unbounded recursion with a narrow rg query, persist long inline scripts, and run potentially long processes with Start-Process before polling logs in a later short call.",
    );
  }
  if (repeatedFailures.size > 0) {
    feedback.push(
      "One or more identical shell commands already returned a nonzero exit at least twice. Do not issue those commands again; change the command or report the blocker.",
    );
  }
  messages.push({
    role: "system",
    content: `${marker} ${feedback.join(" ")}`,
  });
  return { ...requestBody, messages };
}

function repeatedFailedGammaCommands(messages = []) {
  const commandsByCall = new Map();
  const failureCounts = new Map();
  for (const message of messages) {
    for (const toolCall of message.role === "assistant" && Array.isArray(message.tool_calls)
      ? message.tool_calls
      : []) {
      if (toolCall.function?.name !== "shell_command") continue;
      try {
        const parsed = JSON.parse(toolCall.function.arguments || "{}");
        if (typeof parsed.command === "string" && parsed.command.trim()) {
          commandsByCall.set(toolCall.id, parsed.command);
        }
      } catch {
        // Malformed historical calls are handled by the stream validator.
      }
    }
    if (message.role !== "tool") continue;
    const command = commandsByCall.get(message.tool_call_id);
    if (!command) continue;
    const exit = /Exit code:\s*(-?\d+)/i.exec(String(message.content || ""));
    if (!exit) continue;
    if (Number(exit[1]) === 0) failureCounts.set(command, 0);
    else failureCounts.set(command, (failureCounts.get(command) || 0) + 1);
  }
  return new Set(
    [...failureCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([command]) => command),
  );
}

function blockedGammaCommands(messages = [], gammaState = null) {
  const blocked = repeatedFailedGammaCommands(messages);
  for (const [command, count] of gammaState?.failureCounts || []) {
    if (count >= 2) blocked.add(command);
  }
  return blocked;
}

function gammaStateForRequest(body, model, state, config) {
  pruneGammaTurns(state, config);
  const sticky = body.previous_response_id
    ? state.stickyResponses.get(body.previous_response_id)
    : null;
  if (sticky?.gammaState) return sticky.gammaState;
  const threadKey = findGammaThreadKey(body);
  if (threadKey && state.gammaTurns.has(threadKey)) return state.gammaTurns.get(threadKey);
  const gammaState = {
    modelId: model.id,
    commandsByCall: new Map(),
    failureCounts: new Map(),
    processedOutputs: new Set(),
    expiresAt: Date.now() + config.stickyTtlMs,
  };
  if (threadKey) state.gammaTurns.set(threadKey, gammaState);
  return gammaState;
}

function findGammaThreadKey(body) {
  for (const key of ["prompt_cache_key", "conversation_id", "thread_id", "session_id"]) {
    if (typeof body[key] === "string" && body[key]) return `${key}:${body[key]}`;
  }
  const turnId = findGammaTurnId(body.input);
  return turnId ? `turn_id:${turnId}` : null;
}

function findGammaTurnId(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findGammaTurnId(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const turnId = value.internal_chat_message_metadata_passthrough?.turn_id;
  if (typeof turnId === "string" && turnId) return turnId;
  for (const child of Object.values(value)) {
    const found = findGammaTurnId(child);
    if (found) return found;
  }
  return null;
}

function updateGammaFailureState(messages = [], gammaState) {
  if (!gammaState) return;
  gammaState.expiresAt = Date.now() + 60 * 60 * 1000;
  for (const message of messages) {
    for (const toolCall of message.role === "assistant" && Array.isArray(message.tool_calls)
      ? message.tool_calls
      : []) {
      if (toolCall.function?.name !== "shell_command") continue;
      try {
        const parsed = JSON.parse(toolCall.function.arguments || "{}");
        if (typeof parsed.command === "string" && parsed.command.trim()) {
          gammaState.commandsByCall.set(toolCall.id, parsed.command);
        }
      } catch {
        // The stream validator handles malformed current calls.
      }
    }
    if (message.role !== "tool" || gammaState.processedOutputs.has(message.tool_call_id)) continue;
    const command = gammaState.commandsByCall.get(message.tool_call_id);
    if (!command) continue;
    const exit = /Exit code:\s*(-?\d+)/i.exec(String(message.content || ""));
    if (!exit) continue;
    gammaState.processedOutputs.add(message.tool_call_id);
    if (Number(exit[1]) === 0) gammaState.failureCounts.delete(command);
    else gammaState.failureCounts.set(command, (gammaState.failureCounts.get(command) || 0) + 1);
  }
}

function pruneGammaTurns(state, config) {
  const now = Date.now();
  for (const [turnId, gammaState] of state.gammaTurns) {
    if (gammaState.expiresAt <= now) state.gammaTurns.delete(turnId);
  }
  const maxEntries = 1000;
  while (state.gammaTurns.size > maxEntries) {
    state.gammaTurns.delete(state.gammaTurns.keys().next().value);
  }
  for (const entry of state.stickyResponses.values()) {
    if (entry.gammaState) entry.gammaState.expiresAt ||= now + config.stickyTtlMs;
  }
}

function withBridgedCustomTools(body, bridgeNames = []) {
  if (bridgeNames.length === 0) return body;
  const tools = [...(body.tools || [])];
  const existing = new Set(tools.map((tool) => tool?.name).filter(Boolean));
  for (const name of bridgeNames) {
    if (existing.has(name)) continue;
    tools.push({
      type: "custom",
      name,
      description: name === "apply_patch"
        ? "Apply a file patch. Provide the complete patch envelope as input."
        : `Run the ${name} custom tool with freeform input.`,
      format: { type: "text" },
    });
  }
  return { ...body, tools, __chat_custom_tool_bridges: [...bridgeNames] };
}

function routeCanRepresentRequest(route, body) {
  return unsupportedRouteFeatures(route, body).length === 0;
}

function unsupportedRouteFeatures(route, body) {
  if (route.protocol === "responses") return [];
  const unsupported = [];
  const droppableChatToolTypes = new Set(["namespace", "web_search"]);
  const toolTypes = [
    ...new Set((body.tools || []).map((tool) => tool?.type || "unknown")),
  ].filter((type) => !["function", "custom"].includes(type) && !droppableChatToolTypes.has(type));
  if (toolTypes.length > 0) unsupported.push(`tool types: ${toolTypes.join("/")}`);
  if (hasFileImageInput(body.input)) unsupported.push("file image input");
  return unsupported;
}

async function fetchRoute({ route, requestBody, req, res, requestId, config }) {
  const provider = route.provider;
  const controller = new AbortController();
  const timeoutMs = provider.timeoutMs || config.timeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);

  const headers = {
    "Content-Type": "application/json",
    Accept: requestBody.stream ? "text/event-stream" : "application/json",
    "x-request-id": requestId,
  };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  else if (provider.forwardClientAuthorization && req.headers.authorization) {
    headers.Authorization = req.headers.authorization;
  }
  if (route.protocol === "anthropic_messages") {
    headers["anthropic-version"] = provider.anthropicVersion;
    if (provider.apiKey) headers["x-api-key"] = provider.apiKey;
  }

  const cleanup = () => {
    clearTimeout(timeout);
    req.off("aborted", abort);
    res.off("close", abort);
  };

  try {
    const response = await fetch(`${provider.baseUrl}${route.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    return { response, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function pipeNativeResponsesStream({
  selected,
  res,
  state,
  config,
  model,
  requestId,
  startedAt,
}) {
  const tracker = new ResponseIdTracker((responseId) => {
    rememberResponse(responseId, selected.route, model, state, config);
  });
  copySafeResponseHeaders(selected.response, res, true);
  res.writeHead(selected.response.status);

  try {
    tracker.feed(selected.firstChunk);
    res.write(selected.firstChunk);
    while (true) {
      const { value, done } = await selected.reader.read();
      if (done) break;
      tracker.feed(value);
      res.write(value);
    }
    tracker.finish();
    res.end();
    logRequest(config, {
      requestId,
      model,
      route: selected.route,
      status: selected.response.status,
      startedAt,
      streamed: true,
    });
  } catch (error) {
    log(config, "error", {
      event: "stream_interrupted",
      request_id: requestId,
      provider: selected.route.provider.id,
      public_model: model.id,
      message: sanitizeMessage(error?.message || String(error)),
    });
    res.destroy(error instanceof Error ? error : undefined);
  } finally {
    selected.cleanup();
  }
}

function routesForRequest(model, previousResponseId, state, config) {
  pruneStickyResponses(state, config);
  if (!previousResponseId) return model.routes;

  const sticky = state.stickyResponses.get(previousResponseId);
  if (!sticky) {
    if (model.routes.length === 1) return model.routes;
    throw new HttpError(
      409,
      "The route for previous_response_id is unknown or expired; retry without failover.",
      "previous_response_route_unknown",
    );
  }
  if (sticky.modelId !== model.id) {
    throw new HttpError(
      400,
      `previous_response_id belongs to model ${sticky.modelId}, not ${model.id}.`,
      "previous_response_model_mismatch",
    );
  }
  const route = model.routes.find((candidate) => candidate.key === sticky.routeKey);
  if (!route) {
    throw new HttpError(409, "The previous response route is no longer configured.", "route_changed");
  }
  return [route];
}

function availableRoutes(routes, state) {
  const now = Date.now();
  const available = routes.filter((route) => (state.circuits.get(route.key)?.openUntil || 0) <= now);
  if (available.length > 0) return available;

  return [...routes].sort(
    (a, b) =>
      (state.circuits.get(a.key)?.openUntil || 0) -
      (state.circuits.get(b.key)?.openUntil || 0),
  );
}

function recordFailure(route, state, config, status) {
  const current = state.circuits.get(route.key) || {
    providerId: route.provider.id,
    upstreamModel: route.upstreamModel,
    failures: 0,
    openUntil: 0,
  };
  current.failures += 1;
  current.lastStatus = status;
  current.lastCheckedAt = Date.now();
  if (current.failures >= config.circuit.failureThreshold) {
    current.openUntil = Date.now() + config.circuit.cooldownMs;
  }
  state.circuits.set(route.key, current);
}

function recordSuccess(route, state, status) {
  state.circuits.set(route.key, {
    providerId: route.provider.id,
    upstreamModel: route.upstreamModel,
    failures: 0,
    openUntil: 0,
    lastStatus: status,
    lastCheckedAt: Date.now(),
  });
}

function rememberNativeResponse(body, route, model, state, config) {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (typeof parsed.id === "string") rememberResponse(parsed.id, route, model, state, config);
  } catch {
    // Transparent Responses forwarding does not require a JSON body.
  }
}

function rememberResponse(responseId, route, model, state, config, gammaState = null) {
  if (!responseId) return;
  pruneStickyResponses(state, config);
  state.stickyResponses.set(responseId, {
    routeKey: route.key,
    modelId: model.id,
    expiresAt: Date.now() + config.stickyTtlMs,
    ...(gammaState ? { gammaState } : {}),
  });
}

function pruneStickyResponses(state, config) {
  const now = Date.now();
  for (const [id, entry] of state.stickyResponses) {
    if (entry.expiresAt <= now) state.stickyResponses.delete(id);
  }
  const maxEntries = 10000;
  while (state.stickyResponses.size > maxEntries) {
    state.stickyResponses.delete(state.stickyResponses.keys().next().value);
  }
}

function validateCapabilities(model, body) {
  const capabilities = model.capabilities;
  if (body.stream && capabilities.streaming === false) {
    throw new HttpError(400, `Model ${model.id} does not support streaming.`, "unsupported_streaming");
  }
  if ((body.tools || []).length > 0 && capabilities.function_tools === false) {
    throw new HttpError(400, `Model ${model.id} does not support function tools.`, "unsupported_tools");
  }
  if (body.parallel_tool_calls === true && capabilities.parallel_tool_calls === false) {
    throw new HttpError(
      400,
      `Model ${model.id} does not support parallel tool calls.`,
      "unsupported_parallel_tool_calls",
    );
  }
  if (body.reasoning != null && capabilities.reasoning === false) {
    throw new HttpError(400, `Model ${model.id} does not support reasoning options.`, "unsupported_reasoning");
  }
  if (hasImageInput(body.input) && capabilities.image_input === false) {
    throw new HttpError(400, `Model ${model.id} does not support image input.`, "unsupported_image_input");
  }
  if (model.maxOutputTokens && body.max_output_tokens > model.maxOutputTokens) {
    throw new HttpError(
      400,
      `max_output_tokens exceeds the ${model.maxOutputTokens} limit for model ${model.id}.`,
      "max_output_tokens_exceeded",
    );
  }
}

function hasImageInput(value) {
  if (Array.isArray(value)) return value.some(hasImageInput);
  if (!value || typeof value !== "object") return false;
  if (value.type === "input_image") return true;
  return Object.values(value).some(hasImageInput);
}

function hasFileImageInput(value) {
  if (Array.isArray(value)) return value.some(hasFileImageInput);
  if (!value || typeof value !== "object") return false;
  if (value.type === "input_image" && value.file_id && !value.image_url) return true;
  return Object.values(value).some(hasFileImageInput);
}

function authorize(req, config) {
  if (!config.authEnabled) return { authorized: true, policies: null };
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return { authorized: false, policies: [] };
  const key = auth.slice("Bearer ".length);
  const policies = config.access.filter((entry) => secureEqual(entry.key, key));
  return { authorized: policies.length > 0, policies };
}

function canUseModel(access, modelId) {
  if (!access.policies) return true;
  return access.policies.some((policy) => policy.models.some((pattern) => matchesModel(pattern, modelId)));
}

function matchesModel(pattern, modelId) {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return modelId.startsWith(pattern.slice(0, -1));
  return pattern === modelId;
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function makeModels(config, access) {
  return {
    object: "list",
    data: [...config.models.values()]
      .filter((model) => canUseModel(access, model.id))
      .map((model) => ({
        id: model.id,
        object: model.object,
        created: model.created,
        owned_by: model.ownedBy,
        ...(model.contextWindow ? { context_window: model.contextWindow } : {}),
        ...(model.maxOutputTokens ? { max_output_tokens: model.maxOutputTokens } : {}),
        capabilities: model.capabilities,
      })),
  };
}

function makeHealth(config, state) {
  const now = Date.now();
  const providers = {};
  for (const provider of config.providers.values()) {
    const routeStates = [...state.circuits.values()].filter((entry) => entry.providerId === provider.id);
    const open = routeStates.some((entry) => entry.openUntil > now);
    const latest = routeStates.sort((a, b) => (b.lastCheckedAt || 0) - (a.lastCheckedAt || 0))[0];
    providers[provider.id] = {
      protocol: provider.protocol,
      status: open ? "degraded" : latest ? "available" : "unknown",
      last_status: latest?.lastStatus ?? null,
      last_checked_at: latest?.lastCheckedAt
        ? new Date(latest.lastCheckedAt).toISOString()
        : null,
      retry_at: open
        ? new Date(Math.max(...routeStates.map((entry) => entry.openUntil || 0))).toISOString()
        : null,
    };
  }
  return {
    ok: true,
    mode: config.legacy ? "legacy" : "multi_provider",
    models: config.models.size,
    providers,
  };
}

function writeNormalizedUpstreamError(res, status, body, providerId) {
  const rawMessage = extractUpstreamErrorMessage(status, body);
  writeJson(res, status, {
    error: {
      message: `Provider ${providerId}: ${rawMessage}`,
      type: errorTypeForStatus(status),
      code: errorCodeForStatus(status),
    },
  });
}

function extractUpstreamErrorMessage(status, body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    parsed = null;
  }
  const upstreamError = parsed?.error;
  const rawMessage =
    (typeof upstreamError === "string" ? upstreamError : upstreamError?.message) ||
    parsed?.message ||
    formatValidationDetail(upstreamError?.detail || parsed?.detail) ||
    `HTTP ${status}`;
  return sanitizeMessage(rawMessage);
}

function formatValidationDetail(detail) {
  if (typeof detail === "string") return detail;
  if (!Array.isArray(detail)) return "";
  return detail.slice(0, 5).map((entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return "";
    const location = Array.isArray(entry.loc) ? entry.loc.map(String).join(".") : "";
    const message = typeof entry.msg === "string"
      ? entry.msg
      : typeof entry.message === "string" ? entry.message : "";
    return [location, message].filter(Boolean).join(": ");
  }).filter(Boolean).join("; ");
}

function errorTypeForStatus(status) {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

function errorCodeForStatus(status) {
  if (status === 401) return "upstream_unauthorized";
  if (status === 403) return "upstream_forbidden";
  if (status === 404) return "upstream_not_found";
  if (status === 429) return "upstream_rate_limited";
  if (status >= 500) return "upstream_server_error";
  return "upstream_error";
}

function sanitizeMessage(value) {
  return String(value)
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 1000);
}

function copySafeResponseHeaders(upstream, res, streaming) {
  const contentType = upstream.headers.get("content-type");
  if (contentType) res.setHeader("Content-Type", contentType);
  if (streaming) {
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
  }
}

async function readResponseBuffer(response) {
  return Buffer.from(await response.arrayBuffer());
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isProtocolRouteMismatch(status, body) {
  if (![400, 404, 405, 422].includes(status)) return false;
  const message = body.toString("utf8", 0, Math.min(body.length, 4096));
  return /request_not_supported_by_route|unsupported[^\n]{0,80}route|route[^\n]{0,80}not[^\n]{0,40}support/i.test(message);
}

function logProtocolFallback(config, requestId, model, route, status) {
  log(config, "info", {
    event: "model_protocol_fallback",
    request_id: requestId,
    provider: route.provider.id,
    public_model: model.id,
    upstream_model: route.upstreamModel,
    protocol: route.protocol,
    status,
  });
}

function logFailover(config, requestId, model, route, status) {
  log(config, "warn", {
    event: "route_failover",
    request_id: requestId,
    provider: route.provider.id,
    public_model: model.id,
    upstream_model: route.upstreamModel,
    status,
  });
}

function logPreOutputRetry(config, requestId, model, route, status, attempt, error) {
  log(config, "warn", {
    event: "model_pre_output_retry",
    request_id: requestId,
    provider: route.provider.id,
    public_model: model.id,
    upstream_model: route.upstreamModel,
    status,
    attempt,
    reason: error ? sanitizeMessage(error?.message || String(error)) : undefined,
  });
}

function logRequest(config, { requestId, model, route, status, startedAt, streamed, usage }) {
  log(config, "info", {
    event: "request_completed",
    request_id: requestId,
    provider: route.provider.id,
    public_model: model.id,
    upstream_model: route.upstreamModel,
    protocol: route.protocol,
    streamed,
    status,
    latency_ms: Date.now() - startedAt,
    ...(usage ? { usage } : {}),
  });
}

function log(config, level, fields) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  if ((order[level] || 20) < (order[config.logLevel] || 20)) return;
  const clean = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  console.error(JSON.stringify({ time: new Date().toISOString(), level, ...clean }));
}

async function readJsonBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      throw new HttpError(413, `Request body exceeds limit of ${limit} bytes.`, "request_too_large");
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HttpError(400, `Request body is not valid JSON: ${error.message}`, "invalid_json");
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse ${label} as JSON: ${error.message}`);
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function normalizePath(path) {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function unauthorizedError() {
  return new HttpError(401, "Missing or invalid gateway bearer token.", "unauthorized");
}

function normalizeThrownError(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(
    500,
    sanitizeMessage(error?.message || "Unexpected gateway error."),
    "gateway_error",
    { cause: error },
  );
}

class HttpError extends Error {
  constructor(status, message, code, options) {
    super(message, options);
    this.status = status;
    this.code = code;
    this.type = errorTypeForStatus(status);
  }
}

class ResponseIdTracker {
  constructor(onId) {
    this.onId = onId;
    this.decoder = new TextDecoder();
    this.buffer = "";
    this.seen = new Set();
  }

  feed(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let index;
    while ((index = this.buffer.indexOf("\n\n")) >= 0) {
      this.inspect(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + 2);
    }
  }

  finish() {
    this.buffer += this.decoder.decode();
    if (this.buffer.trim()) this.inspect(this.buffer);
  }

  inspect(frame) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);
      const id = parsed.response?.id || (parsed.object === "response" ? parsed.id : null);
      if (typeof id === "string" && !this.seen.has(id)) {
        this.seen.add(id);
        this.onId(id);
      }
    } catch {
      // Ignore non-JSON SSE frames while preserving their bytes for the client.
    }
  }
}

class ChatStreamProbe {
  constructor() {
    this.decoder = new TextDecoder();
    this.buffer = "";
    this.meaningful = false;
    this.ended = false;
  }

  feed(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let index;
    while ((index = this.buffer.indexOf("\n\n")) >= 0) {
      this.inspect(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + 2);
    }
  }

  finish() {
    this.buffer += this.decoder.decode();
    if (this.buffer.trim()) this.inspect(this.buffer);
    this.ended = true;
  }

  inspect(frame) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      this.ended = true;
      return;
    }
    try {
      const parsed = JSON.parse(data);
      this.meaningful ||= (parsed.choices || []).some((choice) => {
        const delta = choice.delta || choice.message || {};
        return (
          (typeof delta.content === "string" && delta.content.length > 0) ||
          (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) ||
          delta.function_call != null
        );
      });
    } catch {
      // Keep probing malformed or provider-specific metadata frames.
    }
  }
}

class BufferedChatStreamValidator {
  constructor(blockedCommands = new Set()) {
    this.decoder = new TextDecoder();
    this.buffer = "";
    this.ended = false;
    this.transportEnded = false;
    this.meaningful = false;
    this.invalidReason = null;
    this.toolStates = new Map();
    this.blockedCommands = blockedCommands;
  }

  feed(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    this.drainFrames();
  }

  finish() {
    this.buffer += this.decoder.decode();
    this.drainFrames();
    if (this.buffer.trim()) this.inspect(this.buffer);
    this.buffer = "";
    this.transportEnded = true;
    this.ended = true;
  }

  drainFrames() {
    let index;
    while ((index = this.buffer.indexOf("\n\n")) >= 0) {
      this.inspect(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + 2);
    }
  }

  inspect(frame) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      this.ended = true;
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      this.invalidReason ||= `malformed SSE JSON: ${error.message}`;
      return;
    }

    for (const choice of parsed.choices || []) {
      const delta = choice.delta || choice.message || {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        this.meaningful = true;
      }
      for (const toolCall of delta.tool_calls || []) {
        this.recordToolCall(toolCall.index ?? toolCall.id ?? this.toolStates.size, toolCall);
      }
      if (delta.function_call) this.recordToolCall(0, { function: delta.function_call });
    }
  }

  recordToolCall(key, toolCall) {
    this.meaningful = true;
    const normalizedKey = String(key);
    const state = this.toolStates.get(normalizedKey) || { name: "", arguments: "" };
    if (toolCall.function?.name) state.name = toolCall.function.name;
    if (typeof toolCall.function?.arguments === "string") {
      state.arguments += toolCall.function.arguments;
    }
    this.toolStates.set(normalizedKey, state);
  }

  validate() {
    if (this.invalidReason) return { valid: false, reason: this.invalidReason };
    if (!this.meaningful) return { valid: false, reason: "empty semantic output" };
    if (this.toolStates.size > 1) {
      return { valid: false, reason: "multiple tool calls violate the serial policy" };
    }
    for (const state of this.toolStates.values()) {
      if (!state.name) return { valid: false, reason: "tool call has no name" };
      if (!state.arguments.trim()) return { valid: false, reason: "tool call has no arguments" };
      try {
        const parsed = JSON.parse(state.arguments);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { valid: false, reason: `tool ${state.name} arguments are not a JSON object` };
        }
        if (state.name === "shell_command") {
          const shellReason = validateGammaShellCommand(parsed.command, this.blockedCommands);
          if (shellReason) return { valid: false, reason: shellReason };
        }
      } catch (error) {
        return { valid: false, reason: `tool ${state.name} arguments are incomplete: ${error.message}` };
      }
    }
    return { valid: true, reason: null };
  }
}

function validateGammaShellCommand(command, blockedCommands = new Set()) {
  if (typeof command !== "string" || !command.trim()) {
    return "shell_command has no command string";
  }
  if (blockedCommands.has(command)) {
    return "the identical shell command already returned a nonzero exit at least twice; change the command or report the blocker";
  }
  if (/\bGet-Content\b[^\r\n;|]*(?:\s-C(?:\s|$)|\s-Range(?:\s|$))/i.test(command)) {
    return "PowerShell Get-Content does not support -C or -Range";
  }
  if (/\bGet-ChildItem\b[^\r\n;|]*-Filter\s+[^\r\n;|]*,/i.test(command)) {
    return "PowerShell Get-ChildItem -Filter accepts only one pattern";
  }
  if (/\bGet-ChildItem\b[^\r\n;|]*\s-Recurse(?:\s|$)/i.test(command) && !/\bGet-ChildItem\b[^\r\n;|]*\s-Depth\s+\d+/i.test(command)) {
    return "unbounded Get-ChildItem -Recurse is not allowed; use a narrow rg --files query or a small -Depth";
  }
  if (/(?:^|[;&|]\s*)nl\s+/im.test(command)) {
    return "the Unix nl command is unavailable in Windows PowerShell";
  }
  const sleepDurations = [...command.matchAll(/\bStart-Sleep\b[^\r\n;|]*?(?:-Seconds\s+)?(\d+(?:\.\d+)?)/gi)]
    .map((match) => Number(match[1]));
  if (sleepDurations.some((seconds) => seconds > 3)) {
    return "Start-Sleep must not exceed 3 seconds in a bounded Gamma tool call";
  }
  if (/(?:^|\s)--listen(?:\s|$)/i.test(command)) {
    if (!/\bStart-Process\b/i.test(command)) {
      return "long-running --listen commands must use Start-Process without -Wait and be checked through later log polling; Start-Job and foreground redirection still block the tool";
    }
    if (/\bStart-Process\b[^\r\n;|]*\s-Wait(?:\s|$)/i.test(command)) {
      return "Start-Process for a --listen command must not use -Wait";
    }
    if (/\bStart-Sleep\b/i.test(command)) {
      return "start a --listen process and end the tool call immediately; sleep and poll logs in a later tool call";
    }
  }
  const lineCount = command.split(/\r?\n/).length;
  if (lineCount > 12 && /@['"]/i.test(command) && /\|\s*(?:&\s*)?(?:[^\s|]*[\\/])?python(?:\.exe)?(?:\s|$)/i.test(command)) {
    return "long multiline Python here-strings must be persisted as a script and run as a bounded command or with Start-Process";
  }
  return null;
}
