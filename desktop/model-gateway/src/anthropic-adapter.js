import { randomUUID } from "node:crypto";
import { responsesToChatRequest } from "./chat-adapter.js";

export function responsesToAnthropicRequest(request, upstreamModel, debugLog = () => {}) {
  const chat = responsesToChatRequest(request, upstreamModel);
  const system = [];
  const messages = [];

  for (const message of chat.messages || []) {
    if (message.role === "system") {
      const text = chatContentToText(message.content);
      if (text) system.push(text);
      continue;
    }

    if (message.role === "tool") {
      appendAnthropicMessage(messages, "user", [{
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: chatContentToText(message.content),
      }]);
      continue;
    }

    const content = chatContentToAnthropic(message.content);
    for (const toolCall of message.tool_calls || []) {
      content.push({
        type: "tool_use",
        id: toolCall.id || `toolu_${randomId()}`,
        name: toolCall.function?.name || "unknown",
        input: parseToolInput(toolCall.function?.arguments),
      });
    }
    appendAnthropicMessage(messages, message.role === "assistant" ? "assistant" : "user", content);
  }

  const anthropic = {
    model: upstreamModel,
    max_tokens: request.max_output_tokens || 8192,
    messages: messages.length > 0 ? messages : [{ role: "user", content: "" }],
    stream: Boolean(request.stream),
  };
  if (system.length > 0) anthropic.system = system.join("\n\n");
  for (const key of ["temperature", "top_p"]) copyIfPresent(chat, anthropic, key);
  if (chat.stop != null) {
    anthropic.stop_sequences = Array.isArray(chat.stop) ? chat.stop : [chat.stop];
  }
  if (chat.user) anthropic.metadata = { user_id: String(chat.user).slice(0, 256) };

  const tools = (chat.tools || []).map((tool) => ({
    name: tool.function?.name || "unknown",
    description: tool.function?.description || "",
    input_schema: tool.function?.parameters || { type: "object", properties: {} },
  }));
  if (tools.length > 0) anthropic.tools = tools;
  const toolChoice = chatToolChoiceToAnthropic(chat.tool_choice);
  if (toolChoice) anthropic.tool_choice = toolChoice;

  debugLog(redactForLog(anthropic));
  return anthropic;
}

export function anthropicToResponse(request, message, responseId, publicModel) {
  const output = [];
  for (const block of message.content || []) {
    if (block?.type === "text" && block.text) {
      output.push({
        id: `msg_${randomId()}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: block.text, annotations: [] }],
      });
    } else if (block?.type === "tool_use") {
      output.push(anthropicToolToResponseItem(request, block));
    }
  }
  return makeResponseObject({
    request,
    responseId,
    publicModel,
    createdAt: nowSeconds(),
    status: "completed",
    output,
    usage: mapAnthropicUsage(message.usage),
  });
}

export async function streamAnthropicAsResponses({
  reader,
  firstChunk,
  clientRes,
  request,
  responseId,
  publicModel,
  onComplete,
  onError,
}) {
  clientRes.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const createdAt = nowSeconds();
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const states = new Map();
  const output = [];
  let nextOutputIndex = 0;
  let completed = false;
  const baseResponse = makeResponseObject({
    request,
    responseId,
    publicModel,
    createdAt,
    status: "in_progress",
    output: [],
    usage: null,
  });
  writeSse(clientRes, "response.created", { response: baseResponse });
  writeSse(clientRes, "response.in_progress", { response: baseResponse });

  const finishState = (state) => {
    if (!state || state.done) return;
    state.done = true;
    if (state.kind === "text") {
      const part = { type: "output_text", text: state.text, annotations: [] };
      state.item.status = "completed";
      state.item.content = [part];
      writeSse(clientRes, "response.output_text.done", {
        item_id: state.item.id,
        output_index: state.outputIndex,
        content_index: 0,
        text: state.text,
      });
      writeSse(clientRes, "response.content_part.done", {
        item_id: state.item.id,
        output_index: state.outputIndex,
        content_index: 0,
        part,
      });
    } else {
      state.item.status = "completed";
      if (state.item.type === "custom_tool_call") {
        state.item.input = customInputFromArguments(state.argumentsText);
        writeSse(clientRes, "response.custom_tool_call_input.done", {
          item_id: state.item.id,
          output_index: state.outputIndex,
          input: state.item.input,
        });
      } else {
        state.item.arguments = normalizeJsonArguments(state.argumentsText);
        writeSse(clientRes, "response.function_call_arguments.done", {
          item_id: state.item.id,
          output_index: state.outputIndex,
          arguments: state.item.arguments,
        });
      }
    }
    writeSse(clientRes, "response.output_item.done", {
      output_index: state.outputIndex,
      item: state.item,
    });
  };

  const complete = () => {
    if (completed) return;
    completed = true;
    for (const state of states.values()) finishState(state);
    usage.total_tokens = usage.input_tokens + usage.output_tokens;
    const response = makeResponseObject({
      request,
      responseId,
      publicModel,
      createdAt,
      status: "completed",
      output,
      usage,
    });
    writeSse(clientRes, "response.completed", { response });
    clientRes.write("data: [DONE]\n\n");
    clientRes.end();
    onComplete?.(response);
  };

  try {
    await readSse(reader, firstChunk, ({ data }) => {
      if (!data || data === "[DONE]") return;
      const event = JSON.parse(data);
      if (event.type === "message_start") {
        Object.assign(usage, mapAnthropicUsage(event.message?.usage));
        return;
      }
      if (event.type === "message_delta") {
        const mapped = mapAnthropicUsage(event.usage);
        if (event.usage?.input_tokens != null) usage.input_tokens = mapped.input_tokens;
        if (event.usage?.output_tokens != null) usage.output_tokens = mapped.output_tokens;
        return;
      }
      if (event.type === "content_block_start") {
        const block = event.content_block || {};
        const outputIndex = nextOutputIndex++;
        if (block.type === "text") {
          const item = {
            id: `msg_${randomId()}`,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          };
          const state = { kind: "text", outputIndex, item, text: block.text || "", done: false };
          states.set(event.index, state);
          output.push(item);
          writeSse(clientRes, "response.output_item.added", { output_index: outputIndex, item });
          writeSse(clientRes, "response.content_part.added", {
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
          if (state.text) {
            writeSse(clientRes, "response.output_text.delta", {
              item_id: item.id,
              output_index: outputIndex,
              content_index: 0,
              delta: state.text,
            });
          }
        } else if (block.type === "tool_use") {
          const item = anthropicToolToResponseItem(request, block, "in_progress");
          const state = {
            kind: "tool",
            outputIndex,
            item,
            argumentsText: block.input && Object.keys(block.input).length > 0
              ? JSON.stringify(block.input)
              : "",
            done: false,
          };
          states.set(event.index, state);
          output.push(item);
          writeSse(clientRes, "response.output_item.added", { output_index: outputIndex, item });
        }
        return;
      }
      if (event.type === "content_block_delta") {
        const state = states.get(event.index);
        if (!state) return;
        if (event.delta?.type === "text_delta" && state.kind === "text") {
          const delta = event.delta.text || "";
          state.text += delta;
          writeSse(clientRes, "response.output_text.delta", {
            item_id: state.item.id,
            output_index: state.outputIndex,
            content_index: 0,
            delta,
          });
        } else if (event.delta?.type === "input_json_delta" && state.kind === "tool") {
          const delta = event.delta.partial_json || "";
          state.argumentsText += delta;
          writeSse(
            clientRes,
            state.item.type === "custom_tool_call"
              ? "response.custom_tool_call_input.delta"
              : "response.function_call_arguments.delta",
            {
              item_id: state.item.id,
              output_index: state.outputIndex,
              delta,
            },
          );
        }
        return;
      }
      if (event.type === "content_block_stop") finishState(states.get(event.index));
      if (event.type === "message_stop") complete();
      if (event.type === "error") throw new Error(event.error?.message || "Anthropic stream failed.");
    });
    complete();
  } catch (error) {
    if (!completed) {
      completed = true;
      const response = makeResponseObject({
        request,
        responseId,
        publicModel,
        createdAt,
        status: "failed",
        output,
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
  }
}

function appendAnthropicMessage(messages, role, content) {
  const normalized = content.filter((block) => block && (block.type !== "text" || block.text));
  const blocks = normalized.length > 0 ? normalized : [{ type: "text", text: "" }];
  const previous = messages.at(-1);
  if (previous?.role === role) previous.content.push(...blocks);
  else messages.push({ role, content: blocks });
}

function chatContentToAnthropic(content) {
  if (!Array.isArray(content)) {
    return [{ type: "text", text: chatContentToText(content) }];
  }
  return content.map((part) => {
    if (part?.type !== "image_url") return { type: "text", text: chatContentToText(part) };
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    const data = /^data:([^;,]+);base64,(.+)$/i.exec(url || "");
    if (data) {
      return {
        type: "image",
        source: { type: "base64", media_type: data[1], data: data[2] },
      };
    }
    return { type: "image", source: { type: "url", url } };
  });
}

function chatContentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(chatContentToText).filter(Boolean).join("\n");
  if (typeof content.text === "string") return content.text;
  return JSON.stringify(content);
}

function chatToolChoiceToAnthropic(choice) {
  if (choice == null) return null;
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none") return { type: "none" };
  if (typeof choice === "object" && choice.function?.name) {
    return { type: "tool", name: choice.function.name };
  }
  return null;
}

function anthropicToolToResponseItem(request, block, status = "completed") {
  const name = block.name || "unknown";
  const callId = block.id || `toolu_${randomId()}`;
  const input = block.input == null ? "" : JSON.stringify(block.input);
  if (getCustomToolNames(request).has(name)) {
    return {
      id: `ctc_${randomId()}`,
      type: "custom_tool_call",
      status,
      call_id: callId,
      name,
      input: customInputFromArguments(input),
    };
  }
  return {
    id: `fc_${randomId()}`,
    type: "function_call",
    status,
    call_id: callId,
    name,
    arguments: normalizeJsonArguments(input),
  };
}

function getCustomToolNames(request) {
  return new Set((request.tools || [])
    .filter((tool) => tool?.type === "custom" && tool.name)
    .map((tool) => tool.name));
}

function customInputFromArguments(value) {
  const normalized = normalizeJsonArguments(value);
  try {
    const parsed = JSON.parse(normalized);
    if (typeof parsed.patch === "string") return parsed.patch;
    if (typeof parsed.input === "string") return parsed.input;
  } catch {
    // Preserve providers that stream custom tool input as plain text.
  }
  return normalized;
}

function parseToolInput(value) {
  if (value == null || value === "") return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : { input: value };
  } catch {
    return { input: String(value) };
  }
}

function normalizeJsonArguments(value) {
  if (typeof value !== "string") return value == null ? "" : JSON.stringify(value);
  if (!value.trim()) return "{}";
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

function makeResponseObject({ request, responseId, publicModel, createdAt, status, output, usage, error = null }) {
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

function mapAnthropicUsage(usage) {
  const inputTokens = (usage?.input_tokens || 0)
    + (usage?.cache_creation_input_tokens || 0)
    + (usage?.cache_read_input_tokens || 0);
  const outputTokens = usage?.output_tokens || 0;
  return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
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
      const parsed = parseSseFrame(frame);
      if (parsed) onEvent(parsed);
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
    const parsed = parseSseFrame(buffer);
    if (parsed) onEvent(parsed);
  }
}

function parseSseFrame(frame) {
  let event = "message";
  const data = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

function writeSse(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify({ type: event, ...payload })}\n\n`);
}

function copyIfPresent(from, to, key) {
  if (from[key] != null) to[key] = from[key];
}

function redactForLog(value) {
  return JSON.parse(JSON.stringify(value, (key, item) =>
    /authorization|api[_-]?key|token/i.test(key) ? "[redacted]" : item));
}

function randomId() {
  return randomUUID().replaceAll("-", "");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
