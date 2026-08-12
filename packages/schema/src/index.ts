/**
 * Wire types shared by core, ai, and clients. OpenAI Responses item shapes
 * are the v0 session wire; June parts come later and adapt from these.
 */

export interface ContentPart {
  type: string;
  text?: string;
}

/**
 * One item on the Responses wire: message, reasoning, function_call,
 * function_call_output. Plain `{role, content}` input items carry no `type`.
 */
export interface ResponseItem {
  type?: string;
  role?: string;
  content?: ContentPart[] | string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  encrypted_content?: string;
  [key: string]: unknown;
}

/** A tool the model can call, in Responses function-tool shape. */
export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}
