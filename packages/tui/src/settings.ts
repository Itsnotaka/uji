/**
 * Global and project settings. Project values override global values, including
 * individual compaction fields, after the workspace has been trusted.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/settings-manager.ts
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import type { Transport } from "@uji-ai/ai";
import { DEFAULT_COMPACTION_SETTINGS } from "@uji-ai/core";
import type { CompactionSettings, ThinkingLevel } from "@uji-ai/core";
import { MODEL_THINKING_LEVELS } from "@uji-ai/schema";

export const TRANSPORTS = [
  "sse",
  "websocket",
  "websocket-cached",
  "auto",
] satisfies readonly Transport[];

export interface CompactionSettingsFile {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

interface OptionalSettingsFile {
  defaultThinkingLevel?: ThinkingLevel;
  transport?: Transport;
  externalEditor?: string;
  compaction?: CompactionSettingsFile;
  /** Install a newer release when the TUI starts, instead of only saying one exists. */
  autoUpdate?: boolean;
}

type DefaultModelSettings =
  | { defaultProvider?: never; defaultModel?: never }
  | { defaultProvider: string; defaultModel?: string };

export type SettingsFile = OptionalSettingsFile & DefaultModelSettings;

interface ResolvedOptionalSettings {
  defaultThinkingLevel?: ThinkingLevel;
  transport: Transport;
  externalEditor?: string;
  compaction: CompactionSettings;
  autoUpdate: boolean;
}

export type ResolvedSettings = ResolvedOptionalSettings & DefaultModelSettings;

type DefaultModelPatch =
  | { defaultProvider?: never; defaultModel?: never }
  | { defaultProvider: string; defaultModel?: string };

export type SettingsPatch = Partial<OptionalSettingsFile> & DefaultModelPatch;

interface UnparsedCompactionSettings {
  enabled?: unknown;
  reserveTokens?: unknown;
  keepRecentTokens?: unknown;
}

interface UnparsedSettings {
  defaultProvider?: unknown;
  defaultModel?: unknown;
  defaultThinkingLevel?: unknown;
  transport?: unknown;
  externalEditor?: unknown;
  compaction?: unknown;
  autoUpdate?: unknown;
}

export function defaultSettingsPath(): string {
  const home = process.env["UJI_HOME"] ?? join(homedir(), ".uji");
  return join(home, "settings.json");
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, ".uji", "settings.json");
}

function requireSettingsObject(value: unknown, path: string): UnparsedSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function requireCompactionObject(value: unknown, path: string): UnparsedCompactionSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function optionalString(
  value: UnparsedSettings,
  key: "defaultProvider" | "defaultModel" | "externalEditor",
  path: string,
): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.trim() === "") {
    throw new Error(`${path}.${key} must be a non-empty string`);
  }
  return field;
}

function optionalTokenCount(
  value: UnparsedCompactionSettings,
  key: "reserveTokens" | "keepRecentTokens",
  path: string,
): number | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new Error(`${path}.${key} must be a non-negative safe integer`);
  }
  return field;
}

export function parseSettingsFile(value: unknown, path = "settings"): SettingsFile {
  const object = requireSettingsObject(value, path);
  const allowed = new Set([
    "defaultProvider",
    "defaultModel",
    "defaultThinkingLevel",
    "transport",
    "externalEditor",
    "compaction",
    "autoUpdate",
    // Read and dropped: fast mode is session state the plugin owns. Files
    // written by an older build lose the key on their next write.
    "fastMode",
  ]);
  const unknown = Object.keys(object).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`${path} has unknown property "${unknown}"`);

  const defaultProvider = optionalString(object, "defaultProvider", path);
  const defaultModel = optionalString(object, "defaultModel", path);
  if (defaultModel !== undefined && defaultProvider === undefined) {
    throw new Error(`${path}.defaultModel requires ${path}.defaultProvider`);
  }
  const externalEditor = optionalString(object, "externalEditor", path);

  const thinking = object.defaultThinkingLevel;
  const defaultThinkingLevel = MODEL_THINKING_LEVELS.find((level) => level === thinking);
  if (thinking !== undefined && defaultThinkingLevel === undefined) {
    throw new Error(`${path}.defaultThinkingLevel must be ${MODEL_THINKING_LEVELS.join(", ")}`);
  }

  const transportValue = object.transport;
  const transport = TRANSPORTS.find((candidate) => candidate === transportValue);
  if (transportValue !== undefined && transport === undefined) {
    throw new Error(`${path}.transport must be ${TRANSPORTS.join(", ")}`);
  }

  const autoUpdate = object.autoUpdate;
  if (autoUpdate !== undefined && typeof autoUpdate !== "boolean") {
    throw new Error(`${path}.autoUpdate must be a boolean`);
  }

  let compaction: CompactionSettingsFile | undefined;
  const compactionValue = object.compaction;
  if (compactionValue !== undefined) {
    const compactionPath = `${path}.compaction`;
    const source = requireCompactionObject(compactionValue, compactionPath);
    const compactionAllowed = new Set(["enabled", "reserveTokens", "keepRecentTokens"]);
    const unknownCompaction = Object.keys(source).find((key) => !compactionAllowed.has(key));
    if (unknownCompaction !== undefined) {
      throw new Error(`${compactionPath} has unknown property "${unknownCompaction}"`);
    }
    const enabled = source.enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw new Error(`${compactionPath}.enabled must be a boolean`);
    }
    const reserveTokens = optionalTokenCount(source, "reserveTokens", compactionPath);
    const keepRecentTokens = optionalTokenCount(source, "keepRecentTokens", compactionPath);
    compaction = {
      ...(enabled === undefined ? {} : { enabled }),
      ...(reserveTokens === undefined ? {} : { reserveTokens }),
      ...(keepRecentTokens === undefined ? {} : { keepRecentTokens }),
    };
  }

  const optional: OptionalSettingsFile = {
    ...(defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel }),
    ...(transport === undefined ? {} : { transport }),
    ...(externalEditor === undefined ? {} : { externalEditor }),
    ...(compaction === undefined ? {} : { compaction }),
    ...(autoUpdate === undefined ? {} : { autoUpdate }),
  };
  if (defaultProvider === undefined) return optional;
  return {
    ...optional,
    defaultProvider,
    ...(defaultModel === undefined ? {} : { defaultModel }),
  };
}

async function readSettings(path: string): Promise<SettingsFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}`, { cause: error });
  }
  return parseSettingsFile(parsed, path);
}

function defaultModelSettings(settings: SettingsFile): DefaultModelSettings {
  if (settings.defaultProvider === undefined) return {};
  return {
    defaultProvider: settings.defaultProvider,
    ...(settings.defaultModel === undefined ? {} : { defaultModel: settings.defaultModel }),
  };
}

function mergeSettings(global: SettingsFile, project: SettingsFile): ResolvedSettings {
  const model =
    project.defaultProvider === undefined
      ? defaultModelSettings(global)
      : defaultModelSettings(project);
  const defaultThinkingLevel = project.defaultThinkingLevel ?? global.defaultThinkingLevel;
  const externalEditor = project.externalEditor ?? global.externalEditor;
  return {
    ...model,
    ...(defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel }),
    transport: project.transport ?? global.transport ?? "auto",
    ...(externalEditor === undefined ? {} : { externalEditor }),
    compaction: {
      ...DEFAULT_COMPACTION_SETTINGS,
      ...global.compaction,
      ...project.compaction,
    },
    autoUpdate: project.autoUpdate ?? global.autoUpdate ?? false,
  };
}

function applySettingsPatch(current: SettingsFile, patch: SettingsPatch): SettingsFile {
  const model =
    patch.defaultProvider === undefined
      ? defaultModelSettings(current)
      : {
          defaultProvider: patch.defaultProvider,
          ...(patch.defaultModel === undefined ? {} : { defaultModel: patch.defaultModel }),
        };
  const defaultThinkingLevel = patch.defaultThinkingLevel ?? current.defaultThinkingLevel;
  const transport = patch.transport ?? current.transport;
  const externalEditor = patch.externalEditor ?? current.externalEditor;
  const compaction =
    patch.compaction === undefined
      ? current.compaction
      : { ...current.compaction, ...patch.compaction };
  const autoUpdate = patch.autoUpdate ?? current.autoUpdate;
  const optional: OptionalSettingsFile = {
    ...(defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel }),
    ...(transport === undefined ? {} : { transport }),
    ...(externalEditor === undefined ? {} : { externalEditor }),
    ...(compaction === undefined ? {} : { compaction }),
    ...(autoUpdate === undefined ? {} : { autoUpdate }),
  };
  if (model.defaultProvider === undefined) return optional;
  return {
    ...optional,
    defaultProvider: model.defaultProvider,
    ...(model.defaultModel === undefined ? {} : { defaultModel: model.defaultModel }),
  };
}

async function writeSettings(path: string, settings: SettingsFile): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let committed = false;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    committed = true;
  } finally {
    if (!committed) await unlink(temporaryPath).catch(() => undefined);
  }
}

/** Reads trusted project settings over user settings and serializes global updates. */
export class FileSettingsStore {
  private readonly globalPath: string;
  private writes = Promise.resolve();

  constructor(globalPath: string = defaultSettingsPath()) {
    this.globalPath = globalPath;
  }

  async read(cwd: string): Promise<ResolvedSettings> {
    await this.writes;
    const [global, project] = await Promise.all([
      readSettings(this.globalPath),
      readSettings(projectSettingsPath(cwd)),
    ]);
    return mergeSettings(global, project);
  }

  updateGlobal(patch: SettingsPatch): Promise<void> {
    return this.update(this.globalPath, patch);
  }

  updateProject(cwd: string, patch: SettingsPatch): Promise<void> {
    return this.update(projectSettingsPath(cwd), patch);
  }

  private update(path: string, patch: SettingsPatch): Promise<void> {
    const next = this.writes.then(async () => {
      const current = await readSettings(path);
      await writeSettings(path, applySettingsPatch(current, patch));
    });
    this.writes = next.catch(() => undefined);
    return next;
  }
}
