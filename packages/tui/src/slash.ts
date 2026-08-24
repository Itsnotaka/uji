import fuzzysort from "fuzzysort";
import type { Skill } from "@uji-ai/schema";
import type { Command } from "@uji-ai/core";

export interface SlashCommand {
  name: string;
  description: string;
  aliases?: readonly string[];
  argument?: { kind: "required"; hint: `<${string}>` } | { kind: "optional" } | { kind: "prompt" };
}

export const SLASH_COMMANDS = [
  { name: "help", description: "Browse commands" },
  { name: "settings", description: "Change settings" },
  { name: "quit", description: "Quit Uji", aliases: ["exit"] },
  {
    name: "resume",
    description: "Resume a previous chat",
    aliases: ["sessions", "continue"],
  },
  { name: "new", description: "Start a new chat" },
  {
    name: "name",
    description: "Name the current chat",
    argument: { kind: "required", hint: "<name>" },
  },
  {
    name: "login",
    description: "Log in to a provider",
    argument: { kind: "optional" },
  },
  {
    name: "logout",
    description: "Log out of a provider",
    argument: { kind: "optional" },
  },
  {
    name: "provider",
    description: "Switch provider",
    aliases: ["providers"],
    argument: { kind: "optional" },
  },
  {
    name: "model",
    description: "Switch model",
    aliases: ["models"],
    argument: { kind: "optional" },
  },
  {
    name: "effort",
    description: "Change thinking level",
    aliases: ["thinking"],
    argument: { kind: "optional" },
  },
  {
    name: "compact",
    description: "Compact conversation history",
    argument: { kind: "optional" },
  },
  {
    name: "cd",
    description: "Change the working directory",
    argument: { kind: "required", hint: "<directory>" },
  },
  { name: "tree", description: "Move to a session branch" },
  { name: "edit", description: "Edit a message you sent" },
  { name: "plugins", description: "List loaded plugins" },
  { name: "reload", description: "Reload plugins and skills from disk" },
  {
    name: "update",
    description: "Update uji to the latest release",
    argument: { kind: "optional" },
  },
  { name: "skills", description: "Browse skills" },
] as const satisfies readonly SlashCommand[];

type RegisteredSlashCommand = (typeof SLASH_COMMANDS)[number] & SlashCommand;

/** Project host commands and skills into the CLI namespace without shadowing earlier entries. */
export function availableSlashCommands(
  pluginCommands: ReadonlyMap<string, Command>,
  skills: ReadonlyMap<string, Skill>,
): SlashCommand[] {
  const staticCommands: readonly SlashCommand[] = SLASH_COMMANDS;
  const reserved = new Set(
    staticCommands.flatMap((command) => [command.name, ...(command.aliases ?? [])]),
  );
  const projectedPlugins = [...pluginCommands].flatMap(([name, command]) => {
    if (reserved.has(name)) return [];
    reserved.add(name);
    return [{ name, description: command.description }];
  });
  const projectedSkills = [...skills].flatMap(([name, skill]) =>
    reserved.has(name)
      ? []
      : [
          {
            name,
            description: skill.description,
            argument: { kind: "prompt" as const },
          },
        ],
  );
  return [...staticCommands, ...projectedPlugins, ...projectedSkills];
}

function aliasesFor(command: SlashCommand): readonly string[] {
  return command.aliases ?? [];
}

function slashQuery(input: string): string | undefined {
  if (!input.startsWith("/")) return undefined;
  for (const character of input) {
    if (character.trim() === "") return undefined;
  }
  return input.slice(1).toLowerCase();
}

const MAX_SUGGESTIONS = 10;

function commandSearchName(command: SlashCommand): string {
  return `/${command.name}`;
}

/**
 * OpenCode 2.0's slash search, adapted to Uji's command type: alphabetic at rest,
 * fuzzy across names, descriptions, and aliases while typing, with command
 * prefixes favored. `undefined` means the composer is not in a slash query;
 * an empty array keeps the menu open with its empty state.
 *
 * Based on https://github.com/anomalyco/opencode/blob/7a6ce05d0939826aa6c8e1c481489a713b2d633f/packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx
 */
export function slashSuggestions(
  input: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] | undefined {
  const query = slashQuery(input);
  if (query === undefined) return undefined;

  const sorted = commands.toSorted((left, right) =>
    commandSearchName(left).localeCompare(commandSearchName(right)),
  );
  if (query === "") return sorted;

  return fuzzysort
    .go(query, sorted, {
      keys: [
        commandSearchName,
        "description",
        (command) =>
          aliasesFor(command)
            .map((alias) => `/${alias}`)
            .join(" "),
      ],
      limit: MAX_SUGGESTIONS,
      scoreFn(results) {
        const name = results[0];
        return name?.target.startsWith(`/${query}`) === true ? results.score * 2 : results.score;
      },
    })
    .map((result) => result.obj);
}

export function resolveSlashCommand(name: string): RegisteredSlashCommand | undefined {
  return SLASH_COMMANDS.find(
    (command) => command.name === name || aliasesFor(command).includes(name),
  );
}

/** Choices for the dedicated skill palette: name, then description, A–Z. */
export function skillPaletteItems(
  skills: ReadonlyMap<string, Skill>,
): readonly { id: string; label: string; description: string }[] {
  return [...skills.values()]
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((skill) => ({
      id: skill.name,
      label: skill.name,
      description: skill.description,
    }));
}

export function slashCommandLabel(command: SlashCommand): string {
  return `/${command.name}${command.argument?.kind === "required" ? ` ${command.argument.hint}` : ""}`;
}

/** The composer text for a command: `/name`, plus a trailing space when it takes an argument. */
function slashCommandInput(command: SlashCommand): string {
  return `/${command.name}${command.argument === undefined ? "" : " "}`;
}

type SlashAcceptance = { action: "execute" } | { action: "complete"; text: string };

/**
 * What accepting a selected command does. Enter executes ordinary commands,
 * while required arguments and skill prompts complete `/name ` in the composer.
 * Tab only ever completes. The selection already names the command, whether the
 * user typed a partial name, alias, or exact name.
 *
 * Based on Grok Build's two-bit completeness model (`is_command_complete`):
 * https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/src/slash/mod.rs
 */
export function acceptSlashCommand(command: SlashCommand, via: "return" | "tab"): SlashAcceptance {
  if (via === "tab") return { action: "complete", text: slashCommandInput(command) };

  const kind = command.argument?.kind;
  switch (kind) {
    case "required":
    case "prompt":
      return { action: "complete", text: slashCommandInput(command) };
    case "optional":
    case undefined:
      return { action: "execute" };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
