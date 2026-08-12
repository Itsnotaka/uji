/**
 * Edit tool ported from pi (earendil-works) tools/edit.ts, adapted to June's
 * AgentTool contract. TUI preview rendering was dropped; the matching logic
 * lives in edit-diff.ts and is unchanged.
 */

import { constants } from "node:fs";
import {
  access as fsAccess,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "../agent-loop.ts";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  type Edit,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./support/file-mutation-queue.ts";
import { resolveToCwd } from "./support/path-utils.ts";

const editParametersSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the file to edit (relative or absolute)",
    },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          oldText: {
            type: "string",
            description:
              "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
          },
          newText: {
            type: "string",
            description: "Replacement text for this targeted edit.",
          },
        },
        required: ["oldText", "newText"],
      },
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    },
  },
  required: ["path", "edits"],
};

export const editToolSystemPromptContribution = {
  snippet:
    "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
  guidelines: [
    "Use edit for precise changes (edits[].oldText must match exactly)",
    "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
    "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
    "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
  ],
} as const;

export interface EditToolInput {
  path: string;
  edits: Edit[];
}

type LegacyEditToolInput = EditToolInput & {
  oldText?: unknown;
  newText?: unknown;
};

export interface EditToolDetails {
  /** Display-oriented diff of the changes made */
  diff: string;
  /** Standard unified patch of the changes made */
  patch: string;
  /** Line number of the first change in the new file (for editor navigation) */
  firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
  /** Read file contents as a Buffer */
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** Write content to a file */
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** Check if file is readable and writable (throw if not) */
  access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
  /** Custom operations for file editing. Default: local filesystem */
  operations?: EditOperations;
}

function prepareEditArguments(input: unknown): EditToolInput {
  if (!input || typeof input !== "object") {
    return input as EditToolInput;
  }

  const args = input as Record<string, unknown>;

  // Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {}
  }

  const legacy = args as unknown as LegacyEditToolInput;
  if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
    return args as unknown as EditToolInput;
  }

  const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
  edits.push({ oldText: legacy.oldText, newText: legacy.newText });
  const { oldText: _oldText, newText: _newText, ...rest } = legacy;
  return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
  if (typeof input?.path !== "string") {
    throw new Error("Edit tool input is invalid. path must be a string.");
  }
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  return { path: input.path, edits: input.edits };
}

export function createEditTool(
  cwd: string,
  options?: EditToolOptions,
): AgentTool<unknown, EditToolDetails> {
  const ops = options?.operations ?? defaultEditOperations;
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    parameters: editParametersSchema,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<EditToolDetails>> {
      const { path, edits } = validateEditInput(prepareEditArguments(params));
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

        // Check if file exists.
        try {
          await ops.access(absolutePath);
        } catch (error: unknown) {
          throwIfAborted();
          const errorMessage =
            error instanceof Error && "code" in error
              ? `Error code: ${String(error.code)}`
              : String(error);
          throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
        }
        throwIfAborted();

        // Read the file.
        const buffer = await ops.readFile(absolutePath);
        const rawContent = buffer.toString("utf-8");
        throwIfAborted();

        // Strip BOM before matching. The model will not include an invisible BOM in oldText.
        const { bom, text: content } = stripBom(rawContent);
        const originalEnding = detectLineEnding(content);
        const normalizedContent = normalizeToLF(content);
        const { baseContent, newContent } = applyEditsToNormalizedContent(
          normalizedContent,
          edits,
          path,
        );
        throwIfAborted();

        const finalContent = bom + restoreLineEndings(newContent, originalEnding);
        await ops.writeFile(absolutePath, finalContent);
        throwIfAborted();

        const diffResult = generateDiffString(baseContent, newContent);
        const patch = generateUnifiedPatch(path, baseContent, newContent);
        return {
          content: `Successfully replaced ${edits.length} block(s) in ${path}.`,
          details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
        };
      });
    },
  };
}
