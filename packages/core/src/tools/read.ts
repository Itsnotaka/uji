/**
 * Read tool ported from pi's tools/read.ts, adapted to June's AgentTool
 * contract. Image files are not supported: where pi attaches images, June
 * throws instead. TUI rendering code from pi is dropped.
 */
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { extname } from "node:path";
import type { AgentTool, AgentToolResult } from "../agent-loop.ts";
import { resolveReadPathAsync } from "./support/path-utils.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./support/truncate.ts";

export interface ReadToolInput {
  /** Path to the file to read (relative or absolute) */
  path: string;
  /** Line number to start reading from (1-indexed) */
  offset?: number;
  /** Maximum number of lines to read */
  limit?: number;
}

export interface ReadToolDetails {
  truncation?: TruncationResult;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
  /** Read file contents as a Buffer */
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** Check if file is readable (throw if not) */
  access: (absolutePath: string) => Promise<void>;
}

const defaultReadOperations: ReadOperations = {
  readFile: (path) => fsReadFile(path),
  access: (path) => fsAccess(path, constants.R_OK),
};

export interface ReadToolOptions {
  /** Custom operations for file reading. Default: local filesystem */
  operations?: ReadOperations;
}

const readParameters = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the file to read (relative or absolute)",
    },
    offset: {
      type: "number",
      description: "Line number to start reading from (1-indexed)",
    },
    limit: {
      type: "number",
      description: "Maximum number of lines to read",
    },
  },
  required: ["path"],
} as const;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

function isImagePath(absolutePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(absolutePath).toLowerCase());
}

function parseReadParams(params: unknown): ReadToolInput {
  if (typeof params !== "object" || params === null) {
    throw new Error("Invalid arguments for read: expected an object");
  }
  const { path, offset, limit } = params as Record<string, unknown>;
  if (typeof path !== "string") {
    throw new Error('Invalid arguments for read: "path" must be a string');
  }
  if (offset !== undefined && typeof offset !== "number") {
    throw new Error('Invalid arguments for read: "offset" must be a number');
  }
  if (limit !== undefined && typeof limit !== "number") {
    throw new Error('Invalid arguments for read: "limit" must be a number');
  }
  return { path, offset, limit };
}

export function createReadTool(
  cwd: string,
  options?: ReadToolOptions,
): AgentTool<unknown, ReadToolDetails | undefined> {
  const ops = options?.operations ?? defaultReadOperations;
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Text files only (images are not supported yet). Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: readParameters as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, signal?, _onUpdate?) {
      const { path, offset, limit } = parseReadParams(params);
      return new Promise<AgentToolResult<ReadToolDetails | undefined>>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }
        let aborted = false;
        const onAbort = () => {
          aborted = true;
          reject(new Error("Operation aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        void (async () => {
          try {
            const absolutePath = await resolveReadPathAsync(path, cwd);
            if (aborted) return;
            // Check if file exists and is readable.
            await ops.access(absolutePath);
            if (aborted) return;
            if (isImagePath(absolutePath)) {
              throw new Error(
                "Image files are not supported yet — use bash to inspect binary files",
              );
            }
            let details: ReadToolDetails | undefined;
            // Read text content.
            const buffer = await ops.readFile(absolutePath);
            const textContent = buffer.toString("utf-8");
            const allLines = textContent.split("\n");
            const totalFileLines = allLines.length;
            // Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
            const startLine = offset ? Math.max(0, offset - 1) : 0;
            const startLineDisplay = startLine + 1;
            // Check if offset is out of bounds.
            if (startLine >= allLines.length) {
              throw new Error(
                `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
              );
            }
            let selectedContent: string;
            let userLimitedLines: number | undefined;
            // If limit is specified by the user, honor it first. Otherwise truncateHead decides.
            if (limit !== undefined) {
              const endLine = Math.min(startLine + limit, allLines.length);
              selectedContent = allLines.slice(startLine, endLine).join("\n");
              userLimitedLines = endLine - startLine;
            } else {
              selectedContent = allLines.slice(startLine).join("\n");
            }
            // Apply truncation, respecting both line and byte limits.
            const truncation = truncateHead(selectedContent);
            let outputText: string;
            if (truncation.firstLineExceedsLimit) {
              // First line alone exceeds the byte limit. Point the model at a bash fallback.
              const firstLineSize = formatSize(
                Buffer.byteLength(allLines[startLine] ?? "", "utf-8"),
              );
              outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
              details = { truncation };
            } else if (truncation.truncated) {
              // Truncation occurred. Build an actionable continuation notice.
              const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
              const nextOffset = endLineDisplay + 1;
              outputText = truncation.content;
              if (truncation.truncatedBy === "lines") {
                outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
              } else {
                outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
              }
              details = { truncation };
            } else if (
              userLimitedLines !== undefined &&
              startLine + userLimitedLines < allLines.length
            ) {
              // User-specified limit stopped early, but the file still has more content.
              const remaining = allLines.length - (startLine + userLimitedLines);
              const nextOffset = startLine + userLimitedLines + 1;
              outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
            } else {
              // No truncation and no remaining user-limited content.
              outputText = truncation.content;
            }

            if (aborted) return;
            signal?.removeEventListener("abort", onAbort);
            resolve({ content: outputText, details });
          } catch (error) {
            signal?.removeEventListener("abort", onAbort);
            if (!aborted) reject(error);
          }
        })();
      });
    },
  };
}
