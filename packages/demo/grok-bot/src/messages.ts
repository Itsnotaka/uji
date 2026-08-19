import type { JuneSnapshot } from "./desktop-api";

// content is the schema's v0 Responses wire shape (string | ContentPart[] | undefined);
// this collapses once @june/schema ships canonical discriminated parts.
export function messageText(
  content: JuneSnapshot["messages"][number]["message"]["content"],
): string {
  if (typeof content === "string") return content;
  return content?.map((part) => part.text ?? "").join("") ?? "";
}
