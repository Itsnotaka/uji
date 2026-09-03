import process from "node:process";
import type { RunEnd } from "@uji-ai/core";

export const RUN_NOTIFICATION_MODES = ["off", "alert", "sound"] as const;
export type RunNotificationMode = (typeof RUN_NOTIFICATION_MODES)[number];

interface NotificationRenderer {
  triggerNotification(message: string, title?: string): boolean;
}

interface NotificationOutput {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

interface RunNotificationOptions {
  readonly end: RunEnd;
  readonly mode: RunNotificationMode;
  readonly renderer: NotificationRenderer;
  readonly output?: NotificationOutput;
}

/** Desktop notifications truncate without warning, so bound the provider text here. */
const MAX_DETAIL_CHARS = 120;

function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function summarize(message: string): string {
  const collapsed = oneLine(message);
  if (collapsed.length <= MAX_DETAIL_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_DETAIL_CHARS - 1).trimEnd()}…`;
}

/** What stopped the run, not just that it stopped: an error must not read as a clean finish. */
export function runEndMessage(end: RunEnd): string {
  switch (end.kind) {
    case "completed":
      return "Turn finished";
    case "aborted":
      return "Turn stopped";
    case "failed": {
      const detail = summarize(end.error.message);
      return detail === "" ? "Turn failed" : `Turn failed: ${detail}`;
    }
    default: {
      const _exhaustive: never = end;
      return _exhaustive;
    }
  }
}

/** Let OpenTUI select the notification protocol the active terminal supports. */
export function notifyRunEvent(options: RunNotificationOptions): void {
  if (options.mode === "off") return;
  try {
    options.renderer.triggerNotification(runEndMessage(options.end), "Uji");
  } catch {}
  if (options.mode !== "sound") return;
  const output = options.output ?? process.stdout;
  if (output.isTTY === true) output.write("\u0007");
}
