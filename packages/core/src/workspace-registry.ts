/**
 * Durable registry of workspaces a user has opened, for pickers and welcome
 * screens. Follows `WorkspaceTrustStore`: core owns the file format, parsing,
 * and write serialization so hosts never hand-roll a recents store; callers
 * choose the file location, commonly `~/.uji/workspaces.json`.
 *
 * One deliberate divergence from the trust store: reads tolerate bad rows
 * instead of throwing. Trust is a security gate, so a malformed file must
 * surface; recents are UX, and one corrupt row must not brick a welcome
 * screen. Invalid rows are dropped and rewritten away on the next `touch`.
 */
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";

/** One known workspace. `name` is derived presentation, never stored. */
export interface WorkspaceInfo {
  readonly path: string;
  /** The folder's basename, what a picker shows. */
  readonly name: string;
  readonly lastOpenedAt: number;
}

/** The slice of `WorkspaceRegistry` the SDK reads (`UjiOptions.workspaces`). */
export interface WorkspaceRegistryBackend {
  list(): Promise<readonly WorkspaceInfo[]>;
  touch(path: string, now?: number): Promise<void>;
  forget(path: string): Promise<void>;
}

type RegistryFile = Record<string, number>;

function parseRegistryFile(text: string): RegistryFile {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const entries: RegistryFile = {};
  for (const [path, lastOpenedAt] of Object.entries(value)) {
    if (!isAbsolute(path)) continue;
    if (typeof lastOpenedAt !== "number" || !Number.isFinite(lastOpenedAt) || lastOpenedAt < 0) {
      continue;
    }
    entries[path] = lastOpenedAt;
  }
  return entries;
}

function workspaceName(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== "");
  return segments.at(-1) ?? path;
}

export interface WorkspaceRegistryOptions {
  /** Entries kept beyond this are trimmed, oldest first, on `touch`. */
  readonly limit?: number;
}

/**
 * Owns realpath entries and serializes read-modify-write operations, so two
 * hosts touching at once cannot lose each other's writes within one process.
 */
export class WorkspaceRegistry implements WorkspaceRegistryBackend {
  readonly path: string;
  private readonly limit: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(path: string, options: WorkspaceRegistryOptions = {}) {
    if (!isAbsolute(path)) throw new Error("Workspace registry path must be absolute");
    this.path = path;
    this.limit = options.limit ?? 50;
  }

  /** Known workspaces, newest first. */
  list(): Promise<WorkspaceInfo[]> {
    return this.serialized(async () => {
      const entries = Object.entries(await this.read());
      return entries
        .toSorted(([, a], [, b]) => b - a)
        .map(([path, lastOpenedAt]) => ({ path, name: workspaceName(path), lastOpenedAt }));
    });
  }

  /** Record an open. The path must exist; entries are realpaths, so symlinked duplicates collapse. */
  touch(path: string, now = Date.now()): Promise<void> {
    return this.serialized(async () => {
      const realPath = await realpath(resolve(path));
      const entries = await this.read();
      entries[realPath] = now;
      const kept = Object.entries(entries)
        .toSorted(([, a], [, b]) => b - a)
        .slice(0, this.limit);
      await this.write(Object.fromEntries(kept));
    });
  }

  /** Remove a workspace from the list. Works for paths that no longer exist. */
  forget(path: string): Promise<void> {
    return this.serialized(async () => {
      const resolved = resolve(path);
      const realPath = await realpath(resolved).catch(() => undefined);
      const entries = await this.read();
      const before = Object.keys(entries).length;
      delete entries[resolved];
      if (realPath !== undefined) delete entries[realPath];
      if (Object.keys(entries).length !== before) await this.write(entries);
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async read(): Promise<RegistryFile> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return {};
      }
      throw error;
    }
    try {
      return parseRegistryFile(text);
    } catch {
      return {};
    }
  }

  private async write(entries: RegistryFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${String(process.pid)}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
