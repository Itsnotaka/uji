import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// --- Inlined path helpers (from pi's utils/paths.ts) ---

const UNICODE_SPACES = /[  -   　]/g;

export interface PathInputOptions {
  /** Trim leading/trailing whitespace before normalization. */
  trim?: boolean;
  /** Expand leading `~` to a home directory. Defaults to true. */
  expandTilde?: boolean;
  /** Home directory used for `~` expansion. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Strip a leading `@`, used for CLI @file paths. */
  stripAtPrefix?: boolean;
  /** Normalize unicode space variants to regular spaces. */
  normalizeUnicodeSpaces?: boolean;
}

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths to a form native Windows APIs accept. */
function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\"))
    return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
  let normalized = options.trim ? input.trim() : input;
  if (options.normalizeUnicodeSpaces) {
    normalized = normalized.replace(UNICODE_SPACES, " ");
  }
  if (options.stripAtPrefix && normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  if (process.platform === "win32") {
    normalized = normalizeWindowsShellPath(normalized);
  }

  if (options.expandTilde ?? true) {
    const home = options.homeDir ?? homedir();
    if (normalized === "~") return home;
    if (
      normalized.startsWith("~/") ||
      (process.platform === "win32" && normalized.startsWith("~\\"))
    ) {
      return join(home, normalized.slice(2));
    }
  }

  if (normalized.startsWith("file://")) {
    return fileURLToPath(normalized);
  }

  return normalized;
}

export function resolvePath(
  input: string,
  baseDir: string = process.cwd(),
  options: PathInputOptions = {},
): string {
  const normalized = normalizePath(input, options);
  const normalizedBaseDir = normalizePath(baseDir);
  return isAbsolute(normalized)
    ? nodeResolvePath(normalized)
    : nodeResolvePath(normalizedBaseDir, normalized);
}

export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
  const resolvedCwd = resolvePath(cwd);
  const resolvedPath = resolvePath(filePath, resolvedCwd);
  const relativePath = relative(resolvedCwd, resolvedPath);
  const isInsideCwd =
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));

  return isInsideCwd ? relativePath || "." : undefined;
}

export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
  const absolutePath = resolvePath(filePath, cwd);
  return (getCwdRelativePath(absolutePath, cwd) ?? absolutePath).split(sep).join("/");
}

// --- Tool path utilities (from pi's tools/path-utils.ts) ---

const NARROW_NO_BREAK_SPACE = " ";

function tryMacOSScreenshotPath(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
  // macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
  return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
  // macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
  // Users typically type U+0027 (straight apostrophe)
  return filePath.replace(/'/g, "’");
}

function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function expandPath(filePath: string): string {
  return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

export function resolveReadPath(filePath: string, cwd: string): string {
  const resolved = resolveToCwd(filePath, cwd);

  if (fileExists(resolved)) {
    return resolved;
  }

  // Try macOS AM/PM variant (narrow no-break space before AM/PM)
  const amPmVariant = tryMacOSScreenshotPath(resolved);
  if (amPmVariant !== resolved && fileExists(amPmVariant)) {
    return amPmVariant;
  }

  // Try NFD variant (macOS stores filenames in NFD form)
  const nfdVariant = tryNFDVariant(resolved);
  if (nfdVariant !== resolved && fileExists(nfdVariant)) {
    return nfdVariant;
  }

  // Try curly quote variant (macOS uses U+2019 in screenshot names)
  const curlyVariant = tryCurlyQuoteVariant(resolved);
  if (curlyVariant !== resolved && fileExists(curlyVariant)) {
    return curlyVariant;
  }

  // Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
  const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
  if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
    return nfdCurlyVariant;
  }

  return resolved;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
  const resolved = resolveToCwd(filePath, cwd);

  if (await pathExists(resolved)) {
    return resolved;
  }

  // Try macOS AM/PM variant (narrow no-break space before AM/PM)
  const amPmVariant = tryMacOSScreenshotPath(resolved);
  if (amPmVariant !== resolved && (await pathExists(amPmVariant))) {
    return amPmVariant;
  }

  // Try NFD variant (macOS stores filenames in NFD form)
  const nfdVariant = tryNFDVariant(resolved);
  if (nfdVariant !== resolved && (await pathExists(nfdVariant))) {
    return nfdVariant;
  }

  // Try curly quote variant (macOS uses U+2019 in screenshot names)
  const curlyVariant = tryCurlyQuoteVariant(resolved);
  if (curlyVariant !== resolved && (await pathExists(curlyVariant))) {
    return curlyVariant;
  }

  // Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
  const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
  if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) {
    return nfdCurlyVariant;
  }

  return resolved;
}
