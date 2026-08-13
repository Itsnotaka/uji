import { join } from "node:path";
import process from "node:process";
import { defaultProviders, FileCredentialStore, getProvider, resolveProviderAuth } from "@june/ai";
import type { AuthResult, Provider } from "@june/ai";
import {
  AgentHarness,
  createAllTools,
  createProviderStreamFn,
  SqliteSessionRepo,
} from "@june/core";
import type { HarnessTool, SuspendedOperation, ThinkingLevel } from "@june/core";

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
  provider: Provider;
  auth: AuthResult;
  store: FileCredentialStore;
}

export async function resolveRuntime(flags: RunFlags): Promise<ResolvedRuntime | undefined> {
  const providers = defaultProviders();
  const store = new FileCredentialStore();
  if (flags.provider !== undefined) {
    const provider = getProvider(providers, flags.provider);
    const auth = await resolveProviderAuth(provider, store);
    return auth === undefined ? undefined : { provider, auth, store };
  }
  for (const provider of providers) {
    const auth = await resolveProviderAuth(provider, store);
    if (auth !== undefined) return { provider, auth, store };
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

export async function openHarness(
  runtime: ResolvedRuntime,
  flags: RunFlags,
): Promise<OpenedHarness> {
  const repo = new SqliteSessionRepo(join(process.cwd(), ".june", "sessions.db"));
  let session;
  if (flags.resume) {
    const latest = (await repo.list()).at(-1);
    session = latest === undefined ? await repo.create() : await repo.open(latest.id);
  } else {
    session = await repo.create();
  }
  const sessionId = (await session.getMetadata()).id;
  const model = flags.model ?? process.env["JUNE_MODEL"];
  const effort = (flags.effort ?? process.env["JUNE_EFFORT"]) as ThinkingLevel | undefined;
  const { harness, suspended } = await AgentHarness.create({
    session,
    streamFn: createProviderStreamFn({
      provider: runtime.provider,
      auth: { store: runtime.store },
      sessionId,
    }),
    systemPrompt: SYSTEM_PROMPT,
    tools: harnessTools(process.cwd()),
    model,
    thinkingLevel: effort ?? runtime.provider.defaultEffort,
  });
  return { harness, suspended, sessionId, repo };
}
