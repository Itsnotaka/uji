import process from "node:process";
import { parseArgs } from "node:util";
import { renderHelp } from "./cli-style.ts";

/** The plain-text form of `--help`, also used for stderr usage messages. */
export const USAGE = renderHelp(false);

export type ResumeTarget = { kind: "new" } | { kind: "latest" } | { kind: "session"; id: string };

export interface RunFlags {
  resume: ResumeTarget;
  print: boolean;
  json: boolean;
  quiet: boolean;
  provider?: string;
  model?: string;
  effort?: string;
  rest: string[];
}

export function parseFlags(args: string[]): RunFlags {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      resume: { type: "boolean", short: "c" },
      print: { type: "boolean", short: "p" },
      json: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      provider: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
    },
  });
  const flags: RunFlags = {
    resume: values.resume === true ? { kind: "latest" } : { kind: "new" },
    print: values.print ?? false,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
    rest: positionals,
  };
  if (values.provider !== undefined) flags.provider = values.provider;
  if (values.model !== undefined) flags.model = values.model;
  if (values.effort !== undefined) flags.effort = values.effort;
  return flags;
}

/** In TTY mode only, the single positional value after --resume is a session ID. */
export function resolveTuiResume(flags: RunFlags): RunFlags {
  if (flags.resume.kind !== "latest" || flags.rest.length === 0) return flags;
  if (flags.rest.length > 1) throw new Error("Usage: uji --resume [<session-id>]");
  const id = flags.rest[0];
  if (id === undefined) return flags;
  return { ...flags, resume: { kind: "session", id }, rest: [] };
}

/** True when this invocation should run one prompt and exit. */
export function wantsPrint(flags: RunFlags, stdoutIsTty: boolean, stdinIsTty: boolean): boolean {
  if (flags.print || flags.json || flags.quiet) return true;
  return !stdoutIsTty && (flags.rest.length > 0 || !stdinIsTty);
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\n$/u, "");
}
