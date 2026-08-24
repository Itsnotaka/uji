/**
 * Skill discovery and prompt formatting.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/skills.ts
 */
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { Skill } from "@uji-ai/schema";
import ignorePackage from "ignore";
import type { Ignore } from "ignore";
import { parse } from "yaml";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"] as const;

type IgnoreFactory = () => Ignore;

/** `ignore` is CommonJS; NodeNext and bundler consumers expose its default differently. */
function parseIgnoreFactory(value: unknown): IgnoreFactory {
  if (typeof value === "function") return value as IgnoreFactory;
  if (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    typeof value.default === "function"
  ) {
    return value.default as IgnoreFactory;
  }
  throw new TypeError("ignore package does not export a factory");
}

const createIgnore = parseIgnoreFactory(ignorePackage);

export type SkillDiagnosticCode =
  | "file_info_failed"
  | "list_failed"
  | "read_failed"
  | "parse_failed"
  | "invalid_metadata";

export interface SkillDiagnostic {
  readonly type: "warning";
  readonly code: SkillDiagnosticCode;
  readonly message: string;
  readonly path: string;
}

interface SkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly disableModelInvocation?: boolean;
}

interface RawSkillFrontmatter {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly "disable-model-invocation"?: unknown;
}

interface ParsedFrontmatter {
  readonly frontmatter: SkillFrontmatter;
  readonly body: string;
}

/** Discover standard skill folders recursively. A folder containing `SKILL.md` is a leaf. */
export async function loadSkills(
  directories: string | readonly string[],
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const directory of typeof directories === "string" ? [directories] : directories) {
    const kind = await pathKind(directory, diagnostics);
    if (kind !== "directory") continue;
    const loaded = await loadSkillsFromDirectory(directory, directory, createIgnore());
    skills.push(...loaded.skills);
    diagnostics.push(...loaded.diagnostics);
  }
  return { skills, diagnostics };
}

/** Format an explicit skill invocation, with optional task-specific instructions. */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
  const skillBlock =
    `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}">\n` +
    `References are relative to ${dirname(skill.filePath)}.\n\n${skill.content}\n</skill>`;
  return additionalInstructions === undefined || additionalInstructions === ""
    ? skillBlock
    : `${skillBlock}\n\n${additionalInstructions}`;
}

/** Format the model-visible skill catalog. Full instructions remain on disk until needed. */
export function formatSkillsForPrompt(skills: readonly Skill[]): string {
  const visible = skills.filter((skill) => skill.disableModelInvocation !== true);
  if (visible.length === 0) return "";

  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "Resolve relative paths in a skill against the directory containing its SKILL.md file.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

async function loadSkillsFromDirectory(
  directory: string,
  root: string,
  matcher: Ignore,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  await addIgnoreRules(matcher, directory, root, diagnostics);

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    diagnostics.push(diagnostic("list_failed", errorMessage(error), directory));
    return { skills, diagnostics };
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const declared = entries.find((entry) => entry.name === "SKILL.md");
  if (declared !== undefined) {
    const filePath = join(directory, declared.name);
    const kind = await pathKind(filePath, diagnostics);
    if (kind === "file" && !matcher.ignores(relativePath(root, filePath))) {
      const loaded = await loadSkillFile(filePath, basename(directory));
      if (loaded.skill !== undefined) skills.push(loaded.skill);
      diagnostics.push(...loaded.diagnostics);
    }
    return { skills, diagnostics };
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    const kind = entry.isDirectory()
      ? "directory"
      : entry.isSymbolicLink()
        ? await pathKind(path, diagnostics)
        : undefined;
    if (kind !== "directory" || matcher.ignores(`${relativePath(root, path)}/`)) continue;
    const loaded = await loadSkillsFromDirectory(path, root, matcher);
    skills.push(...loaded.skills);
    diagnostics.push(...loaded.diagnostics);
  }
  return { skills, diagnostics };
}

async function loadSkillFile(
  filePath: string,
  parentDirectoryName: string,
): Promise<{ skill?: Skill; diagnostics: SkillDiagnostic[] }> {
  const diagnostics: SkillDiagnostic[] = [];
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    diagnostics.push(diagnostic("read_failed", errorMessage(error), filePath));
    return { diagnostics };
  }

  let parsed: ParsedFrontmatter;
  try {
    parsed = parseFrontmatter(content);
  } catch (error) {
    diagnostics.push(diagnostic("parse_failed", errorMessage(error), filePath));
    return { diagnostics };
  }

  const name = parsed.frontmatter.name || parentDirectoryName;
  const description = parsed.frontmatter.description;
  for (const message of validateName(name, parentDirectoryName)) {
    diagnostics.push(diagnostic("invalid_metadata", message, filePath));
  }
  for (const message of validateDescription(description)) {
    diagnostics.push(diagnostic("invalid_metadata", message, filePath));
  }
  if (description === undefined || description.trim() === "") return { diagnostics };

  return {
    skill: {
      name,
      description,
      content: parsed.body,
      filePath,
      disableModelInvocation: parsed.frontmatter.disableModelInvocation === true,
    },
    diagnostics,
  };
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: normalized };
  const value: unknown = parse(normalized.slice(4, end));
  if (value !== null && !isRawSkillFrontmatter(value)) {
    throw new Error("skill frontmatter must be a YAML object");
  }
  const raw = value ?? {};
  const frontmatter: SkillFrontmatter = {
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(raw["disable-model-invocation"] === true ? { disableModelInvocation: true } : {}),
  };
  return {
    frontmatter,
    body: normalized.slice(end + 4).trim(),
  };
}

function validateName(name: string, parentDirectoryName: string): string[] {
  const messages: string[] = [];
  if (name !== parentDirectoryName) {
    messages.push(`name "${name}" does not match parent directory "${parentDirectoryName}"`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    messages.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  const validCharacters = [...name].every(
    (character) =>
      (character >= "a" && character <= "z") ||
      (character >= "0" && character <= "9") ||
      character === "-",
  );
  if (!validCharacters) {
    messages.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    messages.push("name must not start or end with a hyphen");
  }
  if (name.includes("--")) messages.push("name must not contain consecutive hyphens");
  return messages;
}

function validateDescription(description: string | undefined): string[] {
  if (description === undefined || description.trim() === "") return ["description is required"];
  return description.length > MAX_DESCRIPTION_LENGTH
    ? [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`]
    : [];
}

async function addIgnoreRules(
  matcher: Ignore,
  directory: string,
  root: string,
  diagnostics: SkillDiagnostic[],
): Promise<void> {
  const relativeDirectory = relativePath(root, directory);
  const prefix = relativeDirectory === "" ? "" : `${relativeDirectory}/`;
  for (const filename of IGNORE_FILE_NAMES) {
    const path = join(directory, filename);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        diagnostics.push(diagnostic("read_failed", errorMessage(error), path));
      }
      continue;
    }
    const patterns = content
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .split("\n")
      .map((line) => prefixIgnorePattern(line, prefix))
      .filter((line): line is string => line !== undefined);
    if (patterns.length > 0) matcher.add(patterns);
  }
}

function prefixIgnorePattern(line: string, prefix: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) {
    return undefined;
  }
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const prefixed = `${prefix}${pattern}`;
  return negated ? `!${prefixed}` : prefixed;
}

async function pathKind(
  path: string,
  diagnostics: SkillDiagnostic[],
): Promise<"file" | "directory" | undefined> {
  try {
    const info = await lstat(path);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    if (!info.isSymbolicLink()) return undefined;
    const target = await stat(path);
    if (target.isFile()) return "file";
    if (target.isDirectory()) return "directory";
    return undefined;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      diagnostics.push(diagnostic("file_info_failed", errorMessage(error), path));
    }
    return undefined;
  }
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function diagnostic(code: SkillDiagnosticCode, message: string, path: string): SkillDiagnostic {
  return { type: "warning", code, message, path };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRawSkillFrontmatter(value: unknown): value is RawSkillFrontmatter {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
