/**
 * One rule decides what the composer is completing, for `@` and `/` alike:
 * the word the cursor sits in, when that word opens with a trigger character.
 *
 * Keeping both triggers on the same rule is what lets a prompt carry several
 * of them — `@src/tui.ts` next to `/grilling` — instead of reserving the head
 * of the buffer for one command. It also means completion follows the cursor
 * rather than the end of the buffer, so going back to fix a mention reopens
 * its menu.
 *
 * Based on OpenCode 2.0's mention trigger, widened to cover slash commands:
 * https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/prompt/display.ts
 */

type TriggerKind = "@" | "/";

interface CompletionTrigger {
  kind: TriggerKind;
  /** The token: what accepting a suggestion replaces. */
  start: number;
  end: number;
  /** Text between the trigger character and the cursor, which is what filters. */
  query: string;
}

function isTriggerKind(character: string): character is TriggerKind {
  return character === "@" || character === "/";
}

/**
 * The trigger under the cursor, or `undefined` when the cursor is not inside
 * one. A trigger character mid-word — `user@host`, `src/tui.ts` — is ordinary
 * text, and whitespace between the character and the cursor ends the token.
 *
 * The query stops at the cursor while the span runs to the end of the token, so
 * editing `@src/tui.ts` back at `@src` filters on `src` and still replaces the
 * whole path when a suggestion is taken.
 */
export function completionTrigger(
  value: string,
  cursor = value.length,
): CompletionTrigger | undefined {
  const caret = Math.max(0, Math.min(cursor, value.length));
  let start = caret;
  while (start > 0 && (value[start - 1] ?? "").trim() !== "") start -= 1;
  const kind = value[start];
  // `start === caret` puts the cursor left of the character: nothing typed into
  // this token yet, so it is not the one being completed.
  if (start === caret || kind === undefined || !isTriggerKind(kind)) return undefined;
  let end = caret;
  while (end < value.length && (value[end] ?? "").trim() !== "") end += 1;
  return { kind, start, end, query: value.slice(start + 1, caret) };
}
