/**
 * The system prompt as a plugin. Hosts that pass text replace the default
 * body. Other plugins add sections through `api.prompt` and the harness joins
 * them by `order`.
 *
 * Default body follows pi-coding-agent's prompt shape, with "uji" in place of
 * "pi". Project context and skills stay in their own plugins. The pi docs
 * block is omitted until uji ships readable package docs next to the CLI.
 * Guideline bullets are host-supplied; none are shipped, so the section is
 * omitted unless `promptGuidelines` has entries.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts
 * Tool snippets from packages/coding-agent/src/core/tools/*.ts
 */
import { definePlugin } from "../types.ts";

export const DEFAULT_SELECTED_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/** One-line Available-tools entries, keyed by tool name. */
export const DEFAULT_TOOL_SNIPPETS = {
  read: "Read file contents",
  bash: "Execute bash commands (ls, grep, find, etc.)",
  edit: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
  write: "Create or overwrite files",
  grep: "Search file contents for patterns (respects .gitignore)",
  find: "Find files by glob pattern (respects .gitignore)",
  ls: "List directory contents",
} as const satisfies Record<(typeof DEFAULT_SELECTED_TOOLS)[number], string>;

export interface BuildSystemPromptOptions {
  /** Replaces the default identity and tools body. */
  readonly customPrompt?: string;
  /** Tools to mention. Default: the seven coding tools. */
  readonly selectedTools?: readonly string[];
  /** One-line snippets keyed by tool name. Default: {@link DEFAULT_TOOL_SNIPPETS}. */
  readonly toolSnippets?: Readonly<Record<string, string>>;
  /** Guideline bullets. The Guidelines section is omitted when this is empty. */
  readonly promptGuidelines?: readonly string[];
  /** Text appended after the body and before the working directory. */
  readonly appendSystemPrompt?: string;
  readonly cwd: string;
}

/** Build the default coding-agent system prompt, without project context or skills. */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const promptCwd = options.cwd.replaceAll("\\", "/");
  const appendSection = options.appendSystemPrompt ? `\n\n${options.appendSystemPrompt}` : "";

  if (options.customPrompt !== undefined) {
    return `${options.customPrompt}${appendSection}\nCurrent working directory: ${promptCwd}\n`;
  }

  const tools = options.selectedTools ?? DEFAULT_SELECTED_TOOLS;
  const toolSnippets: Readonly<Record<string, string>> =
    options.toolSnippets ?? DEFAULT_TOOL_SNIPPETS;
  const visibleTools = tools.filter((name) => toolSnippets[name] !== undefined);
  const toolsList =
    visibleTools.length > 0
      ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n")
      : "(none)";

  const guidelines: string[] = [];
  const seen = new Set<string>();
  for (const guideline of options.promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    guidelines.push(`- ${normalized}`);
  }
  const guidelinesSection =
    guidelines.length > 0 ? `\n\nGuidelines:\n${guidelines.join("\n")}` : "";

  return `You are an expert coding assistant operating inside uji, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.${guidelinesSection}${appendSection}

Current working directory: ${promptCwd}`;
}

export function systemPromptPlugin(text?: string, order = 0) {
  return definePlugin({
    id: "system-prompt",
    session(api) {
      const body = text ?? buildSystemPrompt({ cwd: api.env.cwd });
      api.prompt.add((draft) => draft.set("system-prompt", { text: body, order }));
    },
  });
}
