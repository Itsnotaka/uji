import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { clampThinkingLevel } from "@uji-ai/ai";
import type { Api, AuthResult, Model, Models, Provider } from "@uji-ai/ai";
import {
  AgentHarness,
  contextFilesPlugin,
  resolvePlugins,
  SKILLS_PLUGIN_ID,
  skillsPlugin,
  SqliteSessionRepo,
  systemPromptPlugin,
  toJsonValue,
  toolsFsPlugin,
} from "@uji-ai/core";
import { fastModePlugin } from "@uji-ai/plugin/examples/fast-mode";
import { MODEL_THINKING_LEVELS } from "@uji-ai/schema";
import type {
  PluginDirectory,
  PluginManifest,
  ResolvedPlugins,
  SessionRepo,
  SessionStorage,
  SuspendedOperation,
  ThinkingLevel,
  TrustedWorkspace,
} from "@uji-ai/core";
import {
  createCliModels,
  DEFAULT_PROVIDER_ID,
  DEFAULT_THINKING_LEVEL,
  loadProviderCatalog,
  requireModel,
  requireProvider,
} from "./catalog.ts";
import type { ResumeTarget, RunFlags } from "./flags.ts";
import type { ResolvedSettings } from "./settings.ts";

let skillsPluginGeneration = 0;

export type { RunFlags } from "./flags.ts";
export { parseFlags } from "./flags.ts";

export interface ResolvedRuntime {
  models: Models;
  provider: Provider;
  auth: AuthResult;
}

export function runProviderCandidates(
  models: Models,
  providerId: string | undefined,
  settings: ResolvedSettings | undefined,
): readonly Provider[] {
  if (providerId !== undefined) return [requireProvider(models, providerId)];
  const providers = models.getProviders();
  if (settings?.defaultProvider === undefined) return providers;
  const preferred = models.getProvider(settings.defaultProvider);
  if (preferred === undefined) return providers;
  return [preferred, ...providers.filter((provider) => provider.id !== preferred.id)];
}

export function preferredRunProvider(
  models: Models,
  providerId: string | undefined,
  settings: ResolvedSettings | undefined,
): Provider {
  if (providerId !== undefined) return requireProvider(models, providerId);
  return (
    runProviderCandidates(models, undefined, settings)[0] ??
    requireProvider(models, DEFAULT_PROVIDER_ID)
  );
}

export function resolveRunModelId(
  models: Models,
  providerId: string,
  sources: {
    flag: string | undefined;
    environment: string | undefined;
    settings: ResolvedSettings | undefined;
  },
): string | undefined {
  const override = sources.flag ?? sources.environment;
  if (override !== undefined) return override;
  if (sources.settings?.defaultProvider !== providerId) return undefined;
  if (sources.settings.defaultModel === undefined) return undefined;
  return models.getModel(providerId, sources.settings.defaultModel)?.id;
}

export async function resolveRuntime(
  flags: RunFlags,
  settings?: ResolvedSettings,
): Promise<ResolvedRuntime | undefined> {
  const models = createCliModels();
  const providers = runProviderCandidates(models, flags.provider, settings);
  for (const provider of providers) {
    const auth = await models.getAuth(provider.id);
    if (auth !== undefined) {
      await loadProviderCatalog(models, provider.id);
      return { models, provider, auth };
    }
  }
  return undefined;
}

type ManifestPlugin = NonNullable<PluginManifest["plugins"]>[number];

function unknownProperty(value: unknown, allowed: readonly string[], path: string): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${path} must be an object`);
  }
  const key = Object.keys(value).find((candidate) => !allowed.includes(candidate));
  if (key !== undefined) throw new Error(`${path} has unknown property "${key}"`);
}

function parseManifestPlugin(value: unknown, index: number): ManifestPlugin {
  if (typeof value === "string") return value;
  const path = `.uji/uji.json.plugins[${String(index)}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a string or object`);
  }
  unknownProperty(value, ["id", "options"], path);
  if (!("id" in value) || typeof value.id !== "string") {
    throw new Error(`${path}.id must be a string`);
  }
  if (!("options" in value)) return { id: value.id };
  try {
    return { id: value.id, options: toJsonValue(value.options) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}.options must be JSON: ${message}`, { cause: error });
  }
}

/** Parse the complete `.uji/uji.json` shape before it enters the plugin host. */
export function parsePluginManifest(value: unknown): PluginManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(".uji/uji.json must be an object");
  }
  unknownProperty(value, ["plugins"], ".uji/uji.json");
  if (!("plugins" in value)) return {};
  if (!Array.isArray(value.plugins)) {
    throw new Error(".uji/uji.json.plugins must be an array");
  }
  const plugins: ManifestPlugin[] = [];
  for (const [index, plugin] of value.plugins.entries()) {
    plugins.push(parseManifestPlugin(plugin, index));
  }
  return { plugins };
}

/** `.uji/uji.json` in the project; optional. Disables ids and sets options, never lists plugins. */
async function readManifest(cwd: string): Promise<PluginManifest | undefined> {
  let text: string;
  try {
    text = await readFile(join(cwd, ".uji", "uji.json"), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  return parsePluginManifest(parsed);
}

/** Host plugins the TUI preinstalls before user and project overrides. */
export function cliBuiltinPlugins(cwd: string, model: Model<Api>) {
  return [
    systemPromptPlugin(),
    contextFilesPlugin({ globalDir: join(homedir(), ".uji") }),
    toolsFsPlugin(),
    fastModePlugin(model),
    skillsPlugin({ directories: skillDirectories(cwd) }),
  ];
}

/** Built-ins, then `~/.uji/plugins`, then `<cwd>/.uji/plugins`. */
export async function resolveCliPlugins(
  workspace: TrustedWorkspace,
  model: Model<Api>,
): Promise<ResolvedPlugins> {
  const { cwd } = workspace;
  return resolvePlugins({
    builtins: cliBuiltinPlugins(cwd, model),
    directories: pluginDirectories(cwd),
    manifest: await readManifest(cwd),
    builtinVersions: { [SKILLS_PLUGIN_ID]: `builtin:${String(++skillsPluginGeneration)}` },
  });
}

export function pluginDirectories(cwd: string): PluginDirectory[] {
  return [
    { path: join(homedir(), ".uji", "plugins"), source: "user" },
    { path: join(cwd, ".uji", "plugins"), source: "project" },
  ];
}

/** Project skills override user skills; Uji-native locations win over compatibility locations. */
export function skillDirectories(cwd: string): string[] {
  return [
    join(cwd, ".uji", "skills"),
    join(cwd, ".agents", "skills"),
    join(cwd, ".claude", "skills"),
    join(homedir(), ".uji", "skills"),
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".claude", "skills"),
  ];
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
  settings: Pick<ResolvedSettings, "compaction" | "transport">;
}

export async function openRunSession(
  repo: SessionRepo,
  target: ResumeTarget,
): Promise<SessionStorage> {
  switch (target.kind) {
    case "new":
      return repo.create();
    case "latest": {
      // Skip sessions that were created by a launch and never written to.
      for (const { id } of (await repo.list()).reverse()) {
        const session = await repo.open(id);
        if ((await session.getLeafId("main")) !== null) return session;
        await session.close();
      }
      return repo.create();
    }
    case "session":
      return repo.open(target.id);
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  const level = MODEL_THINKING_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new Error(`Unknown effort: ${value}. Use ${MODEL_THINKING_LEVELS.join(", ")}`);
  }
  return level;
}

export async function createHarness(
  runtime: ResolvedRuntime,
  session: SessionStorage,
  options: HarnessRuntimeOptions,
  workspace: TrustedWorkspace,
): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
  const model = requireModel(runtime.models, runtime.provider.id, options.model);
  const thinkingLevel = clampThinkingLevel(model, options.effort ?? DEFAULT_THINKING_LEVEL);
  const resolved = await resolveCliPlugins(workspace, model);
  for (const failure of resolved.failures) {
    process.stderr.write(`plugin ${failure.path}: ${failure.error}\n`);
  }
  return AgentHarness.create({
    session,
    streamFn: (requestedModel, context, streamOptions) =>
      runtime.models.streamSimple(requestedModel, context, streamOptions),
    plugins: resolved.plugins,
    env: { cwd: workspace.cwd },
    model,
    thinkingLevel,
    compaction: options.settings.compaction,
    streamOptions: { transport: options.settings.transport },
  });
}

export async function openHarness(
  runtime: ResolvedRuntime,
  flags: RunFlags,
  options: { workspace: TrustedWorkspace; settings: ResolvedSettings },
): Promise<OpenedHarness> {
  const { workspace } = options;
  const repo = new SqliteSessionRepo(join(workspace.cwd, ".uji", "sessions.db"));
  try {
    const session = await openRunSession(repo, flags.resume);
    const sessionId = (await session.getMetadata()).id;
    const model = resolveRunModelId(runtime.models, runtime.provider.id, {
      flag: flags.model,
      environment: process.env["UJI_MODEL"],
      settings: options.settings,
    });
    const effort = parseThinkingLevel(
      flags.effort ?? process.env["UJI_EFFORT"] ?? options.settings.defaultThinkingLevel,
    );
    const { harness, suspended } = await createHarness(
      runtime,
      session,
      {
        model,
        effort,
        settings: options.settings,
      },
      workspace,
    );
    return { harness, suspended, sessionId, repo };
  } catch (error) {
    await repo.close().catch(() => undefined);
    throw error;
  }
}
