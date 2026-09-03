import { statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { imageInfo } from "@opentui/core";
import type { ImageContent, UserMessage } from "@uji-ai/schema";
import fuzzysort from "fuzzysort";
import { completionTrigger } from "./completion-trigger.ts";

const MAX_MENTION_FILES = 5_000;
const MAX_MENTION_RESULTS = 10;
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
type SupportedImageMime = "image/gif" | "image/jpeg" | "image/png" | "image/webp";
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".uji",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

export type ComposerPart =
  | {
      kind: "file";
      marker: string;
      path: string;
      /** File body, once read. Absent for binaries, oversized files, and unreadable paths. */
      text?: string;
    }
  | {
      kind: "image";
      marker: string;
      image: ImageContent;
    }
  | {
      kind: "paste";
      marker: string;
      text: string;
    };

type ComposerPaste =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string }
  | { kind: "image"; image: ImageContent };

export interface MentionFile {
  path: string;
  displayPath: string;
  label: string;
}

interface FileMention {
  source: string;
  path: string;
}

interface PreparedComposerPrompt {
  displayText: string;
  message: UserMessage;
  parts: readonly ComposerPart[];
}

function imageMimeType(data: Uint8Array): SupportedImageMime | undefined {
  try {
    switch (imageInfo(data).format) {
      case "png":
        return "image/png";
      case "jpeg":
        return "image/jpeg";
      case "webp":
        return "image/webp";
      case "gif":
        return "image/gif";
      case "raw-rgba":
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * A paste this tall stops being text you are editing and becomes an
 * attachment: the composer holds a marker and the model still gets every line.
 */
export const PASTE_COLLAPSE_LINES = 8;

export function pasteLineCount(text: string): number {
  return text.split("\n").length;
}

/** Turn an OpenTUI binary paste into the same image part used by file-path paste. */
export function resolveComposerImagePaste(
  bytes: Uint8Array,
): Extract<ComposerPaste, { kind: "image" }> | undefined {
  const mimeType = imageMimeType(bytes);
  if (mimeType === undefined) return undefined;
  return {
    kind: "image",
    image: { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType },
  };
}

function pastedPath(value: string, cwd: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("\n")) return undefined;
  const raw = trimmed.replace(/^['"]+|['"]+$/g, "");
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw);
    } catch {
      return undefined;
    }
  }
  const unescaped = process.platform === "win32" ? raw : raw.replace(/\\(.)/g, "$1");
  return resolve(cwd, unescaped);
}

/** Classify a terminal paste once, before the textarea inserts it. */
export async function resolveComposerPaste(value: string, cwd: string): Promise<ComposerPaste> {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const path = pastedPath(normalized, cwd);
  if (path === undefined) return { kind: "text", text: normalized };
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) return { kind: "text", text: normalized };
  if (!info.isFile()) return { kind: "text", text: normalized };
  if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) {
    return { kind: "file", path };
  }
  const bytes = await readFile(path).catch(() => undefined);
  if (bytes === undefined) return { kind: "text", text: normalized };
  const mimeType = imageMimeType(bytes);
  if (mimeType === undefined) return { kind: "file", path };
  return {
    kind: "image",
    image: { type: "image", data: bytes.toString("base64"), mimeType },
  };
}

/**
 * A mentioned folder is a real thing the user can hand the model, so paths
 * that name directories carry a trailing separator everywhere: in the walked
 * list, in composer parts, and in the `@file://…/` mention the model sees.
 * That one convention is what lets pure code tell folders from files without
 * touching the disk.
 */
function isFolderPath(path: string): boolean {
  return path.endsWith(sep) || path.endsWith("/");
}

/**
 * Files and folders offered by `@` completion. Common generated trees are
 * skipped at the walk boundary.
 */
export async function discoverMentionFiles(cwd: string): Promise<MentionFile[]> {
  const files: MentionFile[] = [];
  const pending = [cwd];
  while (pending.length > 0 && files.length < MAX_MENTION_FILES) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_MENTION_FILES) break;
      const path = join(directory, entry.name);
      const displayPath = relative(cwd, path).split("\\").join("/");
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        pending.push(path);
        files.push({
          path: path + sep,
          displayPath: `${displayPath}/`,
          label: `${entry.name}/`,
        });
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({ path, displayPath, label: basename(path) });
    }
  }
  return files.toSorted((left, right) => left.displayPath.localeCompare(right.displayPath));
}

interface FileMentionQuery {
  /** The `@token` a completed mention replaces. */
  start: number;
  end: number;
  /** What the cursor has typed into it so far, which is what filters. */
  query: string;
}

/** The `@query` the cursor sits in, wherever in the buffer that is. */
function fileMentionQuery(
  value: string,
  cursor = value.length,
): FileMentionQuery | undefined {
  const trigger = completionTrigger(value, cursor);
  if (trigger?.kind !== "@") return undefined;
  return { start: trigger.start, end: trigger.end, query: trigger.query };
}

/**
 * The walked list stops at cwd, so `@../core.md` or `@~/notes.md` never fuzzy
 * matches anything. A query that is spelled as a path gets resolved directly
 * and, when it names a real file or folder, offered first.
 */
function explicitMentionFile(query: string, cwd: string): MentionFile | undefined {
  if (query === "" || !/^(\.{1,2}[/\\]|~[/\\]|[/\\]|[A-Za-z]:[/\\])/.test(query)) {
    return undefined;
  }
  const expanded = query.startsWith("~") ? join(homedir(), query.slice(2)) : query;
  const path = resolve(cwd, expanded);
  let info;
  try {
    info = statSync(path);
  } catch {
    return undefined;
  }
  const rel = relative(cwd, path).split("\\").join("/");
  if (info.isDirectory()) {
    // `relative` is empty when the query names cwd itself; "./" is that folder.
    return {
      path: path + sep,
      displayPath: rel === "" ? "./" : `${rel}/`,
      label: `${basename(path)}/`,
    };
  }
  if (!info.isFile()) return undefined;
  return { path, displayPath: rel, label: basename(path) };
}

/**
 * Paths the query is a prefix of, in walk order. Typing the first letters of a
 * name is the most common way to reach it, so those land above anything the
 * fuzzy pass scores highly for matching scattered letters deep in a path.
 */
function prefixedMentionFiles(query: string, files: readonly MentionFile[]): MentionFile[] {
  const matches: MentionFile[] = [];
  for (const file of files) {
    if (matches.length >= MAX_MENTION_RESULTS) break;
    if (
      file.label.toLowerCase().startsWith(query) ||
      file.displayPath.toLowerCase().startsWith(query)
    ) {
      matches.push(file);
    }
  }
  return matches;
}

export function fileMentionSuggestions(
  value: string,
  files: readonly MentionFile[],
  cwd?: string,
  cursor = value.length,
): { query: FileMentionQuery; files: MentionFile[] } | undefined {
  const query = fileMentionQuery(value, cursor);
  if (query === undefined) return undefined;
  let matches: MentionFile[];
  if (query.query === "") {
    matches = files.slice(0, MAX_MENTION_RESULTS);
  } else {
    const prefixed = prefixedMentionFiles(query.query.toLowerCase(), files);
    const seen = new Set(prefixed.map((file) => file.path));
    matches = [
      ...prefixed,
      ...fuzzysort
        .go(query.query, files, {
          keys: ["displayPath", "label"],
          limit: MAX_MENTION_RESULTS,
        })
        .flatMap((result) => (seen.has(result.obj.path) ? [] : [result.obj])),
    ].slice(0, MAX_MENTION_RESULTS);
  }
  const explicit = cwd === undefined ? undefined : explicitMentionFile(query.query, cwd);
  if (explicit !== undefined && !matches.some((file) => file.path === explicit.path)) {
    matches.unshift(explicit);
  }
  return { query, files: matches };
}

const FILE_URL_PATTERN = /@file:\/\/[^\s]+/g;

export function extractFileMentions(text: string): FileMention[] {
  return [...text.matchAll(FILE_URL_PATTERN)].flatMap((match) => {
    const source = match[0];
    try {
      return [{ source, path: fileURLToPath(source.slice(1)) }];
    } catch {
      return [];
    }
  });
}

/**
 * A file the user attached is context they already chose to hand over, so the
 * body travels inside the message instead of as a bare path the model has to
 * spend a read call on. The wrapper is what lets any client find the body
 * again and fold it back into a tag; a client that ignores it still shows the
 * model exactly what the model saw.
 */
const FILE_ATTACHMENT_PATTERN = /<file src="(file:\/\/[^"\n]+)">\n([\s\S]*?)\n<\/file>/g;
const ATTACHMENT_CLOSING_TAG = "</file>";

/** Big enough for real source files, small enough to never blow a context window by accident. */
const MAX_ATTACHMENT_BYTES = 256_000;

interface FileAttachment {
  source: string;
  path: string;
  text: string;
}

export function fileAttachmentBlock(path: string, text: string): string {
  return `<file src="${pathToFileURL(path).href}">\n${text}\n${ATTACHMENT_CLOSING_TAG}`;
}

export function extractFileAttachments(text: string): FileAttachment[] {
  return [...text.matchAll(FILE_ATTACHMENT_PATTERN)].flatMap((match) => {
    const [source, url, body] = match;
    if (url === undefined || body === undefined) return [];
    try {
      return [{ source, path: fileURLToPath(url), text: body }];
    } catch {
      return [];
    }
  });
}

/**
 * Only text bodies inline. Folders have no body, binaries would be mojibake, oversized files would
 * quietly eat the context window, and a body carrying the closing tag would
 * break the wrapper for every reader downstream. Each of those falls back to
 * the plain mention, which is what the composer sent before bodies existed.
 */
async function readAttachmentText(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.size > MAX_ATTACHMENT_BYTES) return undefined;
  const bytes = await readFile(path).catch(() => undefined);
  if (bytes === undefined || bytes.byteLength > MAX_ATTACHMENT_BYTES || bytes.includes(0)) {
    return undefined;
  }
  const text = bytes.toString("utf8");
  return text.includes(ATTACHMENT_CLOSING_TAG) ? undefined : text;
}

function fileMarker(path: string): string {
  return isFolderPath(path) ? `[Folder ${basename(path)}]` : `[File ${basename(path)}]`;
}

/** Highest number already used by a marker of this kind, plus one. */
function nextMarkerNumber(parts: readonly ComposerPart[], kind: ComposerPart["kind"]): number {
  return parts
    .filter((part) => part.kind === kind)
    .reduce((max, part) => Math.max(max, Number(/\d+/.exec(part.marker)?.[0] ?? 0) + 1), 1);
}

interface ComposerDraft {
  readonly text: string;
  readonly parts: readonly ComposerPart[];
}

/** Unsent composer state, scoped to this TUI process and keyed by chat. */
export class SessionDrafts {
  private readonly drafts = new Map<string, ComposerDraft>();

  save(sessionId: string, text: string, parts: readonly ComposerPart[]): void {
    if (text === "" && parts.length === 0) {
      this.drafts.delete(sessionId);
      return;
    }
    this.drafts.set(sessionId, { text, parts: [...parts] });
  }

  read(sessionId: string): ComposerDraft | undefined {
    return this.drafts.get(sessionId);
  }
}

/**
 * Composer-owned rich parts. The textarea only carries short markers; this
 * expands file and paste markers and attaches image bytes at the submission
 * boundary.
 */
export class ComposerParts {
  private parts: ComposerPart[] = [];
  private nextImage = 1;
  private nextPaste = 1;
  /**
   * Reads start when the tag is inserted and are awaited at submission, so a
   * fast Enter can never race a file into the model as a bare path.
   */
  private readonly bodies = new Map<string, Promise<string | undefined>>();

  /**
   * Retained parts in insertion order. Snapshot the list so a consumer can
   * compare it with a later read without addFile, addImage, or addPaste
   * mutating its previous view; the part objects stay stable for cheap identity
   * checks.
   */
  get current(): readonly ComposerPart[] {
    return [...this.parts];
  }

  /** Resolve the body read that began when this file entered the composer. */
  async fileBody(part: Extract<ComposerPart, { kind: "file" }>): Promise<string | undefined> {
    if (part.text !== undefined) return part.text;
    return await this.bodies.get(part.path);
  }

  addFile(path: string): string {
    if (!this.bodies.has(path)) this.bodies.set(path, readAttachmentText(path));
    const existing = this.parts.find((part) => part.kind === "file" && part.path === path);
    if (existing !== undefined) return existing.marker;
    const marker = this.uniqueMarker(fileMarker(path));
    this.parts.push({ kind: "file", marker, path });
    return marker;
  }

  addImage(image: ImageContent): string {
    const marker = `[Image ${String(this.nextImage++)}]`;
    this.parts.push({ kind: "image", marker, image });
    return marker;
  }

  /** Park a tall paste behind a marker. `prepare` puts the lines back. */
  addPaste(text: string): string {
    const marker = `[Paste #${String(this.nextPaste++)} ${String(pasteLineCount(text))} lines]`;
    this.parts.push({ kind: "paste", marker, text });
    return marker;
  }

  retain(value: string): void {
    const retained = this.parts.filter((part) => value.includes(part.marker));
    const retainedFiles = new Set(
      retained.flatMap((part) => (part.kind === "file" ? [part.path] : [])),
    );
    for (const path of this.bodies.keys()) {
      if (!retainedFiles.has(path)) this.bodies.delete(path);
    }
    this.parts = retained;
  }

  clear(): void {
    this.parts = [];
    this.nextImage = 1;
    this.nextPaste = 1;
    this.bodies.clear();
  }

  restore(parts: readonly ComposerPart[]): void {
    this.clear();
    this.parts = [...parts];
    this.nextImage = nextMarkerNumber(this.parts, "image");
    this.nextPaste = nextMarkerNumber(this.parts, "paste");
    for (const part of this.parts) {
      if (part.kind === "file") {
        this.bodies.set(
          part.path,
          part.text === undefined ? readAttachmentText(part.path) : Promise.resolve(part.text),
        );
      }
    }
  }

  load(content: UserMessage["content"]): string {
    this.clear();
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else {
      for (const part of content) {
        if (part.type === "text") {
          text += part.text;
          continue;
        }
        const marker = this.addImage(part);
        if (!text.includes(marker)) text += marker;
      }
    }
    // Attachments first: an inlined body already holds the file, so re-reading
    // from disk on edit would silently swap in content the turn never sent.
    for (const attachment of extractFileAttachments(text)) {
      this.bodies.set(attachment.path, Promise.resolve(attachment.text));
      text = text.replace(attachment.source, this.addFile(attachment.path));
    }
    for (const mention of extractFileMentions(text)) {
      const marker = this.addFile(mention.path);
      text = text.replace(mention.source, marker);
    }
    return text;
  }

  /**
   * Async, but the draft is snapshotted before the first await, so the caller
   * may clear the composer the moment this is called without losing parts.
   *
   * `expandText` rewrites what the user typed on its way to the model — skill
   * invocations, today. It runs before markers expand, so it only ever sees
   * typed text and never the body of a file the draft attached.
   */
  async prepare(
    value: string,
    timestamp = Date.now(),
    expandText: (text: string) => string = (text) => text,
  ): Promise<PreparedComposerPrompt> {
    const rawDisplayText = value.trim();
    const snapshot = this.parts
      .filter((part) => rawDisplayText.includes(part.marker))
      .toSorted(
        (left, right) => rawDisplayText.indexOf(left.marker) - rawDisplayText.indexOf(right.marker),
      );
    const bodies = await Promise.all(
      snapshot.map(async (part) =>
        part.kind === "file" ? await this.bodies.get(part.path) : undefined,
      ),
    );
    const parts: ComposerPart[] = snapshot.map((part, index) => {
      const text = bodies[index];
      return part.kind === "file" && text !== undefined ? { ...part, text } : part;
    });
    const images = parts.filter((part) => part.kind === "image");
    const imageMarkers = new Map(
      images.map((part, index) => [part.marker, `[Image ${String(index + 1)}]`]),
    );
    const displayText = rawDisplayText.replace(
      /\[Image \d+\]/g,
      (marker) => imageMarkers.get(marker) ?? marker,
    );
    const expandFiles = (text: string): string => {
      let expanded = expandText(text);
      for (const part of parts) {
        if (part.kind === "file") {
          expanded = expanded.replaceAll(
            part.marker,
            part.text === undefined
              ? `@${pathToFileURL(part.path).href}`
              : fileAttachmentBlock(part.path, part.text),
          );
        }
        if (part.kind === "paste") expanded = expanded.replaceAll(part.marker, part.text);
      }
      return expanded;
    };
    let content: UserMessage["content"];
    if (images.length === 0) {
      content = expandFiles(rawDisplayText);
    } else {
      const richContent: Exclude<UserMessage["content"], string> = [];
      const byMarker = new Map(images.map((part) => [part.marker, part.image]));
      let cursor = 0;
      for (const match of rawDisplayText.matchAll(/\[Image \d+\]/g)) {
        const marker = match[0];
        const image = byMarker.get(marker);
        if (image === undefined || match.index === undefined) continue;
        const text = expandFiles(rawDisplayText.slice(cursor, match.index));
        if (text !== "") richContent.push({ type: "text", text });
        richContent.push(image);
        cursor = match.index + marker.length;
      }
      const tail = expandFiles(rawDisplayText.slice(cursor));
      if (tail !== "") richContent.push({ type: "text", text: tail });
      content = richContent;
    }
    return {
      displayText,
      message: {
        role: "user",
        content,
        timestamp,
      },
      parts,
    };
  }

  private uniqueMarker(base: string): string {
    if (!this.parts.some((part) => part.marker === base)) return base;
    let suffix = 2;
    while (this.parts.some((part) => part.marker === `${base.slice(0, -1)} ${String(suffix)}]`)) {
      suffix += 1;
    }
    return `${base.slice(0, -1)} ${String(suffix)}]`;
  }
}
