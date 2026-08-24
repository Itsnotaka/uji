/**
 * Built-in plugins. Each is a factory so a host can pass options; each is
 * written against `SessionApi` only. A user plugin with the same id replaces
 * the built-in.
 */
export {
  buildSystemPrompt,
  DEFAULT_SELECTED_TOOLS,
  DEFAULT_TOOL_SNIPPETS,
  systemPromptPlugin,
  type BuildSystemPromptOptions,
} from "./system-prompt.ts";
export {
  CONTEXT_FILES_PLUGIN_ID,
  contextFilesPlugin,
  formatContextFilesForPrompt,
  loadProjectContextFiles,
  type ContextFile,
  type ContextFilesOptions,
} from "./context-files.ts";
export { SKILLS_PLUGIN_ID, skillsPlugin, type SkillsOptions } from "./skills.ts";
export { toolsFsPlugin, type ToolsFsOptions } from "./tools-fs.ts";
