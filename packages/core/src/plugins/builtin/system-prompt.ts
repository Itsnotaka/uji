/**
 * The system prompt as a plugin. Hosts that pass text replace the default
 * body. Other plugins add sections through `api.prompt` and the harness joins
 * them by `order`.
 *
 * Default body follows pi-coding-agent's prompt shape, with "uji" in place of
 * "pi". Project context and skills stay in their own plugins. The pi docs
 * block and guideline bullets are omitted: none are shipped.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts
 * Tool snippets from packages/coding-agent/src/core/tools/*.ts
 */
import { definePlugin } from "../types.ts";

/** One-line Available-tools entries for the five coding tools, in prompt order. */
const TOOL_SNIPPETS = [
  ["read", "Read file contents"],
  ["bash", "Execute bash commands"],
  [
    "edit",
    "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
  ],
  ["write", "Create or overwrite files"],
  ["ls", "List directory contents"],
] as const;

/** Build the default coding-agent system prompt, without project context or skills. */
export function buildSystemPrompt(cwd: string): string {
  const toolsList = TOOL_SNIPPETS.map(([name, snippet]) => `- ${name}: ${snippet}`).join("\n");
  return `You are an expert coding assistant operating inside uji, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Current working directory: ${cwd.replaceAll("\\", "/")}`;
}

export function systemPromptPlugin(text?: string) {
  return definePlugin({
    id: "system-prompt",
    session(api) {
      const body = text ?? buildSystemPrompt(api.env.cwd);
      api.prompt.add((draft) => draft.set("system-prompt", { text: body, order: 0 }));
    },
  });
}
