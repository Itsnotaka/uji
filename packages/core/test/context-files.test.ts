import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  formatContextFilesForPrompt,
  loadProjectContextFiles,
} from "../src/plugins/builtin/context-files.ts";
import type { ContextFile } from "../src/plugins/builtin/context-files.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "uji-context-")));
  temporaryDirectories.push(directory);
  return directory;
}

/** The walk continues above the temp root; keep assertions to files inside it. */
function underRoot(files: ContextFile[], root: string): ContextFile[] {
  return files.filter((file) => file.path.startsWith(`${root}${sep}`));
}

void describe("context files", () => {
  void test("prefers AGENTS.override.md over AGENTS.md over CLAUDE.md per directory", () => {
    const root = tempDir();
    writeFileSync(join(root, "CLAUDE.md"), "claude");
    writeFileSync(join(root, "AGENTS.md"), "agents");
    writeFileSync(join(root, "AGENTS.override.md"), "override");

    const files = underRoot(loadProjectContextFiles({ cwd: root }), root);

    assert.deepEqual(files, [{ path: join(root, "AGENTS.override.md"), content: "override" }]);
  });

  void test("collects global dir first, then ancestors outermost-first, cwd last", () => {
    const root = tempDir();
    const globalDir = join(root, "global");
    const project = join(root, "project");
    const nested = join(project, "packages", "app");
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(globalDir, "AGENTS.md"), "global");
    writeFileSync(join(project, "AGENTS.md"), "project");
    writeFileSync(join(nested, "CLAUDE.md"), "nested");

    const files = underRoot(loadProjectContextFiles({ cwd: nested, globalDir }), root);

    assert.deepEqual(files, [
      { path: join(globalDir, "AGENTS.md"), content: "global" },
      { path: join(project, "AGENTS.md"), content: "project" },
      { path: join(nested, "CLAUDE.md"), content: "nested" },
    ]);
  });

  void test("strips a BOM and skips directories named like candidates", () => {
    const root = tempDir();
    mkdirSync(join(root, "AGENTS.override.md"));
    writeFileSync(join(root, "AGENTS.md"), "\uFEFFagents");

    const files = underRoot(loadProjectContextFiles({ cwd: root }), root);

    assert.deepEqual(files, [{ path: join(root, "AGENTS.md"), content: "agents" }]);
  });

  void test("skips the main repo file shadowed by a nested linked worktree's own copy", () => {
    const root = tempDir();
    const mainRepo = join(root, "repo");
    const worktree = join(mainRepo, "wt");
    const worktreeGitDir = join(mainRepo, ".git", "worktrees", "wt");
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(mainRepo, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/feat\n");
    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
    writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(join(mainRepo, "AGENTS.md"), "main");
    writeFileSync(join(worktree, "AGENTS.md"), "worktree");

    const files = underRoot(loadProjectContextFiles({ cwd: worktree }), root);

    assert.deepEqual(files, [{ path: join(worktree, "AGENTS.md"), content: "worktree" }]);
  });

  void test("keeps ancestor inheritance when the worktree has no context file of its own", () => {
    const root = tempDir();
    const mainRepo = join(root, "repo");
    const worktree = join(mainRepo, "wt");
    const worktreeGitDir = join(mainRepo, ".git", "worktrees", "wt");
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(mainRepo, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/feat\n");
    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
    writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(join(mainRepo, "AGENTS.md"), "main");

    const files = underRoot(loadProjectContextFiles({ cwd: worktree }), root);

    assert.deepEqual(files, [{ path: join(mainRepo, "AGENTS.md"), content: "main" }]);
  });

  void test("formats files as a project_context block and returns empty for none", () => {
    assert.equal(formatContextFilesForPrompt([]), "");
    const text = formatContextFilesForPrompt([{ path: "/p/AGENTS.md", content: "rules" }]);
    assert.equal(
      text,
      "<project_context>\n\n" +
        "Project-specific instructions and guidelines:\n\n" +
        '<project_instructions path="/p/AGENTS.md">\nrules\n</project_instructions>\n\n' +
        "</project_context>",
    );
  });
});
