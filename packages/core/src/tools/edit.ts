/**
 * Edit tool ported from pi's harness edit tool, adapted to June's AgentTool
 * contract and direct filesystem access (pi routes file access through its
 * ExecutionEnv effects boundary). The matching logic lives in edit-diff.ts
 * and is unchanged.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/tools/edit.ts
 */

import { readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { toolResultContent } from "../utils/tool-result.ts";
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
export type { Edit } from "./edit-diff.ts";
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

export interface EditToolInput {
  path: string;
  edits: Edit[];
}

export interface EditToolDetails {
  /** Display-oriented diff of the changes made */
  diff: string;
  /** Standard unified patch of the changes made */
  patch: string;
  /** Line number of the first change in the new file (for editor navigation) */
  firstChangedLine?: number;
}

function editAccessError(path: string, error: unknown): Error {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : String(error);
  return new Error(`Could not edit file: ${path}. Error code: ${code}.`, {
    cause: error instanceof Error ? error : undefined,
  });
}

function parseEditInput(input: unknown): EditToolInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("Edit tool input is invalid. Expected an object.");
  }

  const record = input as Record<string, unknown>;
  if (typeof record.path !== "string") {
    throw new Error("Edit tool input is invalid. path must be a string.");
  }

  let editsValue = record.edits;
  if (typeof editsValue === "string") {
    try {
      editsValue = JSON.parse(editsValue) as unknown;
    } catch {
      // The validation below reports one stable error for malformed and non-array values.
    }
  }

  const edits = Array.isArray(editsValue) ? [...editsValue] : [];
  if (typeof record.oldText === "string" && typeof record.newText === "string") {
    edits.push({ oldText: record.oldText, newText: record.newText });
  }
  if (edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }

  return {
    path: record.path,
    edits: edits.map((edit, index) => {
      if (typeof edit !== "object" || edit === null) {
        throw new Error(`Edit tool input is invalid. edits[${index}] must be an object.`);
      }
      const replacement = edit as Record<string, unknown>;
      if (typeof replacement.oldText !== "string" || typeof replacement.newText !== "string") {
        throw new Error(
          `Edit tool input is invalid. edits[${index}] must contain string oldText and newText.`,
        );
      }
      return { oldText: replacement.oldText, newText: replacement.newText };
    }),
  };
}

export function createEditTool(cwd: string): AgentTool<EditToolInput, EditToolDetails> {
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    parameters: editParametersSchema,
    prepareArguments: parseEditInput,
    async execute(_toolCallId, { path, edits }, signal): Promise<AgentToolResult<EditToolDetails>> {
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

        // Check that the target exists and is an editable file.
        let info: Awaited<ReturnType<typeof fsStat>>;
        try {
          info = await fsStat(absolutePath);
        } catch (error: unknown) {
          throwIfAborted();
          throw editAccessError(path, error);
        }
        if (!info.isFile()) {
          throw new Error(`Could not edit file: ${path}. Path is not a file.`);
        }
        throwIfAborted();

        // Read the file.
        let rawContent: string;
        try {
          rawContent = await fsReadFile(absolutePath, "utf-8");
        } catch (error: unknown) {
          throwIfAborted();
          throw editAccessError(path, error);
        }
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
        try {
          await fsWriteFile(absolutePath, finalContent, "utf-8");
        } catch (error: unknown) {
          throwIfAborted();
          throw editAccessError(path, error);
        }
        throwIfAborted();

        const diffResult = generateDiffString(baseContent, newContent);
        const patch = generateUnifiedPatch(path, baseContent, newContent);
        return {
          content: toolResultContent(`Successfully replaced ${edits.length} block(s) in ${path}.`),
          details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
        };
      });
    },
  };
}
