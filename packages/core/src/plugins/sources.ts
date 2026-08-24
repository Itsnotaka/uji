/**
 * Finds plugins and turns them into `LoadedPlugin`s. Built-ins come first,
 * then files from each directory in order; a file whose id matches an earlier
 * plugin replaces it in place, a new id is appended. A manifest can disable
 * ids and set options; it never has to list anything.
 *
 * A file's version is its mtime and size, so an edit gives the host a new
 * version and `import()` with a changed query string gives Node a new module.
 */
import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonValue } from "@uji-ai/schema";
import { isPlugin, type LoadedPlugin, type Plugin, type PluginSource } from "./types.ts";

type ManifestPluginRef = { id: string; options?: JsonValue };

function isPluginRef(item: string | ManifestPluginRef): item is ManifestPluginRef {
  return typeof item !== "string";
}

function hasDefaultExport(value: unknown): value is { default: unknown } {
  return typeof value === "object" && value !== null && "default" in value;
}

export interface PluginManifest {
  /** Strings are ids to disable when prefixed with "-"; objects set a plugin's options. */
  plugins?: readonly (string | ManifestPluginRef)[];
}

export interface PluginDirectory {
  path: string;
  source: Exclude<PluginSource, "builtin" | "inline">;
}

export interface LoadFailure {
  path: string;
  error: string;
}

export interface ResolvedPlugins {
  plugins: LoadedPlugin[];
  failures: LoadFailure[];
}

export interface ResolveOptions {
  builtins: readonly Plugin[];
  directories?: readonly PluginDirectory[];
  manifest?: PluginManifest;
  /** Version stamped on built-ins. Defaults to a constant, so built-ins never reload. */
  builtinVersion?: string;
  /** Per-built-in versions for stateful built-ins whose external inputs can change. */
  builtinVersions?: Readonly<Record<string, string>>;
}

const ENTRY_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs"]);

export async function resolvePlugins(options: ResolveOptions): Promise<ResolvedPlugins> {
  const byId = new Map<string, LoadedPlugin>();
  const failures: LoadFailure[] = [];
  for (const plugin of options.builtins) {
    byId.set(plugin.id, {
      id: plugin.id,
      version: options.builtinVersions?.[plugin.id] ?? options.builtinVersion ?? "builtin",
      source: "builtin",
      module: plugin,
    });
  }
  for (const directory of options.directories ?? []) {
    for (const entry of await listPluginEntries(directory.path)) {
      const loaded = await loadPluginFile(entry, directory.source);
      if ("error" in loaded) {
        failures.push(loaded);
        continue;
      }
      byId.set(loaded.id, loaded);
    }
  }
  const disabled = new Set<string>();
  const pluginOptions = new Map<string, JsonValue>();
  for (const item of options.manifest?.plugins ?? []) {
    if (isPluginRef(item)) {
      if (item.options !== undefined) pluginOptions.set(item.id, item.options);
      continue;
    }
    if (item.startsWith("-")) disabled.add(item.slice(1));
  }
  const plugins = [...byId.values()]
    .filter((plugin) => !disabled.has(plugin.id))
    .map((plugin) => {
      const value = pluginOptions.get(plugin.id);
      return value === undefined ? plugin : { ...plugin, options: value };
    });
  return { plugins, failures };
}

/** `foo.ts` and `foo/index.ts` are plugin entries; anything else in the directory is ignored. */
async function listPluginEntries(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const entries: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const path = join(directory, name);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) continue;
    if (info.isFile() && ENTRY_EXTENSIONS.has(extname(name))) {
      entries.push(path);
      continue;
    }
    if (!info.isDirectory()) continue;
    for (const candidate of ["index.ts", "index.js", "index.mts", "index.mjs"]) {
      const index = join(path, candidate);
      if ((await stat(index).catch(() => undefined))?.isFile()) {
        entries.push(index);
        break;
      }
    }
  }
  return entries;
}

export async function loadPluginFile(
  path: string,
  source: Exclude<PluginSource, "builtin" | "inline">,
): Promise<LoadedPlugin | LoadFailure> {
  const absolute = resolve(path);
  const id = pluginIdForPath(absolute);
  try {
    const info = await stat(absolute);
    const version = `${info.mtimeMs}:${info.size}`;
    const url = pathToFileURL(absolute);
    url.searchParams.set("v", version);
    const loaded: unknown = await import(url.href);
    const module = hasDefaultExport(loaded) ? loaded.default : undefined;
    if (!isPlugin(module)) {
      return { path: absolute, error: "default export is not a plugin (use definePlugin)" };
    }
    if (module.id !== id) {
      return {
        path: absolute,
        error: `plugin id "${module.id}" must match the file name "${id}"`,
      };
    }
    return { id, version, source, module, path: absolute };
  } catch (error) {
    return { path: absolute, error: error instanceof Error ? error.message : String(error) };
  }
}

/** `.../profile.ts` and `.../profile/index.ts` are both "profile". */
export function pluginIdForPath(path: string): string {
  const file = basename(path, extname(path));
  if (file === "index") return basename(resolve(path, ".."));
  return file;
}

export interface WatchOptions {
  directories: readonly { path: string }[];
  /** Called after a quiet period following any change under the directories. */
  onChange: () => void | Promise<void>;
  debounceMs?: number;
  /** Change handler failures land here instead of being lost. */
  onError?: (error: Error) => void;
}

/**
 * Watch plugin directories and call `onChange` once per burst of edits. A
 * directory that does not exist yet is retried on each burst from the others
 * and on a slow timer, so creating `.uji/plugins` later is picked up. Returns
 * a stop function.
 */
export function watchPluginDirectories(options: WatchOptions): () => void {
  const watchers = new Map<string, FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  let stopped = false;
  const report = options.onError ?? (() => undefined);

  const fire = async (): Promise<void> => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await options.onChange();
    } catch (error) {
      report(error instanceof Error ? error : new Error(String(error)));
    } finally {
      running = false;
      if (pending && !stopped) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      ensureWatchers();
      void fire();
    }, options.debounceMs ?? 150);
  };

  const ensureWatchers = (): void => {
    for (const directory of options.directories) {
      if (watchers.has(directory.path)) continue;
      try {
        const watcher = watch(directory.path, { recursive: true }, () => schedule());
        watcher.on("error", () => {
          watchers.delete(directory.path);
          watcher.close();
          // The native watcher may be unavailable (for example EMFILE). Rescan
          // once now; the existing slow retry will try to restore watching.
          void fire();
        });
        watchers.set(directory.path, watcher);
      } catch {
        // Missing directory; retried on the next burst or tick.
      }
    }
  };

  ensureWatchers();
  const retry = setInterval(ensureWatchers, 5_000);
  retry.unref?.();

  return () => {
    stopped = true;
    clearInterval(retry);
    if (timer !== undefined) clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}
