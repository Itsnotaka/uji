/**
 * The session tree as a client draws it: parent-linked entries folded into
 * nodes, the head's path marked, and the two navigation questions answered in
 * one place so every client agrees on them: where a selection lands, and
 * which entries a move abandons.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts
 * (getTree) and https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts
 * (collectEntriesForBranchSummary).
 */
import type { Entry } from "../harness/session/types.ts";

export interface SessionTreeNode {
  readonly entry: Entry;
  /** Oldest first. */
  readonly children: readonly SessionTreeNode[];
  /** True on the path from a root to the head's leaf. */
  readonly active: boolean;
  /** Root is 0. */
  readonly depth: number;
}

export interface SessionTree {
  /** Oldest first. More than one root means the head once started over. */
  readonly roots: readonly SessionTreeNode[];
  readonly leafId: string | null;
  /** Entry ids from the leaf up to its root, in no particular order. */
  readonly activePath: ReadonlySet<string>;
}

/** Ids from `leafId` up to the root, following parent links through `byId`. */
function activePathIds(
  byId: ReadonlyMap<string, Pick<Entry, "id" | "parentId">>,
  leafId: string | null,
): Set<string> {
  const path = new Set<string>();
  let current = leafId;
  while (current !== null && !path.has(current)) {
    path.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return path;
}

/** Fold every entry of a session into its tree. Entries arrive in any order. */
export function projectSessionTree(entries: readonly Entry[], leafId: string | null): SessionTree {
  const byId = new Map<string, Entry>();
  for (const entry of entries) byId.set(entry.id, entry);
  const activePath = activePathIds(byId, leafId);

  const childrenOf = new Map<string | null, Entry[]>();
  for (const entry of [...byId.values()].sort((left, right) => left.seq - right.seq)) {
    // An orphan (parent missing from the session) reads as its own root.
    const parentId =
      entry.parentId !== null && byId.has(entry.parentId) && entry.parentId !== entry.id
        ? entry.parentId
        : null;
    const siblings = childrenOf.get(parentId);
    if (siblings === undefined) childrenOf.set(parentId, [entry]);
    else siblings.push(entry);
  }

  const build = (entry: Entry, depth: number): SessionTreeNode => ({
    entry,
    depth,
    active: activePath.has(entry.id),
    children: (childrenOf.get(entry.id) ?? []).map((child) => build(child, depth + 1)),
  });
  return {
    roots: (childrenOf.get(null) ?? []).map((root) => build(root, 0)),
    leafId,
    activePath,
  };
}

export type NavigationTarget =
  | {
      /** The head parks on the selection itself. */
      kind: "move";
      targetId: string | null;
    }
  | {
      /**
       * The selection is a message the user sent: the head parks on its parent
       * and the message goes back to the composer instead of staying in the chat.
       */
      kind: "restore";
      targetId: string | null;
      entry: Extract<Entry, { type: "message" }>;
    };

/** Where a selection lands. `undefined` selection means the start of the chat. */
export function navigationTarget(selected: Entry | undefined): NavigationTarget {
  if (selected === undefined) return { kind: "move", targetId: null };
  if (selected.type === "message" && selected.message.role === "user") {
    return { kind: "restore", targetId: selected.parentId, entry: selected };
  }
  return { kind: "move", targetId: selected.id };
}

/**
 * The entries a move from `fromLeafId` abandons, oldest first: everything on
 * the old path below its deepest ancestor shared with the selection. Measured
 * against the selection, not the destination, so a user message taken back
 * into the composer is not summarized as abandoned work. Compaction
 * boundaries are crossed; their summaries become context.
 */
export function collectAbandonedEntries(
  byId: ReadonlyMap<string, Entry>,
  fromLeafId: string | null,
  selectedId: string | null,
): { entries: Entry[]; commonAncestorId: string | null } {
  if (fromLeafId === null) return { entries: [], commonAncestorId: null };
  const selectedPath = activePathIds(byId, selectedId);
  const entries: Entry[] = [];
  let current: string | null = fromLeafId;
  const seen = new Set<string>();
  while (current !== null && !selectedPath.has(current) && !seen.has(current)) {
    seen.add(current);
    const entry = byId.get(current);
    if (entry === undefined) break;
    entries.push(entry);
    current = entry.parentId;
  }
  entries.reverse();
  return {
    entries,
    commonAncestorId: current !== null && selectedPath.has(current) ? current : null,
  };
}
