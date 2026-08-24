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
import type { HarnessEvent, HarnessTool } from "../harness/agent-harness.ts";
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
  readonly options?: JsonValue;
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
 * A session policy a plugin exposes to clients: a label, the choices it can
 * take, and a durable value. Clients render settings generically; nothing
 * about a specific plugin leaks into them.
 */
export interface PluginSetting {
  readonly label: string;
  /** Non-empty by construction: a setting always has something to select. */
  readonly choices: readonly [SettingChoice, ...SettingChoice[]];
  /** Current choice id. Async because the value lives in plugin storage, never in memory. */
  read(): Promise<string>;
  /** Persist a choice id. Callers re-read after applying; there is no cached value to patch. */
  apply(choiceId: string): Promise<void>;
}

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
  remove(key: string): Promise<void>;
  scan(prefix?: string): Promise<{ key: string; value: JsonValue }[]>;
}

export type AskRequest =
  | { kind: "confirm"; title: string; message?: string; default?: boolean }
  | {
      kind: "select";
      title: string;
      message?: string;
      options: readonly { value: string; label: string; description?: string }[];
      default?: string;
    }
  | { kind: "input"; title: string; message?: string; placeholder?: string; default?: string };

export type AskAnswer<TRequest extends AskRequest = AskRequest> = TRequest extends {
  kind: "confirm";
}
  ? boolean
  : string;

export interface PluginEnv {
  readonly cwd: string;
}

export interface PluginOps {
  list(): readonly PluginInfo[];
}

export interface Diagnostics {
  warn(message: string): void;
  error(message: string): void;
}

export interface SessionApi {
  readonly id: string;
  readonly options: JsonValue;
  readonly env: PluginEnv;

  // 1. contribute
  readonly tools: Registry<ToolDraft>;
  readonly commands: Registry<Draft<Command>>;
  readonly prompt: Registry<Draft<PromptSection>>;
  readonly resources: Registry<Draft<Skill>>;
  readonly settings: Registry<Draft<PluginSetting>>;

  // 2. hook: intercept a live operation and return a typed result
  hook<TName extends HookName>(name: TName, handler: HookHandler<TName>): Disposer;

  // 3. observe: passive; a throw becomes a handler_error event
  on<TType extends HarnessEvent["type"]>(
    type: TType,
    listener: (event: Extract<HarnessEvent, { type: TType }>) => void | Promise<void>,
  ): Disposer;

  // 4. effect: I/O and long-lived work. The signal aborts when the plugin is disposed.
  effect(setup: (signal: AbortSignal) => void | Disposer | Promise<void | Disposer>): void;

  readonly storage: PluginStorage;
  ask<TRequest extends AskRequest>(request: TRequest): Promise<AskAnswer<TRequest>>;
  readonly plugins: PluginOps;
  readonly diagnostics: Diagnostics;
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

/** Wrap a plugin object for `AgentHarness.create({ plugins })` without a loader. */
export function inlinePlugin(
  plugin: Plugin,
  options: { version?: string; options?: JsonValue } = {},
): LoadedPlugin {
  const version = options.version ?? "inline";
  return options.options === undefined
    ? { id: plugin.id, version, source: "inline", module: plugin }
    : { id: plugin.id, version, source: "inline", module: plugin, options: options.options };
}

export function isPlugin(value: unknown): value is Plugin {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    "session" in value &&
    typeof value.session === "function"
  );
}
