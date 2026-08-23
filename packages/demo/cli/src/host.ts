import { join } from "node:path";
import process from "node:process";
import {
  anthropicProvider,
  createModels,
  defaultProviderAuthContext,
  FileCredentialStore,
  openaiCodexProvider,
  openaiProvider,
} from "@uji-ai/ai";
import type { Api, CredentialStore, Model, Models } from "@uji-ai/ai";
import {
  AgentHarness,
  inlinePlugin,
  SqliteSessionRepo,
  systemPromptPlugin,
  toolsFsPlugin,
} from "@uji-ai/core";
import type { AgentHarness as Harness, StreamFn } from "@uji-ai/core";

export interface Runtime {
  models: Models;
  providerId: string;
}

export interface Host {
  harness: Harness;
  repo: SqliteSessionRepo;
  runtime: Runtime;
  sessionId: string;
  /** Every model the stored credentials can reach, provider order preserved. */
  listModels: () => Promise<readonly Model<Api>[]>;
  close: () => Promise<void>;
}

export interface HostOptions {
  resume: boolean;
  cwd?: string;
  dbPath?: string;
  streamFn?: StreamFn;
  model?: Model<Api>;
}

export function createCliModels(credentials: CredentialStore = new FileCredentialStore()): Models {
  const models = createModels({
    credentials,
    authContext: defaultProviderAuthContext(),
  });
  models.setProvider(openaiCodexProvider());
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  return models;
}

function preferredModelId(providerId: string): string | undefined {
  if (providerId === "anthropic") return "claude-opus-5";
  if (providerId === "openai-codex" || providerId === "openai") return "gpt-5.6-luna";
  return undefined;
}

function requireModel(models: Models, providerId: string): Model<Api> {
  const modelsForProvider = models.getModels(providerId);
  const preferred = preferredModelId(providerId);
  const model =
    (preferred === undefined
      ? undefined
      : modelsForProvider.find((candidate) => candidate.id === preferred)) ?? modelsForProvider[0];
  if (model === undefined) throw new Error(`${providerId} does not expose any models.`);
  return model;
}

/** Models from every provider with complete auth, in provider registration order. */
export async function availableModels(models: Models): Promise<readonly Model<Api>[]> {
  const available = await models.getAvailable();
  const order = new Map(models.getProviders().map((provider, index) => [provider.id, index]));
  return [...available].sort((left, right) => {
    const byProvider = (order.get(left.provider) ?? 0) - (order.get(right.provider) ?? 0);
    return byProvider === 0 ? left.name.localeCompare(right.name) : byProvider;
  });
}

export async function resolveRuntime(): Promise<Runtime> {
  const models = createCliModels();
  for (const provider of models.getProviders()) {
    const auth = await models.getAuth(provider.id);
    if (auth !== undefined) return { models, providerId: provider.id };
  }
  throw new Error("No provider is signed in. Run: uji login");
}

export async function openHost(options: HostOptions): Promise<Host> {
  const cwd = options.cwd ?? process.cwd();
  const repo = new SqliteSessionRepo(options.dbPath ?? join(cwd, ".uji", "sessions.db"));
  try {
    const listed = options.resume ? await repo.list() : [];
    const latest = listed.at(-1);
    const session =
      options.resume && latest !== undefined ? await repo.open(latest.id) : await repo.create();
    const runtime =
      options.streamFn === undefined || options.model === undefined
        ? await resolveRuntime()
        : { models: createCliModels(), providerId: options.model.provider };
    const model = options.model ?? requireModel(runtime.models, runtime.providerId);
    const streamFn: StreamFn =
      options.streamFn ??
      ((requestedModel, context, streamOptions) =>
        runtime.models.streamSimple(requestedModel, context, streamOptions));
    const { harness, suspended } = await AgentHarness.create({
      session,
      streamFn,
      plugins: [inlinePlugin(systemPromptPlugin()), inlinePlugin(toolsFsPlugin())],
      env: { cwd },
      model,
    });
    if (suspended.length > 0) await harness.resume();
    const sessionId = (await session.getMetadata()).id;
    return {
      harness,
      repo,
      runtime: { models: runtime.models, providerId: runtime.providerId },
      sessionId,
      listModels: () => availableModels(runtime.models),
      close: async () => {
        await harness.close().catch(() => undefined);
        await repo.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await repo.close().catch(() => undefined);
    throw error;
  }
}

export function subscribePrint(harness: Harness, write: (chunk: string) => void): () => void {
  let needsNewline = false;
  return harness.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      write(event.assistantMessageEvent.delta);
      needsNewline = true;
      return;
    }
    if (event.type === "tool_execution_start") {
      if (needsNewline) write("\n");
      needsNewline = false;
      write(`${event.toolName}\n`);
    }
  });
}

export async function runPrint(command: { resume: boolean; prompt: string }): Promise<void> {
  const opened = await openHost({ resume: command.resume });
  const unsubscribe = subscribePrint(opened.harness, (chunk) => {
    process.stdout.write(chunk);
  });
  let signalExitCode: number | undefined;
  const onSigint = () => {
    signalExitCode = 130;
    void opened.harness.close().catch(() => undefined);
  };
  const onSigterm = () => {
    signalExitCode = 143;
    void opened.harness.close().catch(() => undefined);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    const result = await opened.harness.prompt(command.prompt);
    if (signalExitCode !== undefined) {
      process.exitCode = signalExitCode;
      return;
    }
    if (!result.ok) {
      console.error(result.error.message);
      process.exitCode = 1;
      return;
    }
    if (result.value.kind === "failed") {
      console.error(result.value.error.message);
      process.exitCode = 1;
    }
    console.error(
      `session ${opened.sessionId.slice(0, 8)} · ${opened.harness.state.model.name} · ${result.value.kind}`,
    );
    console.error("resume with: uji -c");
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    unsubscribe();
    await opened.close();
  }
}
