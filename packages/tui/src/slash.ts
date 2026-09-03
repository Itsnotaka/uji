import fuzzysort from "fuzzysort";
import type { Skill } from "@uji-ai/schema";

import { completionTrigger } from "./completion-trigger.ts";
import { formatSkillInvocation } from "@uji-ai/core/plugins";

export interface SlashCommand {
  name: string;
  description: string;
  aliases?: readonly string[];
  argument?: { kind: "required"; hint: `<${string}>` } | { kind: "optional" } | { kind: "prompt" };
}

export const SLASH_COMMANDS = [
  { name: "help", description: "Browse commands" },
  { name: "settings", description: "Change settings" },
  { name: "theme", description: "Switch color theme" },
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
  { name: "title", description: "Name this chat from its first message" },
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
  { name: "usage", description: "Show token usage and cost" },
  {
    name: "cd",
    description: "Change the working directory",
    argument: { kind: "required", hint: "<directory>" },
  },
  { name: "tree", description: "Move to a session branch" },
  { name: "edit", description: "Edit a message you sent" },
  { name: "plugins", description: "List loaded plugins" },
  { name: "reload", description: "Reload plugins and redraw the chat" },
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
  pluginCommands: ReadonlyMap<string, { description: string }>,
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

const MAX_SUGGESTIONS = 10;
/** Under this a description only matched by coincidence, the way `/usage` finds "Use for…". */
const DESCRIPTION_MATCH = 0.5;
/** Shorter than this, a query is being typed toward a name, not searched for a topic. */
const DESCRIPTION_QUERY = 3;

function searchNames(command: SlashCommand): readonly string[] {
  return [command.name, ...aliasesFor(command)];
}

/** Length of the shortest name or alias the query is a prefix of. */
function prefixLength(command: SlashCommand, query: string): number | undefined {
  let shortest: number | undefined;
  for (const name of searchNames(command)) {
    if (!name.toLowerCase().startsWith(query)) continue;
    if (shortest === undefined || name.length < shortest) shortest = name.length;
  }
  return shortest;
}

/**
 * What a typed name should find, in the order a typist expects it: everything
 * the query is a prefix of, shortest first, then fuzzy name matches, and only
 * then descriptions. Ranking descriptions with names is what used to bury
 * `/usage` under every skill whose blurb happens to spell u-s-a-g-e.
 *
 * An empty query lists the whole namespace A–Z, which is the menu `/` opens.
 */
function commandSuggestions(
  query: string,
  commands: readonly SlashCommand[],
): SlashCommand[] {
  const sorted = commands.toSorted((left, right) => left.name.localeCompare(right.name));
  if (query === "") return sorted;

  const needle = query.toLowerCase();
  const prefixed: { command: SlashCommand; length: number }[] = [];
  const rest: SlashCommand[] = [];
  for (const command of sorted) {
    const length = prefixLength(command, needle);
    if (length === undefined) rest.push(command);
    else prefixed.push({ command, length });
  }
  // Stable, so an exact match leads and equal-length names stay A–Z.
  prefixed.sort((left, right) => left.length - right.length);

  const fuzzy = fuzzysort.go(needle, rest, {
    keys: [(command) => command.name, (command) => aliasesFor(command).join(" "), "description"],
    limit: MAX_SUGGESTIONS,
    // Drops the coincidences scoreFn zeroes out.
    threshold: 0.001,
    scoreFn(results) {
      const named = Math.max(results[0]?.score ?? 0, results[1]?.score ?? 0);
      if (named > 0) return 1 + named;
      if (needle.length < DESCRIPTION_QUERY) return 0;
      const described = results[2]?.score ?? 0;
      return described >= DESCRIPTION_MATCH ? described : 0;
    },
  });

  return [...prefixed.map((entry) => entry.command), ...fuzzy.map((result) => result.obj)].slice(
    0,
    MAX_SUGGESTIONS,
  );
}

/** A token is the command line when nothing but whitespace precedes it. */
function opensDraft(text: string, start: number): boolean {
  return text.slice(0, start).trim() === "";
}

/** The `/token` the cursor is inside, with the commands it matches. */
interface SlashCompletion {
  /** The token an accepted command replaces. */
  start: number;
  end: number;
  /** Whether the token opens the buffer rather than interrupting a draft. */
  leading: boolean;
  commands: SlashCommand[];
}

/**
 * Slash completion for the token under the cursor. Every command remains
 * available inside a draft. Prompt commands become inline invocations, while
 * selecting an action command can run it without discarding the draft.
 *
 * `undefined` means the cursor is not in a slash token at all.
 */
export function slashCompletion(
  value: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
  cursor = value.length,
): SlashCompletion | undefined {
  const trigger = completionTrigger(value, cursor);
  if (trigger?.kind !== "/") return undefined;
  return {
    start: trigger.start,
    end: trigger.end,
    leading: opensDraft(value, trigger.start),
    commands: commandSuggestions(trigger.query, commands),
  };
}

/**
 * `/name` tokens the way the composer writes them: at the start of a word, in
 * the same character set the command parser accepts.
 */
const INLINE_SKILL_PATTERN = /(?<=^|\s)\/([A-Za-z][A-Za-z0-9-]*)/g;

/** The skills a draft names, as spans over its text. */
function* skillTokens(
  text: string,
  skills: ReadonlyMap<string, Skill>,
): Generator<{ start: number; end: number; skill: Skill }> {
  for (const match of text.matchAll(INLINE_SKILL_PATTERN)) {
    const skill = skills.get(match[1] ?? "");
    if (skill === undefined) continue;
    yield { start: match.index, end: match.index + match[0].length, skill };
  }
}

/**
 * Whether a draft invokes a skill from inside the prompt. A skill at the head
 * is a command line, which `runCommand` already expands; anything past it means
 * the message itself carries invocations and has to go out as a prompt.
 */
export function hasInlineSkills(text: string, skills: ReadonlyMap<string, Skill>): boolean {
  for (const token of skillTokens(text, skills)) {
    if (!opensDraft(text, token.start)) return true;
  }
  return false;
}

/**
 * Replace every `/skill` token with that skill's instructions, so one message
 * can invoke several. The prompt the model sees carries the instructions; the
 * composer, the history, and the transcript keep the short token.
 */
export function expandInlineSkills(text: string, skills: ReadonlyMap<string, Skill>): string {
  let expanded = "";
  let cursor = 0;
  for (const token of skillTokens(text, skills)) {
    expanded += text.slice(cursor, token.start) + formatSkillInvocation(token.skill);
    cursor = token.end;
  }
  return expanded + text.slice(cursor);
}

interface SkillInvocation {
  source: string;
  name: string;
  path: string;
}

/**
 * Core writes a skill invocation as one `<skill>` block, so a client can find
 * the instructions again and show the short token the user typed instead. A
 * client that ignores the block still shows the model exactly what it saw.
 */
const SKILL_INVOCATION_PATTERN =
  /<skill name="([^"\n]*)" location="([^"\n]*)">\n[\s\S]*?\n<\/skill>/g;

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function extractSkillInvocations(text: string): SkillInvocation[] {
  return [...text.matchAll(SKILL_INVOCATION_PATTERN)].flatMap((match) => {
    const [source, name, path] = match;
    if (name === undefined || path === undefined) return [];
    return [{ source, name: unescapeXml(name), path: unescapeXml(path) }];
  });
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

type SlashAcceptance = { action: "execute" } | { action: "complete"; token: string };

/**
 * What accepting a selected command does. Enter executes ordinary commands,
 * while required arguments and skill prompts complete `/name ` in the composer.
 * Tab only ever completes. The selection already names the command, whether the
 * user typed a partial name, alias, or exact name. The returned token replaces
 * the typed one, so text drafted after it survives as the command's argument.
 *
 * Based on https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/src/slash/mod.rs
 */
export function acceptSlashCommand(
  command: SlashCommand,
  via: "return" | "tab",
  rest = "",
): SlashAcceptance {
  if (rest !== "") return { action: "complete", token: `/${command.name}` };
  if (via === "tab") return { action: "complete", token: slashCommandInput(command) };

  const kind = command.argument?.kind;
  switch (kind) {
    case "required":
    case "prompt":
      return { action: "complete", token: slashCommandInput(command) };
    case "optional":
    case undefined:
      return { action: "execute" };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
