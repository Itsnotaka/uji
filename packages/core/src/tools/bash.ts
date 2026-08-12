import { spawnSync } from "node:child_process";
import type { AgentTool } from "../agent.ts";

/** Bash tool block: run a command in the working directory, capped output. */
export function bashTool(): AgentTool {
  return {
    definition: {
      type: "function",
      name: "bash",
      description: "Run a bash command in the working directory. Returns stdout and stderr.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
      strict: true,
    },
    run(args) {
      const { command } = JSON.parse(args) as { command: string };
      const run = spawnSync("bash", ["-c", command], {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1_048_576,
      });
      if (run.error) return run.error.message;
      const exit = run.status === 0 ? "" : `\n(exit ${String(run.status ?? "timeout")})`;
      const output = `${run.stdout}${run.stderr}`.trim() + exit;
      return output.length > 10_000 ? `${output.slice(0, 10_000)}\n(truncated)` : output;
    },
  };
}
