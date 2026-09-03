/**
 * Coding tool set ported from pi. read/bash/edit/write follow pi-agent-core's
 * harness tools; ls comes from pi-coding-agent, which is the only pi package
 * that has it. There is no grep or find tool; agents can run search commands
 * through bash.
 *
 * Based on https://github.com/earendil-works/pi/tree/main/packages/agent/src/harness/tools
 * and https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/tools
 */
import type { AgentTool } from "../types.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createLsTool } from "./ls.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

export * from "./bash.ts";
export * from "./edit.ts";
export type { FileMutationDetails } from "./edit-diff.ts";
export * from "./ls.ts";
export * from "./read.ts";
export * from "./write.ts";
export { withFileMutationQueue } from "./support/file-mutation-queue.ts";
export * from "./support/truncate.ts";

export function createAllTools(cwd: string): AgentTool<any, any>[] {
  return [
    createReadTool(cwd),
    createBashTool(cwd),
    createEditTool(cwd),
    createWriteTool(cwd),
    createLsTool(cwd),
  ];
}
