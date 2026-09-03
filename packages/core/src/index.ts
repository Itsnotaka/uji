/**
 * `@uji-ai/core`: `createUji`, `Uji`, and the SDK types. Nothing else.
 *
 * The main entry does not re-export storage, loop, tool, compaction, or plugin
 * internals. Two siblings carry those: `@uji-ai/core/plugins` for plugin
 * authoring and the built-ins, `@uji-ai/core/store` for hosts and storage
 * backends. A client imports this entry and `@uji-ai/schema`; a client that
 * imports `/store` has taken a dependency the design record forbids.
 *
 * Argued in `packages/docs/content/docs/design.mdx`, "Three entry points, not
 * one barrel".
 */
export { createUji } from "./sdk/uji.ts";
export * from "./sdk/types.ts";

/**
 * Client projections over the log. Clients may import nothing but this entry,
 * so the read models they render ship from it (design record, "Views").
 */
export * from "./views/index.ts";

/**
 * Host composition, not internals: a host needs these to build
 * `UjiOptions.plugins` behind workspace trust, so they sit beside `createUji`.
 * The plugin registries, host, and scope are internals and are exported from
 * nowhere.
 */
export {
  resolvePlugins,
  watchPluginDirectories,
  type PluginDirectory,
  type PluginManifest,
  type ResolvedPlugins,
} from "./plugins/sources.ts";
/**
 * `LoadedPlugin` is a `UjiOptions` field; `PluginInfo` and `SettingInfo` are
 * what the `plugins` namespace returns. Authoring the things behind them is
 * `/plugins`.
 */
export type { LoadedPlugin, PluginInfo, SettingInfo } from "./plugins/types.ts";

/** The remaining `UjiOptions` fields a host names when it composes a `Uji`. */
export { isThinkingLevel, type StreamFn, type ThinkingLevel } from "./types.ts";
export {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
} from "./harness/compaction/compaction.ts";
export {
  WorkspaceTrustRequired,
  WorkspaceTrustStore,
  type TrustedWorkspace,
} from "./workspace-trust.ts";
export { WorkspaceRegistry } from "./workspace-registry.ts";
