/**
 * The plugin contract: what a plugin module exports and what the harness
 * hands its `session` factory. Built-ins under `./builtin` and files under
 * `.uji/plugins` both use this and nothing else.
 *
 * Design: packages/docs/content/docs/design.mdx, "Plugins". Contract from pi
 * dev's extensions-v2 notes, runtime shape from opencode v2
 * (`define({ id, effect(ctx) })`, a scope per plugin).
 */
import type { JsonValue, Skill } from "@uji-ai/schema";
import type { HarnessTool } from "../harness/agent-harness.ts";
import type { HookHandler, HookName } from "../harness/hooks.ts";

export type Disposer = () => void;

/** Where a plugin came from. Later sources replace earlier ones with the same id. */
export type PluginSource = "builtin" | "user" | "project" | "inline";

export interface Plugin {
  readonly id: string;
  session(api: SessionApi): void | Promise<void>;
}

/** A plugin the host can activate: the module plus the identity that decides reloads. */
export interface LoadedPlugin {
  readonly id: string;
  /** Changed bytes give a new version; the host reloads a plugin only when its version changes. */
  readonly version: string;
  readonly source: PluginSource;
  readonly module: Plugin;
  readonly path?: string;
}

export type PluginInfo = {
  readonly id: string;
  readonly version: string;
  readonly source: PluginSource;
  readonly path?: string;
} & ({ readonly status: "active" } | { readonly status: "failed"; readonly error: string });

export interface Draft<T> {
  set(id: string, value: T): void;
  update(id: string, fn: (current: T) => T): void;
  delete(id: string): void;
  has(id: string): boolean;
  get(id: string): T | undefined;
  ids(): readonly string[];
}

export interface ToolDraft extends Draft<HarnessTool> {
  /** Replace a tool's `execute` with one that can call the previous implementation. */
  wrap(id: string, wrap: (inner: HarnessTool["execute"]) => HarnessTool["execute"]): void;
}

/**
 * The `tools` contribution registry, plus `list`: the materialized tools after
 * the last rebuild. `tools` rebuilds before `prompt`, so the `system-prompt`
 * builtin reads the real catalog and names it in the prompt rather than
 * guessing at a fixed set.
 */
export interface ToolRegistry extends Registry<ToolDraft> {
  list(): readonly HarnessTool[];
}

/**
 * A declared agent: one record that describes the agent a user talks to, a
 * delegate a parent invokes, or a hidden utility turn. There is no separate
 * subagent type; `mode` is subtractive over a default of `all`. Argued in
 * design.mdx, "Agents".
 */
export interface Agent {
  readonly id: string;
  /** Default `all`. `primary` withholds from parents; `subagent` from the user's picker. */
  readonly mode?: "primary" | "subagent" | "all";
  /** Hide from both the picker and the delegate list without changing run rights. */
  readonly hidden?: boolean;
  /** What a parent reads to decide whether to delegate. Also the `task` menu line. */
  readonly description?: string;
  /** A `provider/model` ref the catalog resolves; omitted inherits the run's fallback model. */
  readonly model?: string;
  /** Persona layered onto the base system prompt, never replacing it. */
  readonly system?: string;
  /** A step-count ceiling, not a wall-clock budget (design.mdx invariant 23). */
  readonly steps?: number;
  readonly disabled?: boolean;
}

/**
 * The `agents` contribution registry. Like every registry a plugin `add`s to
 * and `rebuild`s, plus `list`: the materialized agents after the last rebuild,
 * so a plugin that projects agents (the `subagents` builtin) reads them while
 * contributing its own tool.
 */
export interface AgentRegistry extends Registry<Draft<Agent>> {
  list(): readonly Agent[];
}

export interface PromptSection {
  readonly text: string;
  /** Lower renders first. Default 100. */
  readonly order?: number;
}

export interface Command {
  readonly description: string;
  /** Runs on the host that owns the command. Returned text is shown to the user. */
  run(argument: string): Promise<string | undefined> | string | undefined;
}

export interface SettingChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** Badge a client shows while this choice is current. A choice without one contributes nothing. */
  readonly status?: string;
}

/**
 * A session policy a plugin declares to clients: a label, the choices it can
 * take, and the storage key holding the current one. The harness resolves the
 * value and performs the write, so listing settings is one storage scan and
 * applying one is a fact append any host can make. Clients render settings
 * generically; nothing about a specific plugin leaks into them.
 */
export interface PluginSetting {
  readonly label: string;
  /** Non-empty by construction: a setting always has something to select. */
  readonly choices: readonly [SettingChoice, ...SettingChoice[]];
  /** Key under this plugin's storage prefix holding the current choice id. */
  readonly key: string;
  /** Choice used when storage holds nothing or a choice that no longer exists. Defaults to the first. */
  readonly fallback?: string;
}

/** A declared setting with its owner and current choice resolved. What a client renders. */
export interface SettingInfo {
  readonly id: string;
  /** Plugin that contributed the setting's current shape. */
  readonly owner: string;
  readonly label: string;
  readonly choices: readonly [SettingChoice, ...SettingChoice[]];
  /** Choice id, read from plugin storage at list time. */
  readonly current: string;
}

export type ApplySettingOutcome =
  | { kind: "applied" }
  | { kind: "not_found" }
  | { kind: "invalid_choice" };

export interface RegistryDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly errors: readonly { owner: string; message: string }[];
}

export interface Registry<D> {
  /** Register a synchronous contribution. It runs on every rebuild, in plugin order. No I/O inside. */
  add(contribution: (draft: D) => void): Disposer;
  /** Replay every contribution over a fresh draft and swap the result in. */
  rebuild(): RegistryDiff;
}

export interface PluginStorage {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
}

export interface PluginEnv {
  readonly cwd: string;
}

export interface Diagnostics {
  warn(message: string): void;
}

export interface SessionApi {
  readonly env: PluginEnv;

  // 1. contribute
  readonly tools: ToolRegistry;
  readonly commands: Registry<Draft<Command>>;
  readonly prompt: Registry<Draft<PromptSection>>;
  readonly resources: Registry<Draft<Skill>>;
  readonly settings: Registry<Draft<PluginSetting>>;
  readonly agents: AgentRegistry;

  // 2. hook: intercept a live operation and return a typed result
  hook<TName extends HookName>(name: TName, handler: HookHandler<TName>): Disposer;

  readonly storage: PluginStorage;
  readonly diagnostics: Diagnostics;
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

/** Wrap a plugin object for `AgentHarness.create({ plugins })` without a loader. */
export function inlinePlugin(plugin: Plugin, options: { version?: string } = {}): LoadedPlugin {
  return { id: plugin.id, version: options.version ?? "inline", source: "inline", module: plugin };
}
