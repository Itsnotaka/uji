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
import { createUji } from "@uji-ai/core";
import type { Disposer, RunEnd, SessionId, SessionInfo, StreamFn, Uji } from "@uji-ai/core";
import { inlinePlugin, systemPromptPlugin, toolsFsPlugin } from "@uji-ai/core/plugins";
import { SqliteSessionRepo } from "@uji-ai/core/store";

export interface Runtime {
  models: Models;
  providerId: string;
}

export interface Host {
  sdk: Uji;
  runtime: Runtime;
  sessionId: SessionId;
  /** The composition fallback; the session's declared config wins per run. */
  model: Model<Api>;
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

async function targetSession(uji: Uji, resume: boolean): Promise<SessionInfo> {
  if (resume) {
    const { items } = await uji.sessions.list();
    const latest = items.at(-1);
    if (latest !== undefined) return latest;
  }
  return uji.sessions.create();
}

export async function openHost(options: HostOptions): Promise<Host> {
  const cwd = options.cwd ?? process.cwd();
  const store = new SqliteSessionRepo(options.dbPath ?? join(cwd, ".uji", "sessions.db"));
  let sdk: Uji | undefined;
  let detach: Disposer | undefined;
  try {
    const runtime =
      options.streamFn === undefined || options.model === undefined
        ? await resolveRuntime()
        : { models: createCliModels(), providerId: options.model.provider };
    const model = options.model ?? requireModel(runtime.models, runtime.providerId);
    const streamFn: StreamFn =
      options.streamFn ??
      ((requestedModel, context, streamOptions) =>
        runtime.models.streamSimple(requestedModel, context, streamOptions));
    sdk = await createUji({
      store,
      streamFn,
      models: runtime.models,
      model,
      plugins: [inlinePlugin(systemPromptPlugin()), inlinePlugin(toolsFsPlugin())],
      env: { cwd },
    });
    // Volunteering as a runner also resumes any orphaned operation.
    detach = sdk.attach();
    const info = await targetSession(sdk, options.resume);
    const opened = sdk;
    const stop = detach;
    return {
      sdk: opened,
      runtime: { models: runtime.models, providerId: runtime.providerId },
      sessionId: info.sessionId,
      model,
      listModels: () => availableModels(runtime.models),
      close: async () => {
        stop();
        await opened.close().catch(() => undefined);
        await store.close().catch(() => undefined);
      },
    };
  } catch (error) {
    detach?.();
    await sdk?.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    throw error;
  }
}

/** The most recent run's terminal outcome, from a durable replay. */
export async function lastRunEnd(
  host: Pick<Host, "sdk" | "sessionId">,
): Promise<RunEnd | undefined> {
  let end: RunEnd | undefined;
  for await (const event of host.sdk.watch({ sessionId: host.sessionId })) {
    if (event.kind === "synced") break;
    if (event.kind === "run_finished") end = event.outcome;
  }
  return end;
}

export async function runPrint(command: { resume: boolean; prompt: string }): Promise<void> {
  const host = await openHost({ resume: command.resume });
  let signalExitCode: number | undefined;
  const controller = new AbortController();
  const abortRun = (code: number): void => {
    signalExitCode = code;
    void host.sdk.runs.abort({ sessionId: host.sessionId }).catch(() => undefined);
    controller.abort();
  };
  const onSigint = (): void => abortRun(130);
  const onSigterm = (): void => abortRun(143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  let needsNewline = false;
  try {
    const watcher = (async (): Promise<void> => {
      for await (const event of host.sdk.watch({
        sessionId: host.sessionId,
        live: true,
        signal: controller.signal,
      })) {
        if (event.kind === "text_delta") {
          process.stdout.write(event.delta);
          needsNewline = true;
          continue;
        }
        // A tool call announces on its assistant entry, before it settles.
        if (event.kind !== "message" || event.turn.kind !== "turn") continue;
        for (const part of event.turn.parts) {
          if (part.kind !== "tool" || part.result !== undefined) continue;
          if (needsNewline) process.stdout.write("\n");
          needsNewline = false;
          process.stdout.write(`${part.toolName}\n`);
        }
      }
    })();
    await host.sdk.messages.send({ sessionId: host.sessionId, content: command.prompt });
    await host.sdk.runs.wait({ sessionId: host.sessionId, signal: controller.signal });
    controller.abort();
    await watcher.catch(() => undefined);
    if (needsNewline) process.stdout.write("\n");
    if (signalExitCode !== undefined) {
      process.exitCode = signalExitCode;
      return;
    }
    const end = await lastRunEnd(host);
    if (end === undefined || end.kind === "failed") {
      console.error(end?.kind === "failed" ? end.error.message : "run did not complete");
      process.exitCode = 1;
      return;
    }
    console.error(`session ${host.sessionId.slice(0, 8)} · ${host.model.name} · ${end.kind}`);
    console.error("resume with: uji -c");
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await host.close();
  }
}
