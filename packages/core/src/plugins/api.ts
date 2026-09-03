/**
 * Binds one plugin to one harness. Every registration goes through the
 * plugin's scope, so disposing the scope removes the plugin completely.
 */
import type { HarnessTool } from "../harness/agent-harness.ts";
import type { HookHandler, HookName } from "../harness/hooks.ts";
import type { PluginHostTarget } from "./host.ts";
import type { ContributionRegistry, MapDraft, ToolMapDraft } from "./registry.ts";
import type { PluginScope } from "./scope.ts";
import { pluginStorage } from "./storage.ts";
import type {
  Agent,
  AgentRegistry,
  Disposer,
  Draft,
  LoadedPlugin,
  Registry,
  SessionApi,
  ToolRegistry,
} from "./types.ts";

export function bindSessionApi(
  target: PluginHostTarget,
  plugin: LoadedPlugin,
  scope: PluginScope,
  order: number,
): SessionApi {
  const registry = <T, D extends Draft<T>>(inner: ContributionRegistry<T, D>): Registry<D> => ({
    add: (contribution) => scope.track(inner.add(plugin.id, order, contribution)),
    rebuild: () => {
      const diff = inner.rebuild();
      target.rebuildAll();
      return diff;
    },
  });

  const agentRegistry = (inner: ContributionRegistry<Agent, MapDraft<Agent>>): AgentRegistry => ({
    ...registry(inner),
    list: () => inner.values(),
  });

  const toolRegistry = (inner: ContributionRegistry<HarnessTool, ToolMapDraft>): ToolRegistry => ({
    ...registry(inner),
    list: () => inner.values(),
  });

  return {
    env: target.env,

    tools: toolRegistry(target.registries.tools),
    commands: registry(target.registries.commands),
    prompt: registry(target.registries.prompt),
    resources: registry(target.registries.resources),
    settings: registry(target.registries.settings),
    agents: agentRegistry(target.registries.agents),

    hook<TName extends HookName>(name: TName, handler: HookHandler<TName>): Disposer {
      return scope.track(target.hooks.on(name, handler, { id: plugin.id }));
    },

    storage: pluginStorage(target.session, plugin.id),
    diagnostics: {
      warn: (message) => {
        void target.emit({ kind: "diagnostic", owner: plugin.id, level: "warn", message });
      },
    },
  };
}
