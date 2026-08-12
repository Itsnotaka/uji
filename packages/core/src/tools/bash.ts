/**
 * Bash tool ported from pi's tools/bash.ts (earendil-works/pi), adapted to
 * June's AgentTool contract. TUI rendering, extension/session context, and
 * experimental sampling are dropped; the BashOperations abstraction is kept
 * so command execution can be delegated to remote systems (for example SSH).
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "../agent-loop.ts";
import { OutputAccumulator } from "./support/output-accumulator.ts";
import {
  getShellConfig,
  getShellEnv,
  killProcessTree,
  sanitizeBinaryOutput,
  trackDetachedChildPid,
  untrackDetachedChildPid,
  waitForChildProcess,
} from "./support/shell.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
} from "./support/truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }

  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutMs;
}

/** JSON Schema for the bash tool arguments (hand-converted from pi's TypeBox schema). */
const bashParameters: Record<string, unknown> = {
  type: "object",
  properties: {
    command: { type: "string", description: "Bash command to execute" },
    timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
  },
  required: ["command"],
};

export interface BashToolInput {
  command: string;
  timeout?: number;
}

function parseBashToolInput(params: unknown): BashToolInput {
  if (typeof params !== "object" || params === null) {
    throw new Error("Invalid arguments: expected an object with a command string");
  }
  const { command, timeout } = params as Record<string, unknown>;
  if (typeof command !== "string") {
    throw new Error("Invalid arguments: command must be a string");
  }
  if (timeout !== undefined && typeof timeout !== "number") {
    throw new Error("Invalid arguments: timeout must be a number of seconds");
  }
  return { command, timeout };
}

export interface BashToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
  /**
   * Execute a command and stream output.
   * @param command The command to execute
   * @param cwd Working directory
   * @param options Execution options
   * @returns Promise resolving to exit code (null if killed)
   */
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using the built-in local shell execution backend.
 *
 * This is useful for callers that intercept bash execution and still want the
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      const shellConfig = getShellConfig(options?.shellPath);
      try {
        await fsAccess(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }

      const commandFromStdin = shellConfig.commandTransport === "stdin";
      const child = spawn(
        shellConfig.shell,
        commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
        {
          cwd,
          detached: process.platform !== "win32",
          env: env ?? getShellEnv(),
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      if (commandFromStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(command);
      }
      if (child.pid) trackDetachedChildPid(child.pid);
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const onAbort = () => {
        if (child.pid) killProcessTree(child.pid);
      };

      try {
        // Set timeout if provided.
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) killProcessTree(child.pid);
          }, timeoutMs);
        }
        // Stream stdout and stderr.
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        // Handle abort signal by killing the entire process tree.
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        // Handle shell spawn errors and wait for the process to terminate without hanging
        // on inherited stdio handles held by detached descendants.
        const exitCode = await waitForChildProcess(child);
        if (signal?.aborted) {
          throw new Error("aborted");
        }
        if (timedOut) {
          throw new Error(`timeout:${timeout}`);
        }
        return { exitCode };
      } finally {
        if (child.pid) untrackDetachedChildPid(child.pid);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

export interface BashSpawnContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
  command: string,
  cwd: string,
  spawnHook: BashSpawnHook | undefined,
): BashSpawnContext {
  const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
  return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
  /** Custom operations for command execution. Default: local shell */
  operations?: BashOperations;
  /** Command prefix prepended to every command (for example shell setup commands) */
  commandPrefix?: string;
  /** Optional explicit shell path from settings */
  shellPath?: string;
  /** Hook to adjust command, cwd, or env before execution */
  spawnHook?: BashSpawnHook;
}

const BASH_UPDATE_THROTTLE_MS = 100;

/** Bash tool: run a command in the working directory with streamed, truncated output. */
export function createBashTool(
  cwd: string,
  options?: BashToolOptions,
): AgentTool<unknown, BashToolDetails | undefined> {
  const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
  const commandPrefix = options?.commandPrefix;
  const spawnHook = options?.spawnHook;
  return {
    name: "bash",
    label: "bash",
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: bashParameters,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<BashToolDetails | undefined>,
    ): Promise<AgentToolResult<BashToolDetails | undefined>> {
      const { command, timeout } = parseBashToolInput(params);
      const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
      const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
      const output = new OutputAccumulator({ tempFilePrefix: "june-bash" });
      let acceptingOutput = true;
      let updateTimer: NodeJS.Timeout | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;

      const emitOutputUpdate = () => {
        if (!onUpdate || !updateDirty) return;
        updateDirty = false;
        lastUpdateAt = Date.now();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        onUpdate({
          content: sanitizeBinaryOutput(snapshot.content) || "",
          details: {
            truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
            fullOutputPath: snapshot.fullOutputPath,
          },
        });
      };

      const clearUpdateTimer = () => {
        if (updateTimer) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
        }
      };

      const scheduleOutputUpdate = () => {
        if (!onUpdate) return;
        updateDirty = true;
        const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
        if (delay <= 0) {
          clearUpdateTimer();
          emitOutputUpdate();
          return;
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitOutputUpdate();
        }, delay);
      };

      if (onUpdate) {
        onUpdate({ content: "", details: undefined });
      }

      const handleData = (data: Buffer) => {
        if (!acceptingOutput) return;
        output.append(data);
        scheduleOutputUpdate();
      };

      const finishOutput = async () => {
        acceptingOutput = false;
        output.finish();
        clearUpdateTimer();
        emitOutputUpdate();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        await output.closeTempFile();
        return snapshot;
      };

      const formatOutput = (
        snapshot: Awaited<ReturnType<typeof finishOutput>>,
        emptyText = "(no output)",
      ) => {
        const truncation = snapshot.truncation;
        let text = sanitizeBinaryOutput(snapshot.content) || emptyText;
        let details: BashToolDetails | undefined;
        if (truncation.truncated) {
          details = { truncation, fullOutputPath: snapshot.fullOutputPath };
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;
          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(output.getLastLineBytes());
            text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
          } else if (truncation.truncatedBy === "lines") {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
          } else {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
          }
        }
        return { text, details };
      };

      const appendStatus = (text: string, status: string) =>
        `${text ? `${text}\n\n` : ""}${status}`;

      try {
        let exitCode: number | null;
        try {
          const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
            onData: handleData,
            signal,
            timeout,
            env: spawnContext.env,
          });
          exitCode = result.exitCode;
        } catch (err) {
          const snapshot = await finishOutput();
          const { text } = formatOutput(snapshot, "");
          if (err instanceof Error && err.message === "aborted") {
            throw new Error(appendStatus(text, "Command aborted"));
          }
          if (err instanceof Error && err.message.startsWith("timeout:")) {
            const timeoutSecs = err.message.split(":")[1];
            throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
          }
          throw err;
        }

        const snapshot = await finishOutput();
        const { text: outputText, details } = formatOutput(snapshot);
        if (exitCode !== 0 && exitCode !== null) {
          throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
        }
        return { content: outputText, details };
      } finally {
        clearUpdateTimer();
      }
    },
  };
}
