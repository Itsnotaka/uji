/**
 * A registry is a list of contributions and the state they produce. Rebuild
 * replays every contribution over a fresh draft in plugin order; removing a
 * plugin means dropping its contributions and rebuilding. There is no undo.
 */
import type { HarnessTool } from "../harness/agent-harness.ts";
import type { Disposer, Draft, RegistryDiff, ToolDraft } from "./types.ts";

interface Contribution<D> {
  owner: string;
  /** Plugin position in the activation order. Contributions replay sorted by it, then by registration. */
  order: number;
  fn: (draft: D) => void;
}

export class MapDraft<T> implements Draft<T> {
  protected readonly entries = new Map<string, T>();
  /** Entry id to the plugin that last wrote it. Stamped by the registry as it replays. */
  private readonly ownerById = new Map<string, string>();
  private owner = "";

  /** Host-only: whose contribution is replaying. Never reaches the author-facing `Draft`. */
  beginOwner(owner: string): void {
    this.owner = owner;
  }
  owners(): Map<string, string> {
    return new Map(this.ownerById);
  }

  set(id: string, value: T): void {
    this.entries.set(id, value);
    this.ownerById.set(id, this.owner);
  }
  update(id: string, fn: (current: T) => T): void {
    const current = this.entries.get(id);
    if (current === undefined) throw new Error(`no entry "${id}" to update`);
    this.entries.set(id, fn(current));
    this.ownerById.set(id, this.owner);
  }
  delete(id: string): void {
    this.entries.delete(id);
    this.ownerById.delete(id);
  }
  has(id: string): boolean {
    return this.entries.has(id);
  }
  get(id: string): T | undefined {
    return this.entries.get(id);
  }
  ids(): readonly string[] {
    return [...this.entries.keys()];
  }
  toMap(): Map<string, T> {
    return new Map(this.entries);
  }
}

export class ToolMapDraft extends MapDraft<HarnessTool> implements ToolDraft {
  wrap(id: string, wrap: (inner: HarnessTool["execute"]) => HarnessTool["execute"]): void {
    this.update(id, (tool) => ({ ...tool, execute: wrap(tool.execute) }));
  }
}

type OwnedDraft<T> = {
  toMap(): Map<string, T>;
  beginOwner(owner: string): void;
  owners(): Map<string, string>;
};

export class ContributionRegistry<T, D extends Draft<T>> {
  private contributions: Contribution<D>[] = [];
  private state = new Map<string, T>();
  private ownerById = new Map<string, string>();
  private readonly makeDraft: () => D & OwnedDraft<T>;

  constructor(makeDraft: () => D & OwnedDraft<T>) {
    this.makeDraft = makeDraft;
  }

  add(owner: string, order: number, fn: (draft: D) => void): Disposer {
    const contribution: Contribution<D> = { owner, order, fn };
    this.contributions.push(contribution);
    return () => {
      this.contributions = this.contributions.filter((candidate) => candidate !== contribution);
    };
  }

  rebuild(): RegistryDiff {
    const draft = this.makeDraft();
    const errors: { owner: string; message: string }[] = [];
    const ordered = [...this.contributions].sort((a, b) => a.order - b.order);
    for (const contribution of ordered) {
      draft.beginOwner(contribution.owner);
      try {
        contribution.fn(draft);
      } catch (error) {
        errors.push({
          owner: contribution.owner,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const next = draft.toMap();
    const diff = diffMaps(this.state, next);
    this.state = next;
    this.ownerById = draft.owners();
    return { ...diff, errors };
  }

  current(): ReadonlyMap<string, T> {
    return this.state;
  }

  /** Plugin that last wrote this entry, for provenance a client renders. */
  owner(id: string): string | undefined {
    return this.ownerById.get(id);
  }

  get(id: string): T | undefined {
    return this.state.get(id);
  }

  values(): T[] {
    return [...this.state.values()];
  }
}

function diffMaps<T>(
  before: ReadonlyMap<string, T>,
  after: ReadonlyMap<string, T>,
): Omit<RegistryDiff, "errors"> {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, value] of after) {
    if (!before.has(id)) added.push(id);
    else if (before.get(id) !== value) changed.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added, removed, changed };
}
