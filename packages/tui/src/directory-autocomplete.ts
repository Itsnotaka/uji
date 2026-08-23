import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { resolveDirectory } from "./harness-host.ts";

const MAX_DIRECTORY_RESULTS = 100;

export interface DirectoryCompletionQuery {
  parent: string;
  prefix: string;
}

export interface DirectorySuggestion {
  completion: string;
}

/** The directory argument currently being typed for `/cd`. */
export function directoryCompletionQuery(value: string): DirectoryCompletionQuery | undefined {
  const match = /^\/cd[ \t]+([^\r\n]*)$/.exec(value);
  const argument = match?.[1];
  if (argument === undefined) return undefined;
  if (argument === "~") return { parent: "~/", prefix: "" };

  const slash = argument.lastIndexOf("/");
  const backslash = sep === "\\" ? argument.lastIndexOf("\\") : -1;
  const separator = Math.max(slash, backslash);
  return separator === -1
    ? { parent: "", prefix: argument }
    : {
        parent: argument.slice(0, separator + 1),
        prefix: argument.slice(separator + 1),
      };
}

function completion(query: DirectoryCompletionQuery, name: string): DirectorySuggestion {
  const separator = query.parent.endsWith("\\") ? "\\" : "/";
  return { completion: `${query.parent}${name}${separator}` };
}

/** Read the one directory needed for shell-style `/cd` path completion. */
export async function discoverDirectorySuggestions(
  cwd: string,
  query: DirectoryCompletionQuery,
): Promise<DirectorySuggestion[]> {
  const directory = resolveDirectory(cwd, query.parent === "" ? "." : query.parent);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];

  if (query.prefix.startsWith(".")) {
    for (const name of [".", ".."]) {
      if (name.startsWith(query.prefix)) names.push(name);
    }
  }

  for (const entry of entries) {
    if (!entry.name.startsWith(query.prefix)) continue;
    if (entry.name.startsWith(".") && !query.prefix.startsWith(".")) continue;
    if (entry.isDirectory()) {
      names.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    const info = await stat(join(directory, entry.name)).catch(() => undefined);
    if (info?.isDirectory() === true) names.push(entry.name);
  }

  return names
    .toSorted((left, right) => left.localeCompare(right))
    .slice(0, MAX_DIRECTORY_RESULTS)
    .map((name) => completion(query, name));
}
