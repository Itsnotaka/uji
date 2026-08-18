/**
 * Write tool ported from pi's harness write tool, adapted to June's AgentTool
 * contract and direct filesystem access (pi routes writes through its
 * ExecutionEnv effects boundary).
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/tools/write.ts
 */
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "../types.ts";
import { toolResultContent } from "../utils/tool-result.ts";
import { withFileMutationQueue } from "./support/file-mutation-queue.ts";
import { resolveToCwd } from "./support/path-utils.ts";

export interface WriteToolInput {
  /** Path to the file to write (relative or absolute) */
  path: string;
  /** Content to write to the file */
  content: string;
}

const writeParameters: Record<string, unknown> = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the file to write (relative or absolute)",
    },
    content: {
      type: "string",
      description: "Content to write to the file",
    },
  },
  required: ["path", "content"],
};

function parseWriteParams(params: unknown): WriteToolInput {
  if (typeof params !== "object" || params === null) {
    throw new Error("Invalid arguments for write: expected an object");
  }
  const { path, content } = params as Record<string, unknown>;
  if (typeof path !== "string") {
    throw new Error('Invalid arguments for write: "path" must be a string');
  }
  if (typeof content !== "string") {
    throw new Error('Invalid arguments for write: "content" must be a string');
  }
  return { path, content };
}

export function createWriteTool(cwd: string): AgentTool<WriteToolInput, undefined> {
  return {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeParameters,
    prepareArguments: parseWriteParams,
    async execute(_toolCallId, { path, content }, signal?, _onUpdate?) {
      const absolutePath = resolveToCwd(path, cwd);
      return withFileMutationQueue(absolutePath, async () => {
        // Do not reject from an abort event listener here: that would release the
        // mutation queue while an in-flight filesystem operation may still finish.
        // Checking signal.aborted after each await observes the same aborts while
        // keeping the queue locked until the current operation has settled.
        const throwIfAborted = (): void => {
          if (signal?.aborted) throw new Error("Operation aborted");
        };

        throwIfAborted();
        // Create parent directories if needed.
        await fsMkdir(dirname(absolutePath), { recursive: true });
        throwIfAborted();

        // Write the file contents.
        await fsWriteFile(absolutePath, content, "utf-8");
        throwIfAborted();

        return {
          content: toolResultContent(`Successfully wrote ${content.length} bytes to ${path}`),
          details: undefined,
        };
      });
    },
  };
}
