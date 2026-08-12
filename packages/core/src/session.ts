import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ResponseItem } from "@june/schema";

export interface Session {
  file: string;
  /** Stable id derived from the file name; doubles as prompt cache key. */
  id: string;
  items: ResponseItem[];
  push(item: ResponseItem): void;
}

export interface OpenSessionOptions {
  dir: string;
  resume?: boolean;
}

/** JSONL session block: one file per session, append-only items. */
export function openSession(options: OpenSessionOptions): Session {
  mkdirSync(options.dir, { recursive: true });
  let file: string | undefined;
  if (options.resume === true) {
    const last = readdirSync(options.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .at(-1);
    if (last !== undefined) file = join(options.dir, last);
  }
  file ??= join(options.dir, `${new Date().toISOString().replaceAll(":", "-")}.jsonl`);
  let items: ResponseItem[] = [];
  try {
    items = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ResponseItem);
  } catch {
    // new session
  }
  const target = file;
  return {
    file: target,
    id: basename(target, ".jsonl"),
    items,
    push(item) {
      items.push(item);
      appendFileSync(target, `${JSON.stringify(item)}\n`);
    },
  };
}
