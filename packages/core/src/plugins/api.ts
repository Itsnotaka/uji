/**
 * Binds one plugin to one harness. Every registration goes through the
 * plugin's scope, so disposing the scope removes the plugin completely.
 */
import type { HarnessEvent } from "../harness/agent-harness.ts";
import type { HookHandler, HookName } from "../harness/hooks.ts";
import type { PluginHost, PluginHostTarget } from "./host.ts";
import type { ContributionRegistry } from "./registry.ts";
import type { PluginScope } from "./scope.ts";
import { pluginStorage } from "./storage.ts";
import type { Disposer, Draft, LoadedPlugin, Registry, SessionApi } from "./types.ts";

export function bindSessionApi(
  target: PluginHostTarget,
  host: PluginHost,
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

  const diagnostic = (level: "warn" | "error", message: string): void => {
    void target.emit({ type: "diagnostic", level, owner: plugin.id, message });
  };

  return {
    id: plugin.id,
    options: plugin.options ?? {},
    env: target.env,

    tools: registry(target.registries.tools),
    commands: registry(target.registries.commands),
    prompt: registry(target.registries.prompt),
    resources: registry(target.registries.resources),
    settings: registry(target.registries.settings),

    hook<TName extends HookName>(name: TName, handler: HookHandler<TName>): Disposer {
      return scope.track(target.hooks.on(name, handler, { id: plugin.id }));
    },

    on(type, listener) {
      return scope.track(
        target.subscribe((event: HarnessEvent) => {
          if (event.type !== type) return undefined;
          // SAFETY: the `type` check above selects exactly the HarnessEvent member the listener was registered for.
          return listener(event as Parameters<typeof listener>[0]);
        }),
      );
    },

    effect: (setup) => scope.effect(setup),

    storage: pluginStorage(target.session, plugin.id),
    ask: (request) => target.ask(plugin.id, request),
    plugins: { list: () => host.list() },
    diagnostics: {
      warn: (message) => diagnostic("warn", message),
      error: (message) => diagnostic("error", message),
    },
  };
}
