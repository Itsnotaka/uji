import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { VcsBackend, VcsDiff, VcsStatus } from "@uji-ai/core";
import type { DesktopVcsSnapshot } from "../shared/ipc.ts";

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const MAX_UNTRACKED_PREVIEW_BYTES = 2_000_000;

class GitCommandError extends Error {
  readonly result: GitResult;

  constructor(args: readonly string[], result: GitResult) {
    super(result.stderr.trim() || `git ${args.join(" ")} exited ${String(result.code)}`);
    this.name = "GitCommandError";
    this.result = result;
  }
}

function runGit(cwd: string, args: readonly string[], allowDifference = false): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? -1,
      };
      if (result.code === 0 || (allowDifference && result.code === 1)) resolveResult(result);
      else reject(new GitCommandError(args, result));
    });
  });
}

interface StatusRead {
  readonly status: VcsStatus;
  readonly raw: string | undefined;
}

async function readStatus(cwd: string): Promise<StatusRead> {
  try {
    const result = await runGit(cwd, [
      "status",
      "--short",
      "--branch",
      "--porcelain=v1",
      "--untracked-files=all",
      "-z",
    ]);
    return { status: parseGitStatus(result.stdout), raw: result.stdout };
  } catch (cause) {
    if (cause instanceof GitCommandError && cause.result.stderr.includes("not a git repository")) {
      return { status: { files: [] }, raw: undefined };
    }
    throw cause;
  }
}

function branchName(record: string): string | undefined {
  const raw = record.slice(3);
  if (raw === "HEAD (no branch)") return undefined;
  const withoutPrefix = raw.replace(/^No commits yet on /, "").replace(/^Initial commit on /, "");
  return withoutPrefix.split("...")[0]?.split(" ")[0] || undefined;
}

function statusKind(code: string): VcsStatus["files"][number]["kind"] {
  if (code === "??") return "untracked";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

export function parseGitStatus(output: string): VcsStatus {
  const records = output.split("\0");
  const files: VcsStatus["files"][number][] = [];
  let branch: string | undefined;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === "") continue;
    if (record.startsWith("## ")) {
      branch = branchName(record);
      continue;
    }
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    files.push({ path, kind: statusKind(code) });
    // With -z, rename/copy records carry the old path as the next NUL field.
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return branch === undefined ? { files } : { branch, files };
}

function safeWorkspacePath(cwd: string, path: string): string {
  const absolute = resolve(cwd, path);
  const within = relative(cwd, absolute);
  if (path === "" || isAbsolute(within) || within === ".." || within.startsWith("../")) {
    throw new Error(`Path is outside the workspace: ${path}`);
  }
  return absolute;
}

async function untrackedPatch(cwd: string, path: string): Promise<string> {
  const absolute = safeWorkspacePath(cwd, path);
  const metadata = await lstat(absolute);
  if (metadata.size > MAX_UNTRACKED_PREVIEW_BYTES)
    return `File is too large to preview: b/${path}\n`;
  const contents = metadata.isSymbolicLink()
    ? Buffer.from(await readlink(absolute), "utf8")
    : await readFile(absolute);
  if (contents.includes(0)) return `Binary file b/${path}\n`;
  return createTwoFilesPatch("/dev/null", `b/${path}`, "", contents.toString("utf8"), "", "");
}

async function trackedPatch(cwd: string, path: string): Promise<string> {
  try {
    return (await runGit(cwd, ["diff", "--no-ext-diff", "--no-color", "HEAD", "--", path])).stdout;
  } catch (error) {
    if (
      !(error instanceof GitCommandError) ||
      (!error.result.stderr.includes("unknown revision") &&
        !error.result.stderr.includes("bad revision") &&
        !error.result.stderr.includes("ambiguous argument 'HEAD'"))
    ) {
      throw error;
    }
    const [staged, unstaged] = await Promise.all([
      runGit(cwd, ["diff", "--cached", "--no-ext-diff", "--no-color", "--", path]),
      runGit(cwd, ["diff", "--no-ext-diff", "--no-color", "--", path]),
    ]);
    return `${staged.stdout}${unstaged.stdout}`;
  }
}

async function fileRevisionPart(cwd: string, path: string): Promise<string> {
  try {
    const metadata = await lstat(safeWorkspacePath(cwd, path), { bigint: true });
    return [
      path,
      metadata.dev,
      metadata.ino,
      metadata.mode,
      metadata.size,
      metadata.mtimeNs,
      metadata.ctimeNs,
    ].join(":");
  } catch {
    return `${path}:missing`;
  }
}

async function repositorySnapshot(cwd: string, read: StatusRead): Promise<DesktopVcsSnapshot> {
  if (read.raw === undefined) {
    return {
      kind: "not_repository",
      repositoryId: cwd,
      revision: "not-repository",
      status: read.status,
    };
  }
  const [root, head, index, files] = await Promise.all([
    runGit(cwd, ["rev-parse", "--show-toplevel"]),
    runGit(cwd, ["rev-parse", "--verify", "HEAD"]).catch((): GitResult => ({
      stdout: "unborn",
      stderr: "",
      code: 0,
    })),
    runGit(cwd, ["ls-files", "--stage", "-z"]),
    Promise.all(read.status.files.map((file) => fileRevisionPart(cwd, file.path))),
  ]);
  const repositoryId = root.stdout.trim() || cwd;
  const revision = createHash("sha256")
    .update(repositoryId)
    .update("\0")
    .update(cwd)
    .update("\0")
    .update(head.stdout)
    .update("\0")
    .update(index.stdout)
    .update("\0")
    .update(read.raw)
    .update("\0")
    .update(files.join("\0"))
    .digest("hex");
  return { kind: "repository", repositoryId, revision, status: read.status };
}

export interface DesktopGitVcs extends VcsBackend {
  readonly snapshot: () => Promise<DesktopVcsSnapshot>;
}

/** Git-backed whole-tree truth for the core workspace.vcs projection. */
export function createGitVcs(cwd: string): DesktopGitVcs {
  const status = async (): Promise<VcsStatus> => {
    return (await readStatus(cwd)).status;
  };

  return {
    status,
    async snapshot() {
      const read = await readStatus(cwd);
      return repositorySnapshot(cwd, read);
    },
    async diff(input): Promise<readonly VcsDiff[]> {
      const snapshot = await status();
      const byPath = new Map(snapshot.files.map((file) => [file.path, file.kind]));
      const paths = input?.paths ?? snapshot.files.map((file) => file.path);
      const diffs = await Promise.all(
        paths.map(async (path): Promise<VcsDiff | undefined> => {
          const kind = byPath.get(path);
          if (kind === undefined) return undefined;
          const patch =
            kind === "untracked" ? await untrackedPatch(cwd, path) : await trackedPatch(cwd, path);
          return patch === "" ? undefined : { path, patch };
        }),
      );
      return diffs.filter((diff): diff is VcsDiff => diff !== undefined);
    },
  };
}
