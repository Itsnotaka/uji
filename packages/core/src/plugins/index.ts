/**
 * `@uji-ai/core/plugins`: `definePlugin`, `SessionApi`, the hook names, the
 * built-in plugins a host installs, and tool authoring. `@uji-ai/plugin` is
 * the author-facing name for this entry and re-exports it verbatim, so one
 * process never holds two copies of the plugin types.
 *
 * `PluginHost`, the contribution registries, and `PluginScope` are internals:
 * they are exported from nowhere and reached only by relative path inside
 * core (design record, "Three entry points, not one barrel").
 */
export * from "./types.ts";
export { systemPromptPlugin } from "./builtin/system-prompt.ts";
export { contextFilesPlugin } from "./builtin/context-files.ts";
export { SKILLS_PLUGIN_ID, skillsPlugin } from "./builtin/skills.ts";
export { toolsFsPlugin } from "./builtin/tools-fs.ts";
/**
 * Durable suspension, the mechanism behind asks and subagent waits: a tool
 * throws `ToolWait` and settles on wake (design record, "Suspension
 * and wake"). The question example shows the whole pattern.
 */
export {
  ToolWait,
  type WaitingCall,
  type ToolWake,
  type ToolWakeContext,
  type ToolWakeOutcome,
} from "../types.ts";
export { ToolError, toolResultContent } from "../utils/tool-result.ts";

/** What a hook handler is handed, and what a `before_tool` policy decides. */
export type {
  HookHandler,
  HookInvocation,
  HookMap,
  HookModelRef,
  HookName,
  ToolCallDecision,
  ToolCallRequest,
} from "../harness/hooks.ts";

/** Tool authoring: what a contributed tool is. */
export type {
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "../types.ts";
export type { HarnessTool } from "../harness/agent-harness.ts";
export { toJsonValue } from "../harness/session/types.ts";

/** Skills are plugin contributions; the built-in `skills` plugin reads them. */
export { formatSkillInvocation } from "../skills.ts";
