/**
 * Per-plugin key-value storage on top of session facts. Keys are namespaced
 * by plugin id so two plugins cannot see each other's state.
 */
import type { SessionStorage } from "../harness/session/types.ts";
import type { PluginStorage } from "./types.ts";

/** The session fact a plugin's storage key resolves to. One place builds this string. */
export function pluginFactKey(pluginId: string, key: string): string {
  return `plugin:${pluginId}:${key}`;
}

export function pluginStorage(session: SessionStorage, pluginId: string): PluginStorage {
  return {
    get: (key) => session.getFact(pluginFactKey(pluginId, key)),
    set: (key, value) => session.setFact(pluginFactKey(pluginId, key), value),
  };
}
