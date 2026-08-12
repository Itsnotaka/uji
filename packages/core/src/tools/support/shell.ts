/**
 * Shell helpers for the bash tool, ported from pi's utils/shell.ts and
 * utils/child-process.ts (earendil-works/pi). Kept free of other tools'
 * concerns.
 *
 * Deviations from pi:
 * - getShellEnv no longer prepends pi's managed bin directory to PATH (June
 *   has no equivalent of pi's getBinDir); it returns a copy of process.env.
 * - trackDetachedChildPid/untrackDetachedChildPid are no-ops: in pi they feed
 *   a registry that a SIGHUP/SIGTERM handler uses to kill orphaned detached
 *   children on shutdown. June has no such handler, so the bookkeeping is
 *   kept as an interface seam only.
 * - pi's spawnProcess/spawnProcessSync cross-spawn wrappers are not ported
 *   (the bash tool spawns the shell directly).
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface ShellConfig {
  shell: string;
  args: string[];
  commandTransport?: "argv" | "stdin";
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function isLegacyWslBashPath(path: string): boolean {
  const normalized = path.replace(/\//g, "\\").toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
  return isLegacyWslBashPath(shell)
    ? { shell, args: ["-s"], commandTransport: "stdin" }
    : { shell, args: ["-c"] };
}

function findBashOnPath(): string | null {
  if (process.platform === "win32") {
    // Windows: Use 'where' and verify file exists (where can return non-existent paths)
    try {
      const result = spawnSync("where", ["bash.exe"], {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
      });
      if (result.status === 0 && result.stdout) {
        const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
        if (firstMatch && existsSync(firstMatch)) {
          return firstMatch;
        }
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  // Unix: Use 'which' and trust its output (handles Termux and special filesystems)
  try {
    const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch) {
        return firstMatch;
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
  // 1. Check user-specified shell path
  if (customShellPath) {
    if (existsSync(customShellPath)) {
      return getBashShellConfig(customShellPath);
    }
    throw new Error(`Custom shell path not found: ${customShellPath}`);
  }

  if (process.platform === "win32") {
    // 2. Try Git Bash in known locations
    const paths: string[] = [];
    const programFiles = process.env.ProgramFiles;
    if (programFiles) {
      paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
    }
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    if (programFilesX86) {
      paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
    }

    for (const path of paths) {
      if (existsSync(path)) {
        return getBashShellConfig(path);
      }
    }

    // 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
    const bashOnPath = findBashOnPath();
    if (bashOnPath) {
      return getBashShellConfig(bashOnPath);
    }

    throw new Error(
      `No bash shell found. Options:\n` +
        `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
        `  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
        "  3. Set shellPath in settings.json\n\n" +
        `Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
    );
  }

  // Unix: try /bin/bash, then bash on PATH, then fallback to sh
  if (existsSync("/bin/bash")) {
    return getBashShellConfig("/bin/bash");
  }

  const bashOnPath = findBashOnPath();
  if (bashOnPath) {
    return getBashShellConfig(bashOnPath);
  }

  return { shell: "sh", args: ["-c"] };
}

/**
 * Environment for spawned shells. Simplified from pi: pi prepends its managed
 * bin directory to PATH here; June has no managed bin directory, so this is a
 * plain copy of the current process environment.
 */
export function getShellEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
  // Use Array.from to properly iterate over code points (not code units)
  // This handles surrogate pairs correctly and catches edge cases where
  // codePointAt() might return undefined
  return Array.from(str)
    .filter((char) => {
      // Filter out characters that cause string-width to crash
      // This includes:
      // - Unicode format characters
      // - Lone surrogates (already filtered by Array.from)
      // - Control chars except \t \n \r
      // - Characters with undefined code points

      const code = char.codePointAt(0);

      // Skip if code point is undefined (edge case with invalid strings)
      if (code === undefined) return false;

      // Allow tab, newline, carriage return
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

      // Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0d)
      if (code <= 0x1f) return false;

      // Filter out Unicode format characters
      if (code >= 0xfff9 && code <= 0xfffb) return false;

      return true;
    })
    .join("");
}

/**
 * No-op in June. In pi this registers detached child pids so a parent
 * shutdown-signal handler can kill them; June has no such handler.
 */
export function trackDetachedChildPid(_pid: number): void {}

/** No-op in June; see trackDetachedChildPid. */
export function untrackDetachedChildPid(_pid: number): void {}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    // Use taskkill on Windows to kill process tree
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
    } catch {
      // Ignore errors if taskkill fails
    }
  } else {
    // Use SIGKILL on Unix/Linux/Mac
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Fallback to killing just the child if process group kill fails
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process already dead
      }
    }
  }
}

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * A short-lived child can `exit` while a detached descendant keeps its stdout/stderr
 * pipe open. We must not resolve and destroy the streams on a fixed deadline measured
 * from `exit`, or output still being written past that deadline is silently lost
 * (earendil-works/pi#5303). Instead, after `exit` we wait for the pipes to fall idle:
 * the grace timer is re-armed on every chunk, so an actively writing descendant keeps
 * us reading, while a quiet inherited handle (e.g. a Windows daemonized descendant
 * that never lets `close` fire) still releases us after the grace elapses.
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) {
        finalize(exitCode);
      }
    };

    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };

    const onData = () => {
      // Output is still arriving after exit; defer finalizing so we don't
      // destroy the stream mid-write and truncate the tail.
      if (exited && !settled) armIdleTimer();
    };

    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };

    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) {
        armIdleTimer();
      }
    };

    const onClose = (code: number | null) => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}
