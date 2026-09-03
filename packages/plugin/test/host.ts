/**
 * The host these tests run their plugins in.
 *
 * `@uji-ai/plugin` re-exports `@uji-ai/core/plugins` and nothing else, so its
 * tests reach core the way any host does: `createUji` for the verbs, `/store`
 * for the session handle a plugin's own reader needs. Nothing here imports a
 * harness, which is the point — a plugin that only works when the test drives
 * the loop directly is a plugin no host can load.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUji } from "@uji-ai/core";
import type {
  CompactionSettings,
  LoadedPlugin,
  ModelCatalog,
  SessionId,
  StreamFn,
  Uji,
} from "@uji-ai/core";
import { SqliteSessionRepo } from "@uji-ai/core/store";
import type { SessionStorage } from "@uji-ai/core/store";
import type { Api, Model } from "@uji-ai/schema";

/** A catalog over a fixed set of models: composition never reaches a network. */
export function catalogOf(...models: readonly Model<Api>[]): ModelCatalog {
  return {
    getModels: (provider) =>
      provider === undefined ? models : models.filter((m) => m.provider === provider),
    getModel: (provider, id) =>
      models.find((m) => m.provider === provider && m.id === id) ?? models.find((m) => m.id === id),
  };
}

/**
 * One workspace, one store, one session, reopened as many times as a test
 * needs. Sessions outlive a `Uji`, so a test proving a plugin's selection
 * survives a restart composes a second `Uji` over the same `sessionId`.
 */
export class TestWorkspace {
  readonly directory: string;
  readonly store: SqliteSessionRepo;
  private sessionIdValue: SessionId | undefined;
  private readonly opened: Uji[] = [];

  private constructor(directory: string) {
    this.directory = directory;
    this.store = new SqliteSessionRepo(join(directory, "sessions.db"));
  }

  static create(prefix: string): TestWorkspace {
    return new TestWorkspace(mkdtempSync(join(tmpdir(), prefix)));
  }

  /** The session every `open` in this workspace targets. */
  get sessionId(): SessionId {
    if (this.sessionIdValue === undefined) throw new Error("open the workspace first");
    return this.sessionIdValue;
  }

  /** The raw handle a plugin's own fact reader takes. */
  facts(): Promise<SessionStorage> {
    return this.store.open(this.sessionId);
  }

  async open(options: {
    streamFn: StreamFn;
    plugins: readonly LoadedPlugin[];
    model: Model<Api>;
    models?: readonly Model<Api>[];
    compaction?: CompactionSettings;
  }): Promise<Uji> {
    const sdk = await createUji({
      store: this.store,
      streamFn: options.streamFn,
      models: catalogOf(...(options.models ?? [options.model])),
      model: options.model,
      plugins: options.plugins,
      env: { cwd: this.directory },
      ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
    });
    sdk.attach();
    this.opened.push(sdk);
    this.sessionIdValue ??= (await sdk.sessions.create()).sessionId;
    return sdk;
  }

  async close(): Promise<void> {
    for (const sdk of this.opened.splice(0)) await sdk.close().catch(() => undefined);
    await this.store.close().catch(() => undefined);
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/** Send a prompt and wait for the run it wakes to settle. */
export async function prompt(sdk: Uji, sessionId: SessionId, text: string): Promise<void> {
  await sdk.messages.send({ sessionId, content: [{ type: "text", text }] });
  await sdk.runs.wait({ sessionId });
}

/** A setting's current choice, or undefined when no plugin contributed it. */
export async function settingOf(
  sdk: Uji,
  sessionId: SessionId,
  id: string,
): Promise<string | undefined> {
  return (await sdk.plugins.settings.list({ sessionId })).find((s) => s.id === id)?.current;
}

/** A command's output, asserting it ran. */
export async function runCommand(
  sdk: Uji,
  sessionId: SessionId,
  name: string,
  argument?: string,
): Promise<string | undefined> {
  const outcome = await sdk.plugins.commands.run({
    sessionId,
    name,
    ...(argument === undefined ? {} : { argument }),
  });
  if (outcome.kind !== "ran") throw new Error(`command ${name}: ${outcome.kind}`);
  return outcome.output;
}
