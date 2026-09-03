import { parsePatch } from "diff";
import { presentTool as presentToolView, toolViewOf } from "@uji-ai/core/views";
import type { ToolProgress, ToolTurnPart } from "@uji-ai/core";

export interface ParsedDiff {
  readonly patch: string;
  readonly added: number;
  readonly removed: number;
  readonly displayLines: number;
}

export type ToolBody =
  | { kind: "none" }
  | { kind: "output"; text: string }
  | { kind: "diff"; path: string; diff: ParsedDiff };

export interface ToolPresentation {
  readonly verb: string;
  readonly detail: string | undefined;
  readonly state: "running" | "done" | "failed";
  readonly added: number | undefined;
  readonly removed: number | undefined;
  readonly body: ToolBody;
}

const VERBS: Readonly<Record<string, { running: string; done: string; failed: string }>> = {
  read: { running: "Reading", done: "Read", failed: "Read failed" },
  bash: { running: "Running", done: "Ran", failed: "Command failed" },
  edit: { running: "Editing", done: "Edited", failed: "Edit failed" },
  write: { running: "Writing", done: "Wrote", failed: "Write failed" },
  ls: { running: "Listing", done: "Listed", failed: "List failed" },
};

const PATCH_CACHE_LIMIT = 64;
const patchCache = new Map<string, ParsedDiff | null>();

function rememberPatch(patch: string, parsed: ParsedDiff | null): void {
  patchCache.set(patch, parsed);
  if (patchCache.size <= PATCH_CACHE_LIMIT) return;
  const oldest = patchCache.keys().next().value;
  if (oldest !== undefined) patchCache.delete(oldest);
}

function tidyPath(path: string, cwd: string | undefined): string {
  if (cwd !== undefined && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return path;
}

export function parseUnifiedPatch(patch: string): ParsedDiff | undefined {
  const cached = patchCache.get(patch);
  if (cached !== undefined) {
    patchCache.delete(patch);
    patchCache.set(patch, cached);
    return cached ?? undefined;
  }
  let files;
  try {
    files = parsePatch(patch);
  } catch {
    rememberPatch(patch, null);
    return undefined;
  }
  let added = 0;
  let removed = 0;
  let displayLines = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      displayLines += hunk.lines.length + 1;
      for (const raw of hunk.lines) {
        const marker = raw[0];
        if (marker === "+") {
          added += 1;
        } else if (marker === "-") {
          removed += 1;
        }
      }
    }
  }
  const parsed =
    added === 0 && removed === 0
      ? null
      : { patch, added, removed, displayLines: Math.max(1, displayLines) };
  rememberPatch(patch, parsed);
  return parsed ?? undefined;
}

export function presentTool(
  part: ToolTurnPart,
  progress: ToolProgress | undefined,
  cwd: string | undefined,
): ToolPresentation {
  const presented = presentToolView(toolViewOf(part, progress));
  const verbs = VERBS[presented.name];
  const verb =
    verbs === undefined
      ? presented.status === "failed"
        ? `${presented.name} failed`
        : presented.name
      : verbs[presented.status];
  const detail = presented.detail === undefined ? presented.title : tidyPath(presented.detail, cwd);

  if (presented.body.kind === "diff") {
    const diff = parseUnifiedPatch(presented.body.patch);
    if (diff !== undefined) {
      return {
        verb,
        detail,
        state: presented.status,
        added: diff.added === 0 ? undefined : diff.added,
        removed: diff.removed === 0 ? undefined : diff.removed,
        body: { kind: "diff", path: presented.body.path ?? detail ?? presented.name, diff },
      };
    }
  }

  const text =
    presented.body.kind === "text"
      ? presented.body.text
      : presented.body.kind === "diff"
        ? (part.result?.output ?? "")
        : "";
  return {
    verb,
    detail,
    state: presented.status,
    added: undefined,
    removed: undefined,
    body: text.trim() === "" ? { kind: "none" } : { kind: "output", text },
  };
}
