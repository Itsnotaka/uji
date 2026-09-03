import type { ParsedDiff } from "../conversation/tool-detail.ts";
import { parseUnifiedPatch } from "../conversation/tool-detail.ts";
import type { VcsDiffIdentity } from "../queries.ts";

const MAX_PARSED_DIFFS = 96;

interface ParsedDiffCacheEntry {
  readonly patch: string;
  readonly parsed: ParsedDiff | undefined;
}

const parsedDiffs = new Map<string, ParsedDiffCacheEntry>();

export function diffIdentityKey(identity: VcsDiffIdentity): string {
  return JSON.stringify([identity.repositoryId, identity.revision, identity.path]);
}

/** Parse once per stable repository revision and path, including failed parses. */
export function parseCachedDiff(identity: VcsDiffIdentity, patch: string): ParsedDiff | undefined {
  const key = diffIdentityKey(identity);
  const cached = parsedDiffs.get(key);
  if (cached?.patch === patch) {
    // Move the entry to the newest end of the small LRU.
    parsedDiffs.delete(key);
    parsedDiffs.set(key, cached);
    return cached.parsed;
  }
  const parsed = parseUnifiedPatch(patch);
  // The conversation parser caches by patch text; this cache owns repository identity.
  const entry = Object.freeze({
    patch,
    parsed: parsed === undefined ? undefined : Object.freeze({ ...parsed }),
  });
  parsedDiffs.set(key, entry);
  if (parsedDiffs.size > MAX_PARSED_DIFFS) {
    const oldest = parsedDiffs.keys().next().value;
    if (oldest !== undefined) parsedDiffs.delete(oldest);
  }
  return entry.parsed;
}

export function clearParsedDiffCache(): void {
  parsedDiffs.clear();
}
