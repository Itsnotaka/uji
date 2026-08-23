import type { Entry, SessionStorage } from "@uji-ai/core";

export interface SessionObserverOptions {
  head: string;
  /** Return false to leave the current view alone for this head move. */
  shouldReload?: (leafId: string | null) => boolean;
  onBranch: (entries: Entry[]) => void | Promise<void>;
  onError: (error: Error) => void;
}

/** Publishes an initial branch, then reloads it after committed head moves. */
export function watchSessionBranch(
  session: SessionStorage,
  options: SessionObserverOptions,
): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      const replay = await session.getLog();
      const cursor = replay.at(-1)?.seq ?? -1;
      await options.onBranch(await session.getBranch(options.head));
      for await (const item of session.watch({ afterSeq: cursor, signal: controller.signal })) {
        if (item.kind !== "head" || item.head !== options.head) continue;
        if (options.shouldReload?.(item.leafId) === false) continue;
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
