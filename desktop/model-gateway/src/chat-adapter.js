import { randomUUID } from "node:crypto";

export function responsesToChatRequest(request, upstreamModel, debugLog = () => {}) {
  const messages = [];

  if (request.instructions) {
    messages.push({ role: "system", content: contentToText(request.instructions) });
  }

  const input = Array.isArray(request.input) ? request.input : [request.input ?? ""];
  for (const item of input) appendInputItem(messages, item);

  const chat = {
    model: upstreamModel,
    messages,
    stream: Boolean(request.stream),
  };

  for (const key of [
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "stop",
    "seed",
    "user",
  ]) {
    copyIfPresent(request, chat, key);
  }

  if (request.max_output_tokens != null) chat.max_tokens = request.max_output_tokens;

  const tools = responsesToolsToChatTools(request.tools || []);
  if (tools.length > 0) {
    chat.tools = tools;
    copyIfPresent(request, chat, "parallel_tool_calls");
  }

  const toolChoice = responsesToolChoiceToChatToolChoice(request.tool_choice);
  if (toolChoice != null) chat.tool_choice = toolChoice;

  debugLog(redactForLog(chat));
  return chat;
}

export function chatToResponse(request, chatResponse, responseId, publicModel) {
  const choice = chatResponse.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];

  if (typeof message.content === "string" && message.content.length > 0) {
    output.push({
      id: `msg_${randomId()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: message.content, annotations: [] }],
    });
  }

  for (const toolCall of message.tool_calls || []) {
    output.push(chatToolCallToResponseItem(request, toolCall));
  }

  return makeResponseObject({
    request,
    responseId,
    publicModel,
    createdAt: chatResponse.created || nowSeconds(),
    status: "completed",
    output,
    usage: mapUsage(chatResponse.usage),
  });
}

export async function streamChatAsResponses({
  reader,
  firstChunk,
  clientRes,
  request,
  responseId,
  publicModel,
  onComplete,
  onError,
  debugLog = () => {},
}) {
  clientRes.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const startedAt = nowSeconds();
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let nextOutputIndex = 0;
  let textState = null;
  const toolStates = new Map();
  const customToolNames = getCustomToolNames(request);
  const bridgedToolNames = getBridgedToolNames(request);
  let completed = false;

  const baseResponse = makeResponseObject({
    request,
    responseId,
    publicModel,
    createdAt: startedAt,
    status: "in_progress",
    output: [],
    usage: null,
  });
  writeSse(clientRes, "response.created", { response: baseResponse });
  writeSse(clientRes, "response.in_progress", { response: baseResponse });

  const ensureTextState = () => {
    if (textState) return textState;
    const itemId = `msg_${randomId()}`;
    const outputIndex = nextOutputIndex++;
    const item = {
      id: itemId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    const part = { type: "output_text", text: "", annotations: [] };
    textState = { itemId, outputIndex, text: "", item, contentIndex: 0 };
    writeSse(clientRes, "response.output_item.added", { output_index: outputIndex, item });
    writeSse(clientRes, "response.content_part.added", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part,
    });
    return textState;
  };

  const ensureToolState = (toolCall) => {
    const key = String(toolCall.index ?? toolCall.id ?? toolStates.size);
    let state = toolStates.get(key);
    if (state) return state;

    const callId = toolCall.id || `call_${randomId()}`;
    const name = toolCall.function?.name || "unknown";
    state = { callId, name, argumentsText: "", item: null, started: false };
    toolStates.set(key, state);
    return state;
  };

  const startToolState = (state) => {
    if (state.started) return;
    state.started = true;
    state.outputIndex = nextOutputIndex++;
    state.bridge = bridgedToolNames.has(state.name);
    state.custom = !state.bridge && customToolNames.has(state.name);
    state.itemId = `${state.custom ? "ctc" : "fc"}_${randomId()}`;
    const responseToolName = state.bridge ? "shell_command" : state.name;
    state.item = state.custom
      ? {
          id: state.itemId,
          type: "custom_tool_call",
          status: "in_progress",
          call_id: state.callId,
          name: responseToolName,
          input: "",
        }
      : {
          id: state.itemId,
          type: "function_call",
          status: "in_progress",
          call_id: state.callId,
          name: responseToolName,
          arguments: "",
        };
    writeSse(clientRes, "response.output_item.added", {
      output_index: state.outputIndex,
      item: state.item,
    });
  };

  const finishText = () => {
    if (!textState || textState.done) return;
    const part = { type: "output_text", text: textState.text, annotations: [] };
    textState.item.status = "completed";
    textState.item.content = [part];
    writeSse(clientRes, "response.output_text.done", {
      item_id: textState.itemId,
      output_index: textState.outputIndex,
      content_index: textState.contentIndex,
      text: textState.text,
    });
    writeSse(clientRes, "response.content_part.done", {
      item_id: textState.itemId,
      output_index: textState.outputIndex,
      content_index: textState.contentIndex,
      part,
    });
    writeSse(clientRes, "response.output_item.done", {
      output_index: textState.outputIndex,
      item: textState.item,
    });
    textState.done = true;
  };

  const finishTools = () => {
    for (const state of toolStates.values()) {
      if (state.done) continue;
      startToolState(state);
      state.item.status = "completed";
      state.item.call_id = state.callId;
      state.item.name = state.bridge ? "shell_command" : state.name || "unknown";
      if (state.bridge) {
        state.item.arguments = bridgedToolArguments(state.name, state.argumentsText);
        writeSse(clientRes, "response.function_call_arguments.delta", {
          item_id: state.itemId,
          output_index: state.outputIndex,
          delta: state.item.arguments,
        });
        writeSse(clientRes, "response.function_call_arguments.done", {
          item_id: state.itemId,
          output_index: state.outputIndex,
          arguments: state.item.arguments,
        });
      } else if (state.custom) {
        state.item.input = customInputFromArguments(state.argumentsText);
        if (state.item.input.length > 0) {
          writeSse(clientRes, "response.custom_tool_call_input.delta", {
            item_id: state.itemId,
            output_index: state.outputIndex,
            delta: state.item.input,
          });
        }
        writeSse(clientRes, "response.custom_tool_call_input.done", {
          item_id: state.itemId,
          output_index: state.outputIndex,
          input: state.item.input,
        });
      } else {
        state.item.arguments = state.argumentsText;
        writeSse(clientRes, "response.function_call_arguments.done", {
          item_id: state.itemId,
          output_index: state.outputIndex,
          arguments: state.argumentsText,
        });
      }
      writeSse(clientRes, "response.output_item.done", {
        output_index: state.outputIndex,
        item: state.item,
      });
      state.done = true;
    }
  };

  const currentOutput = () => {
    const indexed = [];
    if (textState?.done) indexed.push([textState.outputIndex, textState.item]);
    for (const state of toolStates.values()) {
      if (state.done) indexed.push([state.outputIndex, state.item]);
    }
    return indexed.sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
  };

  const completeResponse = () => {
    if (completed) return;
    completed = true;
    finishText();
    finishTools();
    const response = makeResponseObject({
      request,
      responseId,
      publicModel,
      createdAt: startedAt,
      status: "completed",
      output: currentOutput(),
      usage,
    });
    writeSse(clientRes, "response.completed", { response });
    clientRes.write("data: [DONE]\n\n");
    clientRes.end();
    onComplete?.(response);
  };

  try {
    await readSse(reader, firstChunk, (event) => {
      if (event.data === "[DONE]") {
        completeResponse();
        return;
      }
      const chunk = parseJson(event.data, "upstream stream chunk");
      if (chunk.usage) Object.assign(usage, mapUsage(chunk.usage));

      for (const choice of chunk.choices || []) {
        const delta = choice.delta || {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          const state = ensureTextState();
          state.text += delta.content;
          writeSse(clientRes, "response.output_text.delta", {
            item_id: state.itemId,
            output_index: state.outputIndex,
            content_index: state.contentIndex,
            delta: delta.content,
          });
        }

        for (const toolCall of delta.tool_calls || []) {
          const state = ensureToolState(toolCall);
          if (toolCall.id) {
            state.callId = toolCall.id;
            if (state.item) state.item.call_id = toolCall.id;
          }
          if (toolCall.function?.name) {
            state.name = toolCall.function.name;
            if (state.item) state.item.name = state.name;
          }
          if (!state.started && state.name !== "unknown") startToolState(state);
          if (typeof toolCall.function?.arguments === "string") {
            state.argumentsText += toolCall.function.arguments;
            startToolState(state);
            if (!state.custom && !state.bridge) {
              writeSse(clientRes, "response.function_call_arguments.delta", {
                item_id: state.itemId,
                output_index: state.outputIndex,
                delta: toolCall.function.arguments,
              });
            }
          }
        }
        if (choice.finish_reason) debugLog(`upstream finish_reason=${choice.finish_reason}`);
      }
    });
  } catch (error) {
    if (!completed) {
      const response = makeResponseObject({
        request,
        responseId,
        publicModel,
        createdAt: startedAt,
        status: "failed",
        output: currentOutput(),
        usage,
        error: {
          message: error?.message || "Streaming proxy error.",
          type: "server_error",
          code: "proxy_stream_error",
        },
      });
      writeSse(clientRes, "response.failed", { response });
      clientRes.write("data: [DONE]\n\n");
      clientRes.end();
      onError?.(error);
    }
    return;
  }
  completeResponse();
}

export function makeResponseId() {
  return `resp_${randomId()}`;
}

function appendInputItem(messages, item) {
  if (item == null) return;
  if (typeof item === "string") {
    messages.push({ role: "user", content: item });
    return;
  }
  if (Array.isArray(item)) {
    messages.push({ role: "user", content: contentToText(item) });
    return;
  }
  if (typeof item !== "object") {
    messages.push({ role: "user", content: String(item) });
    return;
  }

  switch (item.type) {
    case "message":
      messages.push({
        role: responsesRoleToChatRole(item.role),
        content: contentToChatContent(item.content),
      });
      return;
    case "function_call": {
      const toolCall = {
        id: item.call_id || item.id || `call_${randomId()}`,
        type: "function",
        function: {
          name: item.name || "unknown",
          arguments: normalizeArguments(item.arguments),
        },
      };
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && Array.isArray(last.tool_calls) && !last.content) {
        last.tool_calls.push(toolCall);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      return;
    }
    case "function_call_output":
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: contentToText(item.output),
      });
      return;
    case "custom_tool_call": {
      const toolCall = {
        id: item.call_id || item.id || `call_${randomId()}`,
        type: "function",
        function: {
          name: item.name || "unknown",
          arguments: customArgumentsForChat(item.name, item.input),
        },
      };
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && Array.isArray(last.tool_calls) && !last.content) {
        last.tool_calls.push(toolCall);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      return;
    }
    case "custom_tool_call_output":
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: contentToText(item.output),
      });
      return;
    case "reasoning":
      return;
    case "image_generation_call": {
      const revised = typeof item.revised_prompt === "string" ? item.revised_prompt.trim() : "";
      let marker = "[generated image omitted]";
      if (typeof item.output === "string" && item.output.trim()) {
        marker = item.output.trim();
      } else if (revised) {
        marker = "[generated image omitted: " + revised.slice(0, 240) + "]";
      }
      messages.push({ role: "assistant", content: marker });
      return;
    }
    default:
      if (item.role) {
        messages.push({
          role: responsesRoleToChatRole(item.role),
          content: contentToChatContent(item.content ?? item),
        });
      } else {
        messages.push({ role: "user", content: contentToText(item) });
      }
  }
}

function contentToChatContent(content) {
  if (!Array.isArray(content) || !content.some((part) => part?.type === "input_image")) {
    return contentToText(content);
  }

  return content
    .map((part) => {
      if (part?.type === "input_image") {
        if (!part.image_url) {
          throw new Error("Chat Completions image conversion requires input_image.image_url.");
        }
        return {
          type: "image_url",
          image_url: {
            url: part.image_url,
            ...(part.detail ? { detail: part.detail } : {}),
          },
        };
      }
      return { type: "text", text: contentToText(part) };
    })
    .filter((part) => part.type !== "text" || part.text.length > 0);
}

function responsesRoleToChatRole(role) {
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool";
  if (role === "system" || role === "developer") return "system";
  return "user";
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    return content.map(contentToText).filter((text) => text.length > 0).join("\n");
  }
  if (typeof content !== "object") return String(content);
  if (typeof content.text === "string") return content.text;
  if (typeof content.output_text === "string") return content.output_text;
  if (typeof content.input_text === "string") return content.input_text;
  if (["input_text", "output_text", "text"].includes(content.type)) return content.text || "";
  if (content.type === "input_image") {
    const imageUrl = content.image_url || content.file_id || "";
    return imageUrl ? `[image omitted: ${imageUrl}]` : "[image omitted]";
  }
  if (content.type === "refusal") return content.refusal || "";
  return JSON.stringify(content);
}

function responsesToolsToChatTools(tools) {
  const converted = [];
  for (const tool of tools) {
    if (!tool || !["function", "custom"].includes(tool.type)) continue;
    const parameters = tool.type === "custom"
      ? customToolParameters(tool.name)
      : tool.parameters || { type: "object", properties: {} };
    const fn = {
      name: tool.name,
      description: tool.description || "",
      parameters,
    };
    if (tool.strict != null) fn.strict = tool.strict;
    converted.push({ type: "function", function: fn });
  }
  return converted;
}

function responsesToolChoiceToChatToolChoice(toolChoice) {
  if (toolChoice == null) return null;
  if (typeof toolChoice === "string") return toolChoice;
  if (toolChoice.type === "function" && toolChoice.name) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  if (toolChoice.type === "custom" && toolChoice.name) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return toolChoice;
}

function chatToolCallToResponseItem(request, toolCall) {
  const name = toolCall.function?.name || "unknown";
  const callId = toolCall.id || `call_${randomId()}`;
  const argumentsText = normalizeArguments(toolCall.function?.arguments || "");
  if (getBridgedToolNames(request).has(name)) {
    return {
      id: `fc_${randomId()}`,
      type: "function_call",
      status: "completed",
      call_id: callId,
      name: "shell_command",
      arguments: bridgedToolArguments(name, argumentsText),
    };
  }
  if (getCustomToolNames(request).has(name)) {
    return {
      id: `ctc_${randomId()}`,
      type: "custom_tool_call",
      status: "completed",
      call_id: callId,
      name,
      input: customInputFromArguments(argumentsText),
    };
  }
  return {
    id: `fc_${randomId()}`,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name,
    arguments: argumentsText,
  };
}

function getCustomToolNames(request) {
  const bridged = getBridgedToolNames(request);
  return new Set(
    (request.tools || [])
      .filter((tool) => tool?.type === "custom" && tool.name && !bridged.has(tool.name))
      .map((tool) => tool.name),
  );
}

function getBridgedToolNames(request) {
  return new Set(request.__chat_custom_tool_bridges || []);
}

function customToolParameters(name) {
  const property = name === "apply_patch" ? "patch" : "input";
  return {
    type: "object",
    properties: { [property]: { type: "string" } },
    required: [property],
    additionalProperties: false,
  };
}

function customArgumentsForChat(name, input) {
  return JSON.stringify(name === "apply_patch" ? { patch: input || "" } : { input: input || "" });
}

function customInputFromArguments(value) {
  const normalized = normalizeArguments(value);
  try {
    const parsed = JSON.parse(normalized);
    if (typeof parsed.patch === "string") return parsed.patch;
    if (typeof parsed.input === "string") return parsed.input;
  } catch {
    // Some chat providers return the custom input as raw text.
  }
  return normalized;
}

function bridgedToolArguments(name, value) {
  if (name !== "apply_patch") {
    throw new Error(`Unsupported bridged custom tool ${name}.`);
  }
  const patch = customInputFromArguments(value);
  const encoded = Buffer.from(patch, "utf8").toString("base64");
  return JSON.stringify({
    command:
      `$patch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))\n` +
      `& (Get-Command codex).Source --codex-run-as-apply-patch $patch`,
  });
}

function makeResponseObject({
  request,
  responseId,
  publicModel,
  createdAt,
  status,
  output,
  usage,
  error = null,
}) {
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    background: false,
    error,
    incomplete_details: null,
    instructions: request.instructions ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    max_tool_calls: request.max_tool_calls ?? null,
    model: publicModel,
    output,
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    previous_response_id: request.previous_response_id ?? null,
    prompt_cache_key: request.prompt_cache_key ?? null,
    reasoning: request.reasoning ?? null,
    safety_identifier: request.safety_identifier ?? null,
    service_tier: request.service_tier ?? "default",
    store: request.store ?? false,
    temperature: request.temperature ?? null,
    text: request.text ?? { format: { type: "text" } },
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    top_logprobs: request.top_logprobs ?? 0,
    top_p: request.top_p ?? null,
    truncation: request.truncation ?? "disabled",
    usage,
    user: request.user ?? null,
    metadata: request.metadata ?? {},
  };
}

function mapUsage(usage) {
  if (!usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage.total_tokens ?? inputTokens + outputTokens,
  };
}

async function readSse(reader, firstChunk, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (value) => {
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = parseSseFrame(frame);
      if (event) onEvent(event);
    }
  };

  if (firstChunk?.length) consume(firstChunk);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    consume(value);
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parseSseFrame(buffer);
    if (event) onEvent(event);
  }
}

function parseSseFrame(frame) {
  let event = "message";
  const data = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  return data.length === 0 ? null : { event, data: data.join("\n") };
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify({ type: event, ...payload })}\n\n`);
}

function normalizeArguments(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

function copyIfPresent(from, to, key) {
  if (from[key] != null) to[key] = from[key];
}

function randomId() {
  return randomUUID().replaceAll("-", "");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse ${label} as JSON: ${error.message}`);
  }
}

function redactForLog(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) => {
      if (/authorization|api[_-]?key|token/i.test(key)) return "[redacted]";
      return val;
    }),
  );
}
