/**
 * Per-plugin key-value storage on top of session facts. Keys are namespaced
 * by plugin id so two plugins cannot see each other's state.
 */
import type { JsonValue } from "@uji-ai/schema";
import type { SessionStorage } from "../harness/session/types.ts";
import type { PluginStorage } from "./types.ts";

export function pluginStorage(session: SessionStorage, pluginId: string): PluginStorage {
  const prefix = `plugin:${pluginId}:`;
  return {
    get: (key) => session.getFact(prefix + key),
    set: (key, value: JsonValue) => session.setFact(prefix + key, value),
    remove: (key) => session.setFact(prefix + key, undefined),
    scan: async (keyPrefix = "") =>
      (await session.listFacts(prefix + keyPrefix)).map(({ fact, value }) => ({
        key: fact.slice(prefix.length),
        value,
      })),
  };
}
