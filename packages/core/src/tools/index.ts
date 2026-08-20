/**
 * Coding tool set ported from pi. read/bash/edit/write follow pi-agent-core's
 * harness tools; grep/find/ls come from pi-coding-agent, which is the only pi
 * package that has them.
 *
 * Based on https://github.com/earendil-works/pi/tree/main/packages/agent/src/harness/tools
 * and https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/tools
 */
import type { AgentTool } from "../types.ts";
import { createBashTool, type BashToolOptions } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createFindTool, type FindToolOptions } from "./find.ts";
import { createGrepTool, type GrepToolOptions } from "./grep.ts";
import { createLsTool, type LsToolOptions } from "./ls.ts";
import { createReadTool, type ReadToolOptions } from "./read.ts";
import { createWriteTool } from "./write.ts";

export * from "./bash.ts";
export * from "./edit.ts";
export * from "./find.ts";
export * from "./grep.ts";
export * from "./ls.ts";
export * from "./read.ts";
export * from "./write.ts";
export { withFileMutationQueue } from "./support/file-mutation-queue.ts";
export * from "./support/truncate.ts";

export interface ToolsOptions {
  read?: ReadToolOptions;
  bash?: BashToolOptions;
  grep?: GrepToolOptions;
  find?: FindToolOptions;
  ls?: LsToolOptions;
}

export function createAllTools(cwd: string, options?: ToolsOptions): AgentTool<any, any>[] {
  return [
    createReadTool(cwd, options?.read),
    createBashTool(cwd, options?.bash),
    createEditTool(cwd),
    createWriteTool(cwd),
    createGrepTool(cwd, options?.grep),
    createFindTool(cwd, options?.find),
    createLsTool(cwd, options?.ls),
  ];
}
