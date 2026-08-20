export interface SlashCommand {
  name: string;
  description: string;
  aliases?: readonly string[];
  acceptsArgument?: boolean;
}

export const SLASH_COMMANDS = [
  { name: "help", description: "Show every command" },
  { name: "login", description: "Log in to a provider" },
  { name: "provider", description: "Switch provider", aliases: ["providers"] },
  { name: "model", description: "Switch model", aliases: ["models"] },
  { name: "cd", description: "Change the working directory", acceptsArgument: true },
  { name: "tree", description: "View or move the session branch", acceptsArgument: true },
  { name: "search", description: "Search session history", acceptsArgument: true },
] as const satisfies readonly SlashCommand[];

export type SlashCommandName = (typeof SLASH_COMMANDS)[number]["name"];

function aliasesFor(command: SlashCommand): readonly string[] {
  return command.aliases ?? [];
}

/** A slash query is valid only while the first, whitespace-free token is being typed. */
export function slashQuery(input: string): string | undefined {
  if (!input.startsWith("/") || /\s/.test(input)) return undefined;
  return input.slice(1).toLowerCase();
}

export function slashSuggestions(
  input: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const query = slashQuery(input);
  if (query === undefined) return [];
  const matches = commands.filter(
    (command) =>
      command.name.includes(query) || aliasesFor(command).some((alias) => alias.includes(query)),
  );
  if (query === "") return matches;
  return matches.sort((left, right) => {
    const leftPrefix = left.name.startsWith(query) ? 0 : 1;
    const rightPrefix = right.name.startsWith(query) ? 0 : 1;
    return leftPrefix - rightPrefix || left.name.localeCompare(right.name);
  });
}

export function resolveSlashCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find(
    (command) => command.name === name || aliasesFor(command).includes(name),
  );
}
