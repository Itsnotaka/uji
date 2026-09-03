import type { SessionInfo } from "@uji-ai/core";
import type { SessionsBridge } from "../../shared/ipc.ts";

export const INITIAL_VISIBLE_SESSION_COUNT = 3;
export const INITIAL_SESSION_FETCH_LIMIT = INITIAL_VISIBLE_SESSION_COUNT + 1;

export type SessionPage = Awaited<ReturnType<SessionsBridge["list"]>>;

export function sessionPreviewHasOverflow(preview: SessionPage): boolean {
  return preview.items.length > INITIAL_VISIBLE_SESSION_COUNT || preview.next !== undefined;
}

export function visibleSessions(
  preview: SessionPage,
  expanded: readonly SessionInfo[] | undefined,
  showAll: boolean,
): readonly SessionInfo[] {
  return showAll
    ? (expanded ?? preview.items)
    : preview.items.slice(0, INITIAL_VISIBLE_SESSION_COUNT);
}

/** Continue from the fourth-item proof without re-reading or reordering the preview. */
export async function loadRemainingSessions(
  preview: SessionPage,
  list: SessionsBridge["list"],
): Promise<readonly SessionInfo[]> {
  const items = [...preview.items];
  let cursor = preview.next;
  while (cursor !== undefined) {
    const page = await list({ cursor });
    items.push(...page.items);
    cursor = page.next;
  }
  return items;
}
