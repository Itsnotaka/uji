/**
 * Ls tool ported from pi's tools/ls.ts, adapted to June's AgentTool contract.
 * TUI rendering code from pi is dropped.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/ls.ts
 */
import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { Unsafe } from "typebox";
import type { AgentTool } from "../types.ts";
import { toolResultContent } from "../utils/tool-result.ts";
import { pathExists, resolveToCwd } from "./support/path-utils.ts";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./support/truncate.ts";

export interface LsToolInput {
  /** Directory to list (default: current directory) */
  path?: string;
  /** Maximum number of entries to return (default: 500) */
  limit?: number;
}

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
  truncation?: TruncationResult;
  entryLimitReached?: number;
}

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
export interface LsOperations {
  /** Check if path exists */
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  /** Get file or directory stats. Throws if not found. */
  stat: (
    absolutePath: string,
  ) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
  /** Read directory entries */
  readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
  exists: pathExists,
  stat: fsStat,
  readdir: fsReaddir,
};

export interface LsToolOptions {
  /** Custom operations for directory listing. Default: local filesystem */
  operations?: LsOperations;
}

const lsParameters = Unsafe<LsToolInput>({
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Directory to list (default: current directory)",
    },
    limit: {
      type: "number",
      description: "Maximum number of entries to return (default: 500)",
    },
  },
});

function parseLsParams(params: unknown): LsToolInput {
  if (params === undefined || params === null) {
    return {};
  }
  if (typeof params !== "object") {
    throw new Error("Invalid arguments for ls: expected an object");
  }
  const { path, limit } = params as Record<string, unknown>;
  if (path !== undefined && typeof path !== "string") {
    throw new Error('Invalid arguments for ls: "path" must be a string');
  }
  if (limit !== undefined && typeof limit !== "number") {
    throw new Error('Invalid arguments for ls: "limit" must be a number');
  }
  return { path, limit };
}

export function createLsTool(
  cwd: string,
  options?: LsToolOptions,
): AgentTool<typeof lsParameters, LsToolDetails | undefined> {
  const ops = options?.operations ?? defaultLsOperations;
  return {
    name: "ls",
    label: "ls",
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: lsParameters,
    prepareArguments: parseLsParams,
    async execute(_toolCallId, { path, limit }, signal?, _onUpdate?) {
      const throwIfAborted = (): void => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };
      const dirPath = resolveToCwd(path || ".", cwd);
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      throwIfAborted();
      if (!(await ops.exists(dirPath))) throw new Error(`Path not found: ${dirPath}`);
      throwIfAborted();

      const stat = await ops.stat(dirPath);
      throwIfAborted();
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

      let entries: string[];
      try {
        entries = await ops.readdir(dirPath);
      } catch (error) {
        throwIfAborted();
        throw new Error(
          `Cannot read directory: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      throwIfAborted();
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      const results: string[] = [];
      let entryLimitReached = false;
      for (const entry of entries) {
        if (results.length >= effectiveLimit) {
          entryLimitReached = true;
          break;
        }

        throwIfAborted();
        try {
          const entryStat = await ops.stat(join(dirPath, entry));
          throwIfAborted();
          results.push(entry + (entryStat.isDirectory() ? "/" : ""));
        } catch {
          throwIfAborted();
          // A disappearing or unreadable entry does not invalidate the listing.
          continue;
        }
      }

      if (results.length === 0) {
        return { content: toolResultContent("(empty directory)"), details: undefined };
      }

      const truncation = truncateHead(results.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
      });
      let output = truncation.content;
      const details: LsToolDetails = {};
      const notices: string[] = [];
      if (entryLimitReached) {
        notices.push(
          `${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`,
        );
        details.entryLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

      return {
        content: toolResultContent(output),
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  };
}
