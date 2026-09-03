import type { ImageContent, TextContent } from "@uji-ai/schema";
import type { AgentToolResult } from "../types.ts";

/** Wraps plain text as tool-result content. */
export function toolResultContent(text: string): TextContent[] {
  return [{ type: "text", text }];
}

/** Flattens tool-result content to text. Image parts become placeholders. */
export function toolResultText(content: (TextContent | ImageContent)[]): string {
  return content
    .map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`))
    .join("\n");
}

/** A failed tool execution whose structured result must survive settlement. */
export class ToolError<TDetails = unknown> extends Error {
  readonly result: AgentToolResult<TDetails>;

  constructor(result: AgentToolResult<TDetails>) {
    super(toolResultText(result.content).trim() || "Tool execution failed");
    this.name = "ToolError";
    this.result = result;
  }
}

/**
 * Preserves a structured tool failure and normalizes every other thrown value.
 * With `lastPartial`, the settlement keeps the last progress the tool reported
 * (invariant 31): partial content after the error text, the partial's details
 * and title filling gaps the error left. A `ToolError` is the tool's own
 * structured decision and is not amended.
 */
export function toolErrorResult(error: unknown, lastPartial?: unknown): AgentToolResult<unknown> {
  if (error instanceof ToolError) return error.result;
  const result: AgentToolResult<unknown> = {
    content: toolResultContent(error instanceof Error ? error.message : String(error)),
    details: {},
  };
  return lastPartial === undefined ? result : withPartial(result, lastPartial);
}

function withPartial(result: AgentToolResult<unknown>, partial: unknown): AgentToolResult<unknown> {
  if (typeof partial !== "object" || partial === null) return result;
  const content =
    "content" in partial && Array.isArray(partial.content)
      ? partial.content.filter(isResultPart)
      : [];
  const details = "details" in partial ? partial.details : undefined;
  const title = "title" in partial && typeof partial.title === "string" ? partial.title : undefined;
  return {
    ...result,
    content: [...result.content, ...content],
    details: emptyDetails(result.details) && details !== undefined ? details : result.details,
    ...(result.title === undefined && title !== undefined ? { title } : {}),
  };
}

function emptyDetails(details: unknown): boolean {
  return (
    details === undefined ||
    (typeof details === "object" && details !== null && Object.keys(details).length === 0)
  );
}

function isResultPart(part: unknown): part is TextContent | ImageContent {
  if (typeof part !== "object" || part === null || !("type" in part)) return false;
  if (part.type === "text") return "text" in part && typeof part.text === "string";
  if (part.type === "image") {
    return (
      "data" in part &&
      typeof part.data === "string" &&
      "mimeType" in part &&
      typeof part.mimeType === "string"
    );
  }
  return false;
}
