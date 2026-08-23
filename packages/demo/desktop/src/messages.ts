import type { Message } from "@uji-ai/ai";

export function messageText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
