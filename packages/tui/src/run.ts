import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { clampThinkingLevel, FileCredentialStore } from "@uji-ai/ai";
import type { AccountLimits, Api, Model, Models, Provider } from "@uji-ai/ai";
import { createUji, isThinkingLevel, resolvePlugins } from "@uji-ai/core";
import { fastModePlugin } from "@uji-ai/plugin/examples/fast-mode";
import { questionPlugin } from "@uji-ai/plugin/examples/question";
import {
  webSearchCredentialId,
  webSearchPlugin,
  type WebSearchCredentials,
} from "@uji-ai/plugin/examples/web-search";
import type {
  PluginDirectory,
  PluginManifest,
  ResolvedPlugins,
  ThinkingLevel,
  TrustedWorkspace,
  Uji,
} from "@uji-ai/core";
import type { JsonValue } from "@uji-ai/schema";
import {
  createCliModels,
  DEFAULT_PROVIDER_ID,
  DEFAULT_THINKING_LEVEL,
  loadProviderCatalog,
  requireModel,
  requireProvider,
} from "./catalog.ts";
import type { RunFlags } from "./flags.ts";
import { openAICodexPlugin } from "./openai-codex-plugin.ts";
import type { ResolvedSettings } from "./settings.ts";
import {
  SKILLS_PLUGIN_ID,
  contextFilesPlugin,
  definePlugin,
  skillsPlugin,
  systemPromptPlugin,
  toolsFsPlugin,
} from "@uji-ai/core/plugins";
import { SqliteSessionRepo, toJsonValue } from "@uji-ai/core/store";

let skillsPluginGeneration = 0;

export type { RunFlags } from "./flags.ts";
export { parseFlags } from "./flags.ts";

export interface ResolvedRuntime {
  models: Models;
  provider: Provider;
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
      return { models, provider };
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
function parsePluginManifest(value: unknown): PluginManifest {
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

/**
 * What the TUI's own plugins need from the client: the chat's model
 * (`fast-mode` contributes nothing for one without the mode) and the catalog.
 * Chat naming is host UX over `sessions.rename`, not a plugin, so nothing here
 * needs a session handle.
 */
interface CliPluginContext {
  model: Model<Api>;
  models: Models;
}

function webSearchCredentials(): WebSearchCredentials {
  const store = new FileCredentialStore();
  return {
    async read(provider) {
      const credential = await store.read(webSearchCredentialId(provider));
      return credential?.type === "api_key" ? credential.key : undefined;
    },
    async write(provider, key) {
      const id = webSearchCredentialId(provider);
      if (key === undefined) {
        await store.delete(id);
        return;
      }
      await store.modify(id, () => Promise.resolve({ type: "api_key", key }));
    },
  };
}

/**
 * The stock delegate, so `task` works out of the box. It sees the same tool
 * catalog as any agent (design.mdx, "Agents"); it cannot delegate further,
 * because a child session's catalog omits `task`.
 */
function generalAgentPlugin() {
  return definePlugin({
    id: "general-agent",
    session(api) {
      api.agents.add((draft) => {
        draft.set("general", {
          id: "general",
          mode: "subagent",
          description: "General-purpose agent for research and multi-step side tasks.",
        });
      });
    },
  });
}

/** Host plugins the TUI preinstalls before user and project overrides. */
function cliBuiltinPlugins(cwd: string, context: CliPluginContext) {
  return [
    systemPromptPlugin(),
    generalAgentPlugin(),
    contextFilesPlugin({ globalDir: join(homedir(), ".uji") }),
    toolsFsPlugin(),
    openAICodexPlugin(context.models),
    fastModePlugin(context.model),
    webSearchPlugin({ credentials: webSearchCredentials() }),
    questionPlugin,
    skillsPlugin({ directories: skillDirectories(cwd) }),
  ];
}

/** Resolve the composition fallbacks a workspace launch starts from. */
export function hostFallbacks(
  runtime: ResolvedRuntime,
  settings: ResolvedSettings,
  flags: { model?: string; effort?: string },
): { model: Model<Api>; thinkingLevel: ThinkingLevel } {
  const modelId = resolveRunModelId(runtime.models, runtime.provider.id, {
    flag: flags.model,
    environment: process.env["UJI_MODEL"],
    settings,
  });
  const model = requireModel(runtime.models, runtime.provider.id, modelId);
  const requested = flags.effort ?? process.env["UJI_EFFORT"];
  const effort =
    requested !== undefined && isThinkingLevel(requested)
      ? requested
      : (settings.defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL);
  return { model, thinkingLevel: clampThinkingLevel(model, effort) };
}

export interface OpenUjiOptions {
  workspace: TrustedWorkspace;
  settings: ResolvedSettings;
  /** Read per request, so a provider switch re-points the next one. */
  runtime: () => ResolvedRuntime;
  /** Composition fallbacks; a session's declared config wins per run. */
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  /**
   * Where the sessions live. Defaults to the workspace's own store; `/cd`
   * passes the launch workspace's path, because changing the tool directory
   * must not strand the conversation in another database.
   */
  storePath?: string;
  /** Plugin load failures. */
  report: (message: string) => void;
  onAccountLimits?: (limits: AccountLimits) => void;
}

/**
 * Compose the SDK for one workspace: its store, its plugin set behind trust,
 * and the model fallbacks the caller resolved. Session selection and run
 * inputs are SDK verbs from here on.
 */
export async function openUji(
  options: OpenUjiOptions,
): Promise<{ sdk: Uji; store: SqliteSessionRepo }> {
  const { workspace, runtime } = options;
  const store = new SqliteSessionRepo(
    options.storePath ?? join(workspace.cwd, ".uji", "sessions.db"),
  );
  try {
    const resolved = await resolveCliPlugins(workspace, {
      model: options.model,
      models: runtime().models,
    });
    for (const failure of resolved.failures) {
      options.report(`plugin ${failure.path}: ${failure.error}`);
    }
    const sdk = await createUji({
      store,
      streamFn: (model, context, streamOptions) =>
        runtime().models.streamSimple(model, context, {
          ...streamOptions,
          ...(options.onAccountLimits === undefined
            ? {}
            : { onAccountLimits: options.onAccountLimits }),
        }),
      models: {
        getModels: (provider) => runtime().models.getModels(provider),
        getModel: (provider, id) => runtime().models.getModel(provider, id),
      },
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      plugins: resolved.plugins,
      env: { cwd: workspace.cwd },
      compaction: options.settings.compaction,
      streamOptions: { transport: options.settings.transport },
    });
    return { sdk, store };
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
}

/** Built-ins, then `~/.uji/plugins`, then `<cwd>/.uji/plugins`. */
export async function resolveCliPlugins(
  workspace: TrustedWorkspace,
  context: CliPluginContext,
): Promise<ResolvedPlugins> {
  const { cwd } = workspace;
  return resolvePlugins({
    builtins: cliBuiltinPlugins(cwd, context),
    directories: pluginDirectories(cwd),
    manifest: await readManifest(cwd),
    builtinVersions: { [SKILLS_PLUGIN_ID]: `builtin:${String(++skillsPluginGeneration)}` },
  });
}

/**
 * One plugin id's manifest entry, for host features configured the way plugins
 * are. Chat naming reads `session-title` here even though it is host code, so
 * the `.uji/uji.json` shape users already wrote keeps working.
 */
export async function manifestPluginOptions(
  cwd: string,
  id: string,
): Promise<{ disabled: boolean; options?: JsonValue }> {
  const manifest = await readManifest(cwd);
  let disabled = false;
  let options: JsonValue | undefined;
  for (const entry of manifest?.plugins ?? []) {
    if (typeof entry === "string") {
      if (entry === `-${id}`) disabled = true;
      continue;
    }
    if (entry.id === id && entry.options !== undefined) options = entry.options;
  }
  return { disabled, ...(options === undefined ? {} : { options }) };
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
