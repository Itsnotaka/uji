import type {
  ResponseItem,
  StopReason,
  StreamDelta,
  ToolDefinition,
  ToolResultPart,
  TurnUsage,
} from "@june/schema";
import type { ModelAuth } from "../auth/types.ts";
import { ORIGINATOR } from "../auth/oauth/openai-codex.ts";
import type { ReasoningEffort, ResponsesApi } from "../provider.ts";

export interface ResponsesRequest {
  auth: ModelAuth;
  api: ResponsesApi;
  baseUrl: string;
  model: string;
  effort?: ReasoningEffort;
  instructions: string;
  input: ResponseItem[];
  tools?: ToolDefinition[];
  /** Stable per-session id; codex backend session header + prompt cache key. */
  sessionId?: string;
  signal?: AbortSignal;
  onDelta?: (delta: StreamDelta) => void;
}

/** Result of one streamed Responses call. */
export interface ResponsesResult {
  /** Completed output items (message / reasoning / function_call). */
  items: ResponseItem[];
  /** "length" when the response was cut off by the output token limit. */
  stopReason: Extract<StopReason, "stop" | "length">;
  usage?: TurnUsage;
}

function buildUrl(request: ResponsesRequest): string {
  const base = (request.auth.baseUrl ?? request.baseUrl).replace(/\/$/, "");
  return request.api === "codex-responses" ? `${base}/codex/responses` : `${base}/responses`;
}

function buildHeaders(request: ResponsesRequest): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "text/event-stream",
  });
  if (request.auth.apiKey !== undefined) {
    headers.set("authorization", `Bearer ${request.auth.apiKey}`);
  }
  for (const [key, value] of Object.entries(request.auth.headers ?? {})) {
    headers.set(key, value);
  }
  if (request.api === "codex-responses") {
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("originator", ORIGINATOR);
    if (request.sessionId !== undefined) {
      headers.set("session-id", request.sessionId);
      headers.set("x-client-request-id", request.sessionId);
    }
  }
  return headers;
}

/**
 * Sessions store June's provider-agnostic tool-result parts; the adapter
 * encodes them into the Responses shape here, at request time. Text parts
 * join to one input_text (or a plain string when there are no images); image
 * parts become input_image parts with base64 data URLs. Pi additionally drops
 * images for models whose metadata says they cannot take image input — June
 * has no model-capability metadata yet, so images are always sent.
 *
 * Based on convertToolResultOutput in
 * https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-responses-shared.ts
 */
function encodeToolResultOutput(output: ToolResultPart[]): string | Record<string, unknown>[] {
  const text = output
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const images = output.filter((part) => part.type === "image");
  if (images.length === 0) {
    return text.length > 0 ? text : "(no tool output)";
  }
  const parts: Record<string, unknown>[] = [];
  if (text.length > 0) {
    parts.push({ type: "input_text", text });
  }
  for (const image of images) {
    parts.push({
      type: "input_image",
      detail: "auto",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    });
  }
  return parts;
}

function encodeInputItem(item: ResponseItem): Record<string, unknown> {
  if (item.type !== "function_call_output" || !Array.isArray(item.output)) return item;
  return { ...item, output: encodeToolResultOutput(item.output) };
}

function buildBody(request: ResponsesRequest): Record<string, unknown> {
  return {
    model: request.model,
    instructions: request.instructions,
    input: request.input.map(encodeInputItem),
    tools: request.tools ?? [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    ...(request.sessionId !== undefined && { prompt_cache_key: request.sessionId }),
    ...(request.effort !== undefined && { reasoning: { effort: request.effort } }),
  };
}

interface SSEEvent {
  event: string;
  data: string;
}

async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) break;
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length > 0) yield { event, data: data.join("\n") };
    }
  }
}

/**
 * One streamed Responses call. Emits text/reasoning deltas as they arrive and
 * resolves with the completed response's output items, ready to append to the
 * session. Throws on transport or provider failure; the agent-loop StreamFn
 * contract (never throw) is enforced by the wrapper in @june/core.
 */
export async function streamResponses(request: ResponsesRequest): Promise<ResponsesResult> {
  const response = await fetch(buildUrl(request), {
    method: "POST",
    headers: buildHeaders(request),
    body: JSON.stringify(buildBody(request)),
    signal: request.signal ?? null,
  });
  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => "");
    throw new Error(`${request.model}: ${String(response.status)} ${text || response.statusText}`);
  }
  // The codex backend sends an empty `output` on response.completed, so
  // collect items from output_item.done (the platform API emits those too).
  const items: ResponseItem[] = [];
  for await (const { event, data } of readSSE(response.body)) {
    const parsed = JSON.parse(data) as {
      type?: string;
      delta?: string;
      item?: ResponseItem;
      response?: {
        output?: ResponseItem[];
        status?: string;
        incomplete_details?: { reason?: string };
        usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
        error?: { message?: string };
      };
      message?: string;
    };
    const type = parsed.type ?? event;
    if (type === "response.output_text.delta" && parsed.delta !== undefined) {
      request.onDelta?.({ kind: "text", text: parsed.delta });
    } else if (type === "response.reasoning_summary_text.delta" && parsed.delta !== undefined) {
      request.onDelta?.({ kind: "reasoning", text: parsed.delta });
    } else if (type === "response.output_item.done" && parsed.item !== undefined) {
      items.push(parsed.item);
    } else if (type === "response.completed" || type === "response.incomplete") {
      const output = parsed.response?.output;
      const usage = parsed.response?.usage;
      return {
        items: items.length > 0 ? items : (output ?? []),
        stopReason:
          parsed.response?.incomplete_details?.reason === "max_output_tokens" ? "length" : "stop",
        ...(usage !== undefined && {
          usage: {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            total: usage.total_tokens ?? 0,
          },
        }),
      };
    } else if (type === "response.failed" || type === "error") {
      throw new Error(
        `${request.model}: ${parsed.response?.error?.message ?? parsed.message ?? "response failed"}`,
      );
    }
  }
  throw new Error(`${request.model}: stream ended without response.completed`);
}
