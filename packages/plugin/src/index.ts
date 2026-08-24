/**
 * What a plugin author imports. Types and `definePlugin` only; the runtime
 * lives in `@uji-ai/core`, and a loader maps this package to the host's copy so
 * one process never holds two.
 */
export {
  definePlugin,
  type AskAnswer,
  type AskRequest,
  type Command,
  type Diagnostics,
  type Disposer,
  type Draft,
  type HandlerErrorEvent,
  type HarnessEvent,
  type HarnessTool,
  type HookHandler,
  type HookInvocation,
  type HookMap,
  type HookName,
  type HostEvent,
  type Plugin,
  type PluginEnv,
  type PluginInfo,
  type PluginOps,
  type PluginSetting,
  type PluginSource,
  type PluginStorage,
  type PromptSection,
  type Registry,
  type RegistryDiff,
  type SessionApi,
  type SettingChoice,
  type ToolDraft,
} from "@uji-ai/core";
export type { JsonValue, Skill, Tool, ToolKind } from "@uji-ai/schema";
