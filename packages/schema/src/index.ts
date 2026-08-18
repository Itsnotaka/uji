/**
 * Wire types shared by core, ai, and clients. OpenAI Responses item shapes
 * are the v0 session wire; June parts come later and adapt from these.
 */

export interface ContentPart {
  type: string;
  text?: string;
}

/** Text part of a tool result. */
export interface ToolResultTextPart {
  type: "text";
  text: string;
}

/** Image part of a tool result. Base64 payload; provider-agnostic. */
export interface ToolResultImagePart {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * Tool result content is a list of these parts. Sessions store them verbatim;
 * provider adapters encode them into each API's shape at request time.
 */
export type ToolResultPart = ToolResultTextPart | ToolResultImagePart;

/**
 * One item on the Responses wire: message, reasoning, function_call,
 * function_call_output. Plain `{role, content}` input items carry no `type`.
 * `output` holds June tool-result parts (or a bare string); it is encoded to
 * the provider's shape by the adapter, not stored pre-encoded.
 */
export interface ResponseItem {
  type?: string;
  role?: string;
  content?: ContentPart[] | string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string | ToolResultPart[];
  encrypted_content?: string;
  [key: string]: unknown;
}

/** Reasoning level requested for a turn. "off" omits the reasoning field. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Why an assistant turn stopped. */
export type StopReason = "stop" | "length" | "error" | "aborted";

/** Streaming delta: assistant text or reasoning summary text. */
export interface StreamDelta {
  kind: "text" | "reasoning";
  text: string;
}

/** Token usage for one assistant step. */
export interface TurnUsage {
  input: number;
  output: number;
  total: number;
}

/** A tool the model can call, in Responses function-tool shape. */
export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}
