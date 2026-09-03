/**
 * The desktop's plugin composition, mirroring the TUI host's: the same
 * built-ins, the same `~/.uji` and `<cwd>/.uji` directories, the same
 * manifest. Trust is the argument: `resolveDesktopPlugins` takes a
 * `TrustedWorkspace`, a value that exists only after the trust gate
 * (invariant 21), so project code cannot load before the grant.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "@uji-ai/ai";
import type { Api, Model, Models } from "@uji-ai/ai";
import { resolvePlugins } from "@uji-ai/core";
import type {
  PluginDirectory,
  PluginManifest,
  ResolvedPlugins,
  TrustedWorkspace,
} from "@uji-ai/core";
import { fastModePlugin } from "@uji-ai/plugin/examples/fast-mode";
import {
  webSearchCredentialId,
  webSearchPlugin,
  type WebSearchCredentials,
} from "@uji-ai/plugin/examples/web-search";
import {
  SKILLS_PLUGIN_ID,
  contextFilesPlugin,
  skillsPlugin,
  systemPromptPlugin,
  toolsFsPlugin,
} from "@uji-ai/core/plugins";
import { toJsonValue } from "@uji-ai/core/store";

/** A new generation per resolve, so re-opening a workspace re-scans skills. */
let skillsGeneration = 0;

export async function resolveDesktopPlugins(
  workspace: TrustedWorkspace,
  context: { model: Model<Api>; models: Models },
): Promise<ResolvedPlugins> {
  const { cwd } = workspace;
  return resolvePlugins({
    builtins: [
      systemPromptPlugin(),
      contextFilesPlugin({ globalDir: join(homedir(), ".uji") }),
      toolsFsPlugin(),
      fastModePlugin(context.model),
      webSearchPlugin({ credentials: webSearchCredentials() }),
      skillsPlugin({ directories: skillDirectories(cwd) }),
    ],
    directories: pluginDirectories(cwd),
    manifest: await readManifest(cwd),
    builtinVersions: { [SKILLS_PLUGIN_ID]: `builtin:${String(++skillsGeneration)}` },
  });
}

function pluginDirectories(cwd: string): PluginDirectory[] {
  return [
    { path: join(homedir(), ".uji", "plugins"), source: "user" },
    { path: join(cwd, ".uji", "plugins"), source: "project" },
  ];
}

/** Project skills override user skills; Uji-native locations win over compatibility locations. */
function skillDirectories(cwd: string): string[] {
  return [
    join(cwd, ".uji", "skills"),
    join(cwd, ".agents", "skills"),
    join(cwd, ".claude", "skills"),
    join(homedir(), ".uji", "skills"),
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".claude", "skills"),
  ];
}

function webSearchCredentials(): WebSearchCredentials {
  const store = new FileCredentialStore();
  return {
    async read(provider) {
      const credential = await store.read(webSearchCredentialId(provider));
      return credential?.type === "api_key" ? credential.key : undefined;
    },
    async write(provider, key) {
      const id = webSearchCredentialId(provider);
      if (key === undefined) {
        await store.delete(id);
        return;
      }
      await store.modify(id, () => Promise.resolve({ type: "api_key", key }));
    },
  };
}

/** `.uji/uji.json` in the project; optional. Disables ids and sets options, never lists plugins. */
async function readManifest(cwd: string): Promise<PluginManifest | undefined> {
  let text: string;
  try {
    text = await readFile(join(cwd, ".uji", "uji.json"), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return parsePluginManifest(JSON.parse(text));
}

type ManifestPlugin = NonNullable<PluginManifest["plugins"]>[number];

function unknownProperty(value: unknown, allowed: readonly string[], path: string): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${path} must be an object`);
  }
  const key = Object.keys(value).find((candidate) => !allowed.includes(candidate));
  if (key !== undefined) throw new Error(`${path} has unknown property "${key}"`);
}

function parseManifestPlugin(value: unknown, index: number): ManifestPlugin {
  if (typeof value === "string") return value;
  const path = `.uji/uji.json.plugins[${String(index)}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a string or object`);
  }
  unknownProperty(value, ["id", "options"], path);
  if (!("id" in value) || typeof value.id !== "string") {
    throw new Error(`${path}.id must be a string`);
  }
  if (!("options" in value)) return { id: value.id };
  try {
    return { id: value.id, options: toJsonValue(value.options) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}.options must be JSON: ${message}`, { cause: error });
  }
}

function parsePluginManifest(value: unknown): PluginManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(".uji/uji.json must be an object");
  }
  unknownProperty(value, ["plugins"], ".uji/uji.json");
  if (!("plugins" in value)) return {};
  if (!Array.isArray(value.plugins)) {
    throw new Error(".uji/uji.json.plugins must be an array");
  }
  const plugins: ManifestPlugin[] = [];
  for (const [index, plugin] of value.plugins.entries()) {
    plugins.push(parseManifestPlugin(plugin, index));
  }
  return { plugins };
}
