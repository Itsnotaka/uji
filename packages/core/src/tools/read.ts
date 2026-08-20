/**
 * Read tool ported from pi's harness read tool, adapted to June's AgentTool
 * contract and direct filesystem access (pi routes reads through its
 * ExecutionEnv effects boundary). Images are detected by content (magic
 * bytes) and returned as image content parts; conversion/resizing is an
 * injectable processor, never a core dependency (AGENTS.md).
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/tools/read.ts
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { Unsafe } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { toolResultContent } from "../utils/tool-result.ts";
import { detectSupportedImageMimeType } from "./support/image.ts";
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

export type ReadImageProcessorResult =
  | { ok: true; data: string; mimeType: string; hints: string[] }
  | { ok: false; message: string };

/** Converts or resizes one image to inline provider limits. */
export type ReadImageProcessor = (
  bytes: Uint8Array,
  mimeType: string,
  options: { autoResizeImages: boolean },
) => Promise<ReadImageProcessorResult>;

export interface ReadToolOptions {
  /** Whether an injected image processor should resize images. Default: true. */
  autoResizeImages?: boolean;
  /** Optional image conversion/resizing implementation. */
  imageProcessor?: ReadImageProcessor;
}

const readParameters = Unsafe<ReadToolInput>({
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
});

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
): AgentTool<typeof readParameters, ReadToolDetails | undefined> {
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: readParameters,
    prepareArguments: parseReadParams,
    async execute(_toolCallId, { path, offset, limit }, signal?) {
      const throwIfAborted = (): void => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };

      throwIfAborted();
      const absolutePath = await resolveReadPathAsync(path, cwd);
      throwIfAborted();
      const buffer = await fsReadFile(absolutePath);
      throwIfAborted();

      const mimeType = detectSupportedImageMimeType(buffer);
      if (mimeType !== undefined) {
        return readImage(buffer, mimeType, options);
      }

      const textContent = buffer.toString("utf-8");
      const allLines = textContent.split("\n");
      const totalFileLines = allLines.length;
      // Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      const startLineDisplay = startLine + 1;
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
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
      let details: ReadToolDetails | undefined;
      if (truncation.firstLineExceedsLimit) {
        // First line alone exceeds the byte limit. Point the model at a bash fallback.
        const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"));
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
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        // User-specified limit stopped early, but the file still has more content.
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      } else {
        // No truncation and no remaining user-limited content.
        outputText = truncation.content;
      }

      return { content: toolResultContent(outputText), details };
    },
  };
}

async function readImage(
  buffer: Buffer,
  mimeType: string,
  options: ReadToolOptions | undefined,
): Promise<AgentToolResult<ReadToolDetails | undefined>> {
  if (options?.imageProcessor) {
    const processed = await options.imageProcessor(buffer, mimeType, {
      autoResizeImages: options.autoResizeImages ?? true,
    });
    if (!processed.ok) {
      return {
        content: toolResultContent(`Read image file [${mimeType}]\n${processed.message}`),
        details: undefined,
      };
    }
    const hints = processed.hints.length > 0 ? `\n${processed.hints.join("\n")}` : "";
    return {
      content: [
        { type: "text", text: `Read image file [${processed.mimeType}]${hints}` },
        { type: "image", data: processed.data, mimeType: processed.mimeType },
      ],
      details: undefined,
    };
  }
  // BMP is not accepted by providers; converting it needs an image library,
  // which stays out of core (AGENTS.md: processing is injectable).
  if (mimeType === "image/bmp") {
    return {
      content: toolResultContent(
        "Read image file [image/bmp]\n[Image omitted: configure an imageProcessor to convert BMP images.]",
      ),
      details: undefined,
    };
  }
  return {
    content: [
      { type: "text", text: `Read image file [${mimeType}]` },
      { type: "image", data: buffer.toString("base64"), mimeType },
    ],
    details: undefined,
  };
}
