import type { Entry, SessionStorage } from "@uji-ai/core/store";

interface SessionObserverOptions {
  head: string;
  /** A committed entry that extends the visible leaf without moving the branch. */
  onAppend?: (entry: Entry) => void | Promise<void>;
  /** The initial branch, and later branches reached by deliberate navigation. */
  onBranch: (entries: Entry[]) => void | Promise<void>;
  onError: (error: Error) => void;
}

/** Publishes the initial branch, appends its linear commits, and reloads only after navigation. */
export function watchSessionBranch(
  session: SessionStorage,
  options: SessionObserverOptions,
): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      const cursor = await session.lastSeq();
      const initial = await session.getBranch(options.head);
      let leafId = initial.at(-1)?.id ?? null;
      await options.onBranch(initial);

      for await (const item of session.watch({ afterSeq: cursor, signal: controller.signal })) {
        if (item.kind === "entry" && item.head === options.head) {
          if (item.entry.parentId !== leafId) continue;
          leafId = item.entry.id;
          if (options.onAppend === undefined) {
            await options.onBranch(await session.getBranch(options.head));
          } else {
            await options.onAppend(item.entry);
          }
          continue;
        }
        if (item.kind !== "head" || item.head !== options.head || item.leafId === leafId) continue;
        leafId = item.leafId;
        await options.onBranch(await session.getBranch(options.head));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  })();

  return () => controller.abort();
}
