/**
 * Grep tool ported from pi's tools/grep.ts, adapted to June's AgentTool
 * contract (no TUI rendering, plain JSON Schema parameters, string content).
 *
 * June deviation: pi obtains ripgrep via a managed download (ensureTool);
 * June spawns `rg` from PATH and fails with a clear error when it is missing.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/grep.ts
 */
import { spawn } from "node:child_process";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { toolResultContent } from "../utils/tool-result.ts";
import { resolveToCwd } from "./support/path-utils.ts";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  type TruncationResult,
  truncateHead,
  truncateLine,
} from "./support/truncate.ts";

const grepSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Search pattern (regex or literal string)" },
    path: {
      type: "string",
      description: "Directory or file to search (default: current directory)",
    },
    glob: {
      type: "string",
      description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
    },
    ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
    literal: {
      type: "boolean",
      description: "Treat pattern as literal string instead of regex (default: false)",
    },
    context: {
      type: "number",
      description: "Number of lines to show before and after each match (default: 0)",
    },
    limit: {
      type: "number",
      description: "Maximum number of matches to return (default: 100)",
    },
  },
  required: ["pattern"],
};

export interface GrepToolInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
  truncation?: TruncationResult;
  matchLimitReached?: number;
  linesTruncated?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
  /** Check if path is a directory. Throws if path does not exist. */
  isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
  /** Read file contents for context lines */
  readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
  isDirectory: async (p) => (await fsStat(p)).isDirectory(),
  readFile: (p) => fsReadFile(p, "utf-8"),
};

export interface GrepToolOptions {
  /** Custom operations for grep. Default: local filesystem plus ripgrep */
  operations?: GrepOperations;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid argument: ${key} must be a string`);
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid argument: ${key} must be a boolean`);
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`Invalid argument: ${key} must be a number`);
  return value;
}

function parseGrepInput(params: unknown): GrepToolInput {
  if (typeof params !== "object" || params === null) {
    throw new Error("Invalid arguments: expected an object");
  }
  const record = params as Record<string, unknown>;
  if (typeof record.pattern !== "string") {
    throw new Error("Invalid argument: pattern must be a string");
  }
  return {
    pattern: record.pattern,
    path: optionalString(record, "path"),
    glob: optionalString(record, "glob"),
    ignoreCase: optionalBoolean(record, "ignoreCase"),
    literal: optionalBoolean(record, "literal"),
    context: optionalNumber(record, "context"),
    limit: optionalNumber(record, "limit"),
  };
}

export function createGrepTool(
  cwd: string,
  options?: GrepToolOptions,
): AgentTool<GrepToolInput, GrepToolDetails | undefined> {
  const customOps = options?.operations;
  return {
    name: "grep",
    label: "grep",
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    parameters: grepSchema,
    prepareArguments: parseGrepInput,
    async execute(
      _toolCallId,
      { pattern, path: searchDir, glob, ignoreCase, literal, context, limit },
      signal,
    ) {
      return new Promise<AgentToolResult<GrepToolDetails | undefined>>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }
        let settled = false;
        const settle = (fn: () => void) => {
          if (!settled) {
            settled = true;
            fn();
          }
        };

        void (async () => {
          try {
            const searchPath = resolveToCwd(searchDir || ".", cwd);
            const ops = customOps ?? defaultGrepOperations;
            let isDirectory: boolean;
            try {
              isDirectory = await ops.isDirectory(searchPath);
            } catch {
              settle(() => reject(new Error(`Path not found: ${searchPath}`)));
              return;
            }

            const contextValue = context && context > 0 ? context : 0;
            const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
            const formatPath = (filePath: string): string => {
              if (isDirectory) {
                const relative = path.relative(searchPath, filePath);
                if (relative && !relative.startsWith("..")) {
                  return relative.replace(/\\/g, "/");
                }
              }
              return path.basename(filePath);
            };

            const fileCache = new Map<string, string[]>();
            const getFileLines = async (filePath: string): Promise<string[]> => {
              let lines = fileCache.get(filePath);
              if (!lines) {
                try {
                  const content = await ops.readFile(filePath);
                  lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
                } catch {
                  lines = [];
                }
                fileCache.set(filePath, lines);
              }
              return lines;
            };

            const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
            if (ignoreCase) args.push("--ignore-case");
            if (literal) args.push("--fixed-strings");
            if (glob) args.push("--glob", glob);
            args.push("--", pattern, searchPath);

            const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
            const rl = createInterface({ input: child.stdout });
            let stderr = "";
            let matchCount = 0;
            let matchLimitReached = false;
            let linesTruncated = false;
            let aborted = false;
            let killedDueToLimit = false;
            const outputLines: string[] = [];

            const cleanup = () => {
              rl.close();
              signal?.removeEventListener("abort", onAbort);
            };
            const stopChild = (dueToLimit = false) => {
              if (!child.killed) {
                killedDueToLimit = dueToLimit;
                child.kill();
              }
            };
            const onAbort = () => {
              aborted = true;
              stopChild();
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            child.stderr?.on("data", (chunk) => {
              stderr += chunk.toString();
            });

            const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
              const relativePath = formatPath(filePath);
              const lines = await getFileLines(filePath);
              if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
              const block: string[] = [];
              const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
              const end =
                contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
              for (let current = start; current <= end; current++) {
                const lineText = lines[current - 1] ?? "";
                const sanitized = lineText.replace(/\r/g, "");
                const isMatchLine = current === lineNumber;
                // Truncate long lines so grep output stays compact.
                const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                if (wasTruncated) linesTruncated = true;
                if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
                else block.push(`${relativePath}-${current}- ${truncatedText}`);
              }
              return block;
            };

            // Collect matches during streaming, then format them after rg exits.
            const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
            rl.on("line", (line) => {
              if (!line.trim() || matchCount >= effectiveLimit) return;
              let event: unknown;
              try {
                event = JSON.parse(line);
              } catch {
                return;
              }
              const record = event as {
                type?: string;
                data?: {
                  path?: { text?: string };
                  line_number?: number;
                  lines?: { text?: string };
                };
              };
              if (record.type === "match") {
                matchCount++;
                const filePath = record.data?.path?.text;
                const lineNumber = record.data?.line_number;
                const lineText = record.data?.lines?.text;
                if (filePath && typeof lineNumber === "number") {
                  matches.push({ filePath, lineNumber, lineText });
                }
                if (matchCount >= effectiveLimit) {
                  matchLimitReached = true;
                  stopChild(true);
                }
              }
            });

            child.on("error", (error) => {
              cleanup();
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                settle(() => reject(new Error("ripgrep (rg) not found on PATH")));
                return;
              }
              settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
            });
            child.on("close", async (code) => {
              cleanup();
              if (aborted) {
                settle(() => reject(new Error("Operation aborted")));
                return;
              }
              if (!killedDueToLimit && code !== 0 && code !== 1) {
                const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
                settle(() => reject(new Error(errorMsg)));
                return;
              }
              if (matchCount === 0) {
                settle(() =>
                  resolve({ content: toolResultContent("No matches found"), details: undefined }),
                );
                return;
              }

              // Format matches after streaming finishes so custom readFile() backends can be async.
              for (const match of matches) {
                if (contextValue === 0 && match.lineText !== undefined) {
                  const relativePath = formatPath(match.filePath);
                  const sanitized = match.lineText
                    .replace(/\r\n/g, "\n")
                    .replace(/\r/g, "")
                    .replace(/\n$/, "");
                  const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                  if (wasTruncated) linesTruncated = true;
                  outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
                } else {
                  const block = await formatBlock(match.filePath, match.lineNumber);
                  outputLines.push(...block);
                }
              }

              const rawOutput = outputLines.join("\n");
              // Apply byte truncation. There is no line limit here because the match limit already capped rows.
              const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
              let output = truncation.content;
              const details: GrepToolDetails = {};
              // Build actionable notices for truncation and match limits.
              const notices: string[] = [];
              if (matchLimitReached) {
                notices.push(
                  `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
                );
                details.matchLimitReached = effectiveLimit;
              }
              if (truncation.truncated) {
                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                details.truncation = truncation;
              }
              if (linesTruncated) {
                notices.push(
                  `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
                );
                details.linesTruncated = true;
              }
              if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
              settle(() =>
                resolve({
                  content: toolResultContent(output),
                  details: Object.keys(details).length > 0 ? details : undefined,
                }),
              );
            });
          } catch (err) {
            settle(() => reject(err as Error));
          }
        })();
      });
    },
  };
}
