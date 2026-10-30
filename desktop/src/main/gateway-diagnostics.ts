import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayRequestEvent } from "./gateway-module";

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Only allow protocol metadata into the persisted log, never request bodies. */
export class GatewayDiagnostics {
  private pending = Promise.resolve();

  constructor(private readonly directory: string) {}

  record(event: GatewayRequestEvent): void {
    if (!["chat_response_finished", "task_completion_checked"].includes(event.event || "")) return;
    const entry: Record<string, unknown> = { event: event.event };
    for (const key of ["time", "request_id", "turn_id", "provider", "public_model", "protocol"]) {
      if (typeof event[key] === "string") entry[key] = event[key].slice(0, 500);
    }
    entry.finish_reason = ["stop", "tool_calls", "function_call", "length", "content_filter"].includes(String(event.finish_reason))
      ? event.finish_reason : null;
    entry.response_status = ["completed", "incomplete", "failed"].includes(String(event.response_status))
      ? event.response_status : null;
    if (event.event === "task_completion_checked") entry.verdict = ["complete", "continue", "needs_input", "blocked", "unknown"].includes(String(event.verdict))
      ? event.verdict : "unknown";
    entry.error_code = ["upstream_missing_terminal", "invalid_tool_arguments", "proxy_stream_error", "upstream_timeout"].includes(String(event.error_code))
      ? event.error_code : null;
    for (const key of ["terminal_received", "done_received", "usage_received"]) {
      entry[key] = typeof event[key] === "boolean" ? event[key] : null;
    }
    for (const key of ["max_output_tokens", "tool_call_count", "output_text_chars", "reasoning_text_chars"]) {
      entry[key] = typeof event[key] === "number" && Number.isFinite(event[key]) ? event[key] : null;
    }
    const usage = event.usage as Record<string, unknown> | null;
    entry.usage = usage ? Object.fromEntries(["input_tokens", "output_tokens", "total_tokens"].map((key) => [
      key, typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] : null,
    ])) : null;
    const line = `${JSON.stringify(entry)}\n`;
    this.pending = this.pending.then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const file = path.join(this.directory, "gateway-outcomes.jsonl");
      const size = await fs.stat(file).then((stat) => stat.size, () => 0);
      if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
        await fs.rm(`${file}.1`, { force: true });
        await fs.rename(file, `${file}.1`);
      }
      await fs.appendFile(file, line, "utf8");
    }).catch(() => {
      // Diagnostics must never interrupt a task or expose log data in errors.
    });
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}
