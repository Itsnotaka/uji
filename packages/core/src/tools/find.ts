/**
 * Find tool ported from pi's tools/find.ts, adapted to June's AgentTool
 * contract (no TUI rendering, plain JSON Schema parameters, string content).
 *
 * June deviation: pi lists files with a managed fd binary (ensureTool); fd is
 * not available here, so the file-listing layer is reimplemented with
 * `rg --files` (which respects .gitignore like fd) filtered by ripgrep's glob
 * matching. Schema and result formatting are identical to pi's find tool.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/find.ts
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { toolResultContent } from "../utils/tool-result.ts";
import { pathExists, resolveToCwd } from "./support/path-utils.ts";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "./support/truncate.ts";

/** Relativize a find result against the search root and normalize it to posix separators. */
export function relativizeFindResultPath(
  resultPath: string,
  searchPath: string,
  pathModule: typeof path = path,
): string {
  const hadTrailingSeparator =
    resultPath.endsWith(pathModule.sep) || (pathModule.sep === "\\" && resultPath.endsWith("/"));
  const relativePath = pathModule.isAbsolute(resultPath)
    ? pathModule.relative(searchPath, resultPath)
    : resultPath;
  const posixPath = relativePath.split(pathModule.sep).join("/");
  return hadTrailingSeparator && !posixPath.endsWith("/") ? `${posixPath}/` : posixPath;
}

const findSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    },
    path: { type: "string", description: "Directory to search in (default: current directory)" },
    limit: { type: "number", description: "Maximum number of results (default: 1000)" },
  },
  required: ["pattern"],
};

export interface FindToolInput {
  pattern: string;
  path?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
  truncation?: TruncationResult;
  resultLimitReached?: number;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
  /** Check if path exists */
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  /** Find files matching glob pattern. Returns relative or absolute paths. */
  glob: (
    pattern: string,
    cwd: string,
    options: { ignore: string[]; limit: number },
  ) => Promise<string[]> | string[];
}

export interface FindToolOptions {
  /** Custom operations for find. Default: local filesystem plus ripgrep */
  operations?: FindOperations;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid argument: ${key} must be a string`);
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`Invalid argument: ${key} must be a number`);
  return value;
}

function parseFindInput(params: unknown): FindToolInput {
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
    limit: optionalNumber(record, "limit"),
  };
}

export function createFindTool(
  cwd: string,
  options?: FindToolOptions,
): AgentTool<FindToolInput, FindToolDetails | undefined> {
  const customOps = options?.operations;
  return {
    name: "find",
    label: "find",
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: findSchema,
    prepareArguments: parseFindInput,
    async execute(_toolCallId, { pattern, path: searchDir, limit }, signal) {
      return new Promise<AgentToolResult<FindToolDetails | undefined>>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }

        let settled = false;
        let stopChild: (() => void) | undefined;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          stopChild = undefined;
          fn();
        };
        const onAbort = () => {
          stopChild?.();
          settle(() => reject(new Error("Operation aborted")));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        void (async () => {
          try {
            const searchPath = resolveToCwd(searchDir || ".", cwd);
            const effectiveLimit = limit ?? DEFAULT_LIMIT;

            if (customOps !== undefined) {
              if (!(await customOps.exists(searchPath))) {
                settle(() => reject(new Error(`Path not found: ${searchPath}`)));
                return;
              }
              if (signal?.aborted) {
                settle(() => reject(new Error("Operation aborted")));
                return;
              }
              const results = await customOps.glob(pattern, searchPath, {
                ignore: ["**/node_modules/**", "**/.git/**"],
                limit: effectiveLimit,
              });
              if (signal?.aborted) {
                settle(() => reject(new Error("Operation aborted")));
                return;
              }
              if (results.length === 0) {
                settle(() =>
                  resolve({
                    content: toolResultContent("No files found matching pattern"),
                    details: undefined,
                  }),
                );
                return;
              }

              // Relativize paths against the search root for stable output.
              const relativized = results.map((p) => relativizeFindResultPath(p, searchPath));
              const resultLimitReached = relativized.length >= effectiveLimit;
              const rawOutput = relativized.join("\n");
              const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
              let resultOutput = truncation.content;
              const details: FindToolDetails = {};
              const notices: string[] = [];
              if (resultLimitReached) {
                notices.push(`${effectiveLimit} results limit reached`);
                details.resultLimitReached = effectiveLimit;
              }
              if (truncation.truncated) {
                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                details.truncation = truncation;
              }
              if (notices.length > 0) {
                resultOutput += `\n\n[${notices.join(". ")}]`;
              }
              settle(() =>
                resolve({
                  content: toolResultContent(resultOutput),
                  details: Object.keys(details).length > 0 ? details : undefined,
                }),
              );
              return;
            }

            // Default implementation lists files with `rg --files` (June
            // deviation: pi shells out to fd here).
            const args: string[] = ["--files", "--color=never", "--hidden"];

            // rg (like fd) normally ignores .gitignore outside git repos, so
            // keep --no-require-git there. Inside repos, use the default
            // git-aware behavior so parent .gitignore rules stop at nested
            // repo boundaries:
            // https://github.com/earendil-works/pi/issues/5960
            let insideGitRepo = false;
            for (let current = searchPath; ;) {
              if (await pathExists(path.join(current, ".git"))) {
                insideGitRepo = true;
                break;
              }
              const parent = path.dirname(current);
              if (parent === current) break;
              current = parent;
            }
            if (!insideGitRepo) args.push("--no-require-git");

            // rg globs use gitignore semantics: a slash-free pattern matches
            // basenames at any depth (like fd's default), while a
            // slash-containing pattern is anchored to the search root. Pi's fd
            // path has the same anchoring problem in --full-path mode and
            // solves it by prefixing '**/', so a path-containing pattern like
            // 'src/**/*.spec.ts' matches at any depth. Keep that behavior.
            let effectivePattern = pattern;
            if (pattern.includes("/")) {
              if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
                effectivePattern = `**/${pattern}`;
              }
            }
            args.push("--glob", effectivePattern, "--", searchPath);

            const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
            const rl = createInterface({ input: child.stdout });
            let stderr = "";
            const lines: string[] = [];
            // rg has no --max-results for --files (fd does), so enforce the
            // limit here and kill the child once it is reached.
            let killedDueToLimit = false;

            stopChild = () => {
              if (!child.killed) {
                child.kill();
              }
            };

            const cleanup = () => {
              rl.close();
            };

            child.stderr?.on("data", (chunk) => {
              stderr += chunk.toString();
            });

            rl.on("line", (line) => {
              if (lines.length >= effectiveLimit) return;
              lines.push(line);
              if (lines.length >= effectiveLimit) {
                killedDueToLimit = true;
                stopChild?.();
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

            child.on("close", (code) => {
              cleanup();
              if (signal?.aborted) {
                settle(() => reject(new Error("Operation aborted")));
                return;
              }
              const output = lines.join("\n");
              // rg exits 1 when no files matched; only treat other non-zero
              // codes as errors (fd exits 0 on no matches).
              if (!killedDueToLimit && code !== 0 && code !== 1) {
                const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
                if (!output) {
                  settle(() => reject(new Error(errorMsg)));
                  return;
                }
              }
              if (!output) {
                settle(() =>
                  resolve({
                    content: toolResultContent("No files found matching pattern"),
                    details: undefined,
                  }),
                );
                return;
              }

              const relativized: string[] = [];
              for (const rawLine of lines) {
                const line = rawLine.replace(/\r$/, "").trim();
                if (!line) continue;
                relativized.push(relativizeFindResultPath(line, searchPath));
              }

              const resultLimitReached = relativized.length >= effectiveLimit;
              const rawOutput = relativized.join("\n");
              const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
              let resultOutput = truncation.content;
              const details: FindToolDetails = {};
              const notices: string[] = [];
              if (resultLimitReached) {
                notices.push(
                  `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
                );
                details.resultLimitReached = effectiveLimit;
              }
              if (truncation.truncated) {
                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                details.truncation = truncation;
              }
              if (notices.length > 0) {
                resultOutput += `\n\n[${notices.join(". ")}]`;
              }
              settle(() =>
                resolve({
                  content: toolResultContent(resultOutput),
                  details: Object.keys(details).length > 0 ? details : undefined,
                }),
              );
            });
          } catch (e) {
            if (signal?.aborted) {
              settle(() => reject(new Error("Operation aborted")));
              return;
            }
            const error = e instanceof Error ? e : new Error(String(e));
            settle(() => reject(error));
          }
        })();
      });
    },
  };
}
