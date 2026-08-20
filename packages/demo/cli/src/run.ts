import { join } from "node:path";
import process from "node:process";
import { clampThinkingLevel } from "@june/ai";
import type { AuthResult, Models, Provider } from "@june/ai";
import { AgentHarness, createAllTools, SqliteSessionRepo } from "@june/core";
import type { HarnessTool, SessionStorage, SuspendedOperation, ThinkingLevel } from "@june/core";
import {
  createCliModels,
  DEFAULT_THINKING_LEVEL,
  requireModel,
  requireProvider,
} from "./catalog.ts";

export const SYSTEM_PROMPT =
  "You are june, a minimal coding agent. Work inside the current working directory. " +
  "Use the read, bash, edit, write, grep, find, and ls tools to inspect and change files. " +
  "Be concise.";

export interface RunFlags {
  resume: boolean;
  print: boolean;
  provider?: string;
  model?: string;
  effort?: string;
  rest: string[];
}

export function parseFlags(args: string[]): RunFlags {
  const flags: RunFlags = { resume: false, print: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--resume" || arg === "-c") flags.resume = true;
    else if (arg === "--print" || arg === "-p") flags.print = true;
    else if (arg === "--provider") flags.provider = args[++i];
    else if (arg === "--model") flags.model = args[++i];
    else if (arg === "--effort") flags.effort = args[++i];
    else flags.rest.push(arg);
  }
  return flags;
}

export interface ResolvedRuntime {
  models: Models;
  provider: Provider;
  auth: AuthResult;
}

export async function resolveRuntime(flags: RunFlags): Promise<ResolvedRuntime | undefined> {
  const models = createCliModels();
  const providers =
    flags.provider === undefined
      ? models.getProviders()
      : [requireProvider(models, flags.provider)];
  for (const provider of providers) {
    const auth = await models.getAuth(provider.id);
    if (auth !== undefined) return { models, provider, auth };
  }
  return undefined;
}

function harnessTools(cwd: string): HarnessTool[] {
  const safe = new Set(["read", "grep", "find", "ls"]);
  return createAllTools(cwd).map((tool) => ({
    ...tool,
    replay: safe.has(tool.name) ? ("safe" as const) : ("never" as const),
  }));
}

export interface OpenedHarness {
  harness: AgentHarness;
  suspended: SuspendedOperation[];
  sessionId: string;
  repo: SqliteSessionRepo;
}

export interface HarnessRuntimeOptions {
  model?: string;
  effort?: ThinkingLevel;
  cwd: string;
}

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] satisfies readonly ThinkingLevel[];

function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  const level = THINKING_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new Error(`Unknown effort: ${value}. Use ${THINKING_LEVELS.join(", ")}`);
  }
  return level;
}

export async function createHarness(
  runtime: ResolvedRuntime,
  session: SessionStorage,
  sessionId: string,
  options: HarnessRuntimeOptions,
): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
  const model = requireModel(runtime.models, runtime.provider.id, options.model);
  const thinkingLevel = clampThinkingLevel(model, options.effort ?? DEFAULT_THINKING_LEVEL);
  return AgentHarness.create({
    session,
    streamFn: (requestedModel, context, streamOptions) =>
      runtime.models.streamSimple(requestedModel, context, { ...streamOptions, sessionId }),
    systemPrompt: SYSTEM_PROMPT,
    tools: harnessTools(options.cwd),
    model,
    thinkingLevel,
  });
}

export async function openHarness(
  runtime: ResolvedRuntime,
  flags: RunFlags,
): Promise<OpenedHarness> {
  const repo = new SqliteSessionRepo(join(process.cwd(), ".june", "sessions.db"));
  try {
    let session;
    if (flags.resume) {
      const latest = (await repo.list()).at(-1);
      session = latest === undefined ? await repo.create() : await repo.open(latest.id);
    } else {
      session = await repo.create();
    }
    const sessionId = (await session.getMetadata()).id;
    const model = flags.model ?? process.env["JUNE_MODEL"];
    const effort = parseThinkingLevel(flags.effort ?? process.env["JUNE_EFFORT"]);
    const { harness, suspended } = await createHarness(runtime, session, sessionId, {
      model,
      effort,
      cwd: process.cwd(),
    });
    return { harness, suspended, sessionId, repo };
  } catch (error) {
    await repo.close().catch(() => undefined);
    throw error;
  }
}
