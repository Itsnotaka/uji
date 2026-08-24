/**
 * Project context files (AGENTS.md and compatibles) as a system prompt section.
 *
 * Discovery follows pi: one context file per directory (first match of
 * AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD wins), the
 * host's global directory first, then every ancestor of the cwd from the
 * filesystem root down to the cwd itself. A main repo's context file is
 * skipped when a nested linked worktree shadows it with its own copy.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/resource-loader.ts
 * and system-prompt.ts (project context block), findGitPaths from footer-data-provider.ts.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { definePlugin } from "../types.ts";

export const CONTEXT_FILES_PLUGIN_ID = "context-files";

export interface ContextFile {
  readonly path: string;
  readonly content: string;
}

export interface ContextFilesOptions {
  /** Directory holding the user-global context file, e.g. `~/.uji`. */
  readonly globalDir?: string;
  /** Lower renders earlier. Default 10: after the base system prompt, before skills. */
  readonly promptOrder?: number;
}

const CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfe_ff ? content.slice(1) : content;
}

/** Resolve a path to its real form, falling back to the raw path when it does not exist. */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function loadContextFileFromDir(dir: string, warn: (message: string) => void): ContextFile | null {
  for (const filename of CANDIDATES) {
    const filePath = join(dir, filename);
    if (!existsSync(filePath)) continue;
    try {
      if (!statSync(filePath).isFile()) continue;
      return { path: filePath, content: stripBom(readFileSync(filePath, "utf8")) };
    } catch (error) {
      warn(`could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}

interface GitPaths {
  readonly repoDir: string;
  readonly commonGitDir: string;
}

/**
 * Find git metadata paths by walking up from cwd. Handles both regular repos
 * (`.git` is a directory) and linked worktrees (`.git` is a file).
 */
function findGitPaths(cwd: string): GitPaths | null {
  let dir = cwd;
  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          const content = readFileSync(gitPath, "utf8").trim();
          if (content.startsWith("gitdir: ")) {
            const gitDir = resolve(dir, content.slice(8).trim());
            if (!existsSync(join(gitDir, "HEAD"))) return null;
            const commonDirPath = join(gitDir, "commondir");
            const commonGitDir = existsSync(commonDirPath)
              ? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
              : gitDir;
            return { repoDir: dir, commonGitDir };
          }
        } else if (stat.isDirectory()) {
          if (!existsSync(join(gitPath, "HEAD"))) return null;
          return { repoDir: dir, commonGitDir: gitPath };
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The main repo's context file that a nested linked worktree's own copy shadows: both
 * occupy the same logical repository scope, so loading both applies that context twice.
 * Returns undefined when nothing is shadowed, leaving normal ancestor inheritance alone.
 *
 * Returned as realpath, because `git worktree add` writes the `.git`
 * file's `gitdir:` target in realpath form while cwd may still be symlinked
 * (macOS `/tmp` -> `/private/tmp`).
 */
function findShadowedContextFile(cwd: string, warn: (message: string) => void): string | undefined {
  const gitPaths = findGitPaths(cwd);
  if (gitPaths === null) return undefined;
  const commonGitDir = realpathOrSelf(gitPaths.commonGitDir);
  const worktreeRoot = realpathOrSelf(gitPaths.repoDir);
  const mainRepoRoot = dirname(commonGitDir);
  // False for an ordinary repo, where the two are the same dir, and for a sibling
  // worktree (`git worktree add ../feat`), whose main repo is not an ancestor.
  if (!worktreeRoot.startsWith(`${mainRepoRoot}${sep}`)) return undefined;
  // dirname of the common git dir is the main worktree root only when that dir is
  // itself checked out from the same repo. In a bare layout (`proj/.bare` +
  // `proj/main`) it is just the directory holding `.bare`, which tracks nothing; a
  // submodule's gitdir has no `commondir`, so it lands under `.git/modules`.
  if (realpathOrSelf(join(mainRepoRoot, ".git")) !== commonGitDir) return undefined;
  const worktreeContextFile = loadContextFileFromDir(worktreeRoot, warn);
  return worktreeContextFile === null
    ? undefined
    : join(mainRepoRoot, basename(worktreeContextFile.path));
}

/** Global context file first, then ancestors of cwd outermost-first, cwd last. */
export function loadProjectContextFiles(options: {
  cwd: string;
  globalDir?: string;
  warn?: (message: string) => void;
}): ContextFile[] {
  const warn = options.warn ?? (() => undefined);
  const resolvedCwd = resolve(options.cwd);

  const contextFiles: ContextFile[] = [];
  const seenPaths = new Set<string>();

  if (options.globalDir !== undefined) {
    const globalContext = loadContextFileFromDir(resolve(options.globalDir), warn);
    if (globalContext !== null) {
      contextFiles.push(globalContext);
      seenPaths.add(globalContext.path);
    }
  }

  const ancestorContextFiles: ContextFile[] = [];
  const shadowedContextFile = findShadowedContextFile(resolvedCwd, warn);
  let currentDir = resolvedCwd;

  while (true) {
    const contextFile = loadContextFileFromDir(currentDir, warn);
    const isShadowed =
      shadowedContextFile !== undefined &&
      contextFile !== null &&
      realpathOrSelf(contextFile.path) === shadowedContextFile;
    if (contextFile !== null && !isShadowed && !seenPaths.has(contextFile.path)) {
      ancestorContextFiles.unshift(contextFile);
      seenPaths.add(contextFile.path);
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  contextFiles.push(...ancestorContextFiles);
  return contextFiles;
}

/** The `<project_context>` block pi appends to the system prompt. */
export function formatContextFilesForPrompt(files: readonly ContextFile[]): string {
  if (files.length === 0) return "";
  let text = "<project_context>\n\n";
  text += "Project-specific instructions and guidelines:\n\n";
  for (const { path, content } of files) {
    text += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
  }
  text += "</project_context>";
  return text;
}

export function contextFilesPlugin(options: ContextFilesOptions = {}) {
  return definePlugin({
    id: CONTEXT_FILES_PLUGIN_ID,
    session(api) {
      const files = loadProjectContextFiles({
        cwd: api.env.cwd,
        ...(options.globalDir === undefined ? {} : { globalDir: options.globalDir }),
        warn: (message) => api.diagnostics.warn(message),
      });
      const text = formatContextFilesForPrompt(files);
      if (text === "") return;
      api.prompt.add((draft) =>
        draft.set("project-context", { text, order: options.promptOrder ?? 10 }),
      );
    },
  });
}
