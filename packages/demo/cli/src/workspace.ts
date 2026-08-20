/**
 * Workspace facts for the footer: directory name, git branch, dirty marker.
 * Git is invoked with execFile and fixed argument lists; nothing is interpolated
 * into a shell.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface WorkspaceStatus {
  name: string;
  branch?: string;
  dirty: boolean;
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 3000, encoding: "utf8" });
    return stdout;
  } catch {
    return undefined;
  }
}

export async function readWorkspaceStatus(cwd: string): Promise<WorkspaceStatus> {
  const name = basename(cwd) || cwd;
  const head = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head === undefined) return { name, dirty: false };
  let branch = head.trim();
  if (branch === "HEAD") {
    const sha = await git(cwd, ["rev-parse", "--short", "HEAD"]);
    branch = sha === undefined ? "detached" : `@${sha.trim()}`;
  }
  const status = await git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  return { name, branch, dirty: status !== undefined && status.trim() !== "" };
}
