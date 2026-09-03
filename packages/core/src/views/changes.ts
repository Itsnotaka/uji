/**
 * Change tracking: settled tool results that carry a patch fold into per-file
 * totals. The fold consumes turns, not raw entries, so a client folds the same
 * `message` events it already renders and a git panel needs no second read.
 * Declared mutations only: whole-tree truth is the host's VCS.
 *
 * Design: packages/docs/content/docs/design.mdx, "Views" and the nineteenth
 * revision.
 */
import { parsePatch } from "diff";
import { isJsonObject, type JsonValue } from "../harness/session/types.ts";
import type { Turn } from "./transcript.ts";

export interface FileChange {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** The settled tool-result entry that last touched the file. */
  readonly lastEntryId: string;
}

/**
 * Incremental fold state. `folded` holds the result entry ids already
 * counted, so re-folding a turn the transcript updated in place (a result
 * settling into its call) is a no-op per result, mirroring the transcript's
 * own repeat guard.
 */
export interface ChangesState {
  readonly files: readonly FileChange[];
  readonly folded: ReadonlySet<string>;
}

export const EMPTY_CHANGES: ChangesState = { files: [], folded: new Set() };

/** The unified patch a settled result declares, under either conventional key. */
export function patchOf(details: JsonValue | undefined): string | undefined {
  if (!isJsonObject(details)) return undefined;
  const patch = details["patch"];
  if (typeof patch === "string" && patch !== "") return patch;
  const diff = details["diff"];
  return typeof diff === "string" && diff.startsWith("---") ? diff : undefined;
}

export function patchedPath(patch: string): string | undefined {
  let name: string | undefined;
  try {
    const file = parsePatch(patch)[0];
    name = file?.newFileName ?? file?.oldFileName;
  } catch {
    return undefined;
  }
  if (name === undefined || name === "/dev/null") return undefined;
  return name.startsWith("b/") ? name.slice(2) : name;
}

export function diffStat(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/**
 * Fold one turn's settled patches into the totals. Errors do not count as
 * changes, and a patch whose path cannot be read is skipped rather than
 * attributed to a guess.
 */
export function appendTurnChanges(state: ChangesState, turn: Turn): ChangesState {
  if (turn.kind !== "turn") return state;
  let files: FileChange[] | undefined;
  let folded: Set<string> | undefined;
  for (const part of turn.parts) {
    if (part.kind !== "tool" || part.result === undefined) continue;
    const { result } = part;
    if (result.isError || state.folded.has(result.entryId) || folded?.has(result.entryId)) {
      continue;
    }
    const patch = patchOf(result.details);
    if (patch === undefined) continue;
    const path = patchedPath(patch);
    if (path === undefined) continue;
    const stat = diffStat(patch);
    files ??= [...state.files];
    folded ??= new Set(state.folded);
    folded.add(result.entryId);
    const index = files.findIndex((file) => file.path === path);
    const previous = files[index];
    const change: FileChange = {
      path,
      added: (previous?.added ?? 0) + stat.added,
      removed: (previous?.removed ?? 0) + stat.removed,
      lastEntryId: result.entryId,
    };
    if (previous === undefined) files.push(change);
    else files[index] = change;
  }
  return files === undefined || folded === undefined ? state : { files, folded };
}

export function changesFromTurns(turns: readonly Turn[]): readonly FileChange[] {
  return [...turns.reduce(appendTurnChanges, EMPTY_CHANGES).files];
}
