/**
 * Ls tool ported from pi's tools/ls.ts, adapted to June's AgentTool contract.
 * TUI rendering code from pi is dropped.
 */
import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "../agent-loop.ts";
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

const lsParameters = {
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
} as const;

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
): AgentTool<unknown, LsToolDetails | undefined> {
  const ops = options?.operations ?? defaultLsOperations;
  return {
    name: "ls",
    label: "ls",
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: lsParameters as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, signal?, _onUpdate?) {
      const { path, limit } = parseLsParams(params);
      return new Promise<AgentToolResult<LsToolDetails | undefined>>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }

        const onAbort = () => reject(new Error("Operation aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });

        void (async () => {
          try {
            const dirPath = resolveToCwd(path || ".", cwd);
            const effectiveLimit = limit ?? DEFAULT_LIMIT;

            // Check if path exists.
            if (!(await ops.exists(dirPath))) {
              reject(new Error(`Path not found: ${dirPath}`));
              return;
            }

            // Check if path is a directory.
            const stat = await ops.stat(dirPath);
            if (!stat.isDirectory()) {
              reject(new Error(`Not a directory: ${dirPath}`));
              return;
            }

            // Read directory entries.
            let entries: string[];
            try {
              entries = await ops.readdir(dirPath);
            } catch (e) {
              reject(
                new Error(`Cannot read directory: ${e instanceof Error ? e.message : String(e)}`),
              );
              return;
            }

            // Sort alphabetically, case-insensitive.
            entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

            // Format entries with directory indicators.
            const results: string[] = [];
            let entryLimitReached = false;
            for (const entry of entries) {
              if (results.length >= effectiveLimit) {
                entryLimitReached = true;
                break;
              }

              const fullPath = join(dirPath, entry);
              let suffix = "";
              try {
                const entryStat = await ops.stat(fullPath);
                if (entryStat.isDirectory()) suffix = "/";
              } catch {
                // Skip entries we cannot stat.
                continue;
              }
              results.push(entry + suffix);
            }

            signal?.removeEventListener("abort", onAbort);

            if (results.length === 0) {
              resolve({ content: "(empty directory)", details: undefined });
              return;
            }

            const rawOutput = results.join("\n");
            // Apply byte truncation. There is no separate line limit because entry count is already capped.
            const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
            let output = truncation.content;
            const details: LsToolDetails = {};
            // Build actionable notices for truncation and entry limits.
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
            if (notices.length > 0) {
              output += `\n\n[${notices.join(". ")}]`;
            }

            resolve({
              content: output,
              details: Object.keys(details).length > 0 ? details : undefined,
            });
          } catch (e) {
            signal?.removeEventListener("abort", onAbort);
            reject(e);
          }
        })();
      });
    },
  };
}
