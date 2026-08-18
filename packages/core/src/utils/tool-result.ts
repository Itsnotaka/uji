import type { ToolResultPart } from "@june/schema";

/** Wraps plain text as tool-result content. */
export function toolResultContent(text: string): ToolResultPart[] {
  return [{ type: "text", text }];
}

/** Flattens tool-result content to text. Image parts become placeholders. */
export function toolResultText(content: ToolResultPart[]): string {
  return content
    .map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`))
    .join("\n");
}
