/**
 * File-backed `ModelsStore` (models-store.json, one entry per provider id).
 * Separate from models-store.ts the way auth/store.ts is separate from
 * auth/credential-store.ts: node:fs stays out of modules a browser bundle can
 * reach through models.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "./models-store.ts";
import { defaultUjiHome } from "./utils/uji-home.ts";

export function defaultModelsStorePath(): string {
  return join(defaultUjiHome(), "models-store.json");
}

/**
 * A catalog cache, not secrets: unreadable content reads as empty and heals
 * on the next write, and a malformed entry surfaces as a per-provider
 * refresh error while the provider's baked models stay usable.
 */
export class FileModelsStore implements ModelsStore {
  private readonly path: string;

  constructor(path: string = defaultModelsStorePath()) {
    this.path = path;
  }

  private load(): Record<string, ModelsStoreEntry> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      return parsed as Record<string, ModelsStoreEntry>;
    } catch {
      return {};
    }
  }

  private save(all: Record<string, ModelsStoreEntry>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, `${JSON.stringify(all, null, 2)}\n`);
  }

  async read(
    providerId: string,
    options?: ModelsStoreOperationOptions,
  ): Promise<ModelsStoreEntry | undefined> {
    options?.signal?.throwIfAborted();
    return this.load()[providerId];
  }

  async write(
    providerId: string,
    entry: ModelsStoreEntry,
    options?: ModelsStoreOperationOptions,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    const all = this.load();
    all[providerId] = entry;
    this.save(all);
  }

  async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    const all = this.load();
    delete all[providerId];
    this.save(all);
  }
}
