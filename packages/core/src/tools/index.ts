/** Coding tool set ported from pi-coding-agent (read/bash/edit/write/grep/find/ls). */
import type { AgentTool } from "../agent-loop.ts";
import { createBashTool, type BashToolOptions } from "./bash.ts";
import { createEditTool, type EditToolOptions } from "./edit.ts";
import { createFindTool, type FindToolOptions } from "./find.ts";
import { createGrepTool, type GrepToolOptions } from "./grep.ts";
import { createLsTool, type LsToolOptions } from "./ls.ts";
import { createReadTool, type ReadToolOptions } from "./read.ts";
import { createWriteTool, type WriteToolOptions } from "./write.ts";

export * from "./bash.ts";
export * from "./edit.ts";
export * from "./find.ts";
export * from "./grep.ts";
export * from "./ls.ts";
export * from "./read.ts";
export * from "./write.ts";
export { withFileMutationQueue } from "./support/file-mutation-queue.ts";
export * from "./support/truncate.ts";

export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

export interface ToolsOptions {
  read?: ReadToolOptions;
  bash?: BashToolOptions;
  write?: WriteToolOptions;
  edit?: EditToolOptions;
  grep?: GrepToolOptions;
  find?: FindToolOptions;
  ls?: LsToolOptions;
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): AgentTool {
  switch (toolName) {
    case "read":
      return createReadTool(cwd, options?.read);
    case "bash":
      return createBashTool(cwd, options?.bash);
    case "edit":
      return createEditTool(cwd, options?.edit);
    case "write":
      return createWriteTool(cwd, options?.write);
    case "grep":
      return createGrepTool(cwd, options?.grep);
    case "find":
      return createFindTool(cwd, options?.find);
    case "ls":
      return createLsTool(cwd, options?.ls);
    default:
      throw new Error(`Unknown tool name: ${String(toolName)}`);
  }
}

/** Pi's default coding set: read, bash, edit, write. */
export function createCodingTools(cwd: string, options?: ToolsOptions): AgentTool[] {
  return [
    createReadTool(cwd, options?.read),
    createBashTool(cwd, options?.bash),
    createEditTool(cwd, options?.edit),
    createWriteTool(cwd, options?.write),
  ];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): AgentTool[] {
  return [
    createReadTool(cwd, options?.read),
    createGrepTool(cwd, options?.grep),
    createFindTool(cwd, options?.find),
    createLsTool(cwd, options?.ls),
  ];
}

export function createAllTools(cwd: string, options?: ToolsOptions): AgentTool[] {
  return [
    createReadTool(cwd, options?.read),
    createBashTool(cwd, options?.bash),
    createEditTool(cwd, options?.edit),
    createWriteTool(cwd, options?.write),
    createGrepTool(cwd, options?.grep),
    createFindTool(cwd, options?.find),
    createLsTool(cwd, options?.ls),
  ];
}
