/**
 * The plugin host owns one map: plugin id to live scope. `activate(list)` is
 * the only mutation; reload, add, remove, and option changes are all
 * `activate` with a different list. Plugins whose (id, version) did not change
 * are left alone. A plugin whose factory throws is recorded as failed and its
 * previous version, if any, is put back.
 *
 * Shape from opencode v2 `Plugin.activate` (packages/core/src/plugin.ts).
 */
import type { Skill } from "@uji-ai/schema";
import type { HarnessEvent, HarnessTool } from "../harness/agent-harness.ts";
import type { Hooks } from "../harness/hooks.ts";
import type { SessionStorage } from "../harness/session/types.ts";
import { Result, type Result as ResultValue } from "../harness/result.ts";
import { bindSessionApi } from "./api.ts";
import {
  ContributionRegistry,
  MapDraft,
  ToolMapDraft,
  type ToolMapDraft as ToolDraftImpl,
} from "./registry.ts";
import { PluginScope } from "./scope.ts";
import type {
  AskAnswer,
  AskRequest,
  Command,
  Disposer,
  LoadedPlugin,
  PluginEnv,
  PluginInfo,
  PluginSetting,
  PromptSection,
} from "./types.ts";

export interface HarnessRegistries {
  readonly tools: ContributionRegistry<HarnessTool, ToolDraftImpl>;
  readonly commands: ContributionRegistry<Command, MapDraft<Command>>;
  readonly prompt: ContributionRegistry<PromptSection, MapDraft<PromptSection>>;
  readonly resources: ContributionRegistry<Skill, MapDraft<Skill>>;
  readonly settings: ContributionRegistry<PluginSetting, MapDraft<PluginSetting>>;
}

export function createRegistries(): HarnessRegistries {
  return {
    tools: new ContributionRegistry(() => new ToolMapDraft()),
    commands: new ContributionRegistry(() => new MapDraft<Command>()),
    prompt: new ContributionRegistry(() => new MapDraft<PromptSection>()),
    resources: new ContributionRegistry(() => new MapDraft<Skill>()),
    settings: new ContributionRegistry(() => new MapDraft<PluginSetting>()),
  };
}

/** What the host needs from the harness. `AgentHarness` satisfies it structurally. */
export interface PluginHostTarget {
  readonly hooks: Hooks;
  readonly registries: HarnessRegistries;
  readonly session: SessionStorage;
  readonly env: PluginEnv;
  subscribe(listener: (event: HarnessEvent) => void | Promise<void>): Disposer;
  ask<TRequest extends AskRequest>(
    pluginId: string,
    request: TRequest,
  ): Promise<AskAnswer<TRequest>>;
  /** Replay every registry and emit `config_update` for each one that changed. */
  rebuildAll(): void;
  emit(event: HarnessEvent): Promise<void>;
}

interface ActivePlugin {
  plugin: LoadedPlugin;
  scope: PluginScope;
}

export class PluginHost {
  private readonly target: PluginHostTarget;
  private readonly active = new Map<string, ActivePlugin>();
  private inventory: PluginInfo[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(target: PluginHostTarget) {
    this.target = target;
  }

  list(): readonly PluginInfo[] {
    return this.inventory;
  }

  activate(next: readonly LoadedPlugin[]): Promise<readonly PluginInfo[]> {
    const run = this.tail.then(() => this.activateNow(next));
    this.tail = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.activate([]);
    this.closed = true;
  }

  private async activateNow(next: readonly LoadedPlugin[]): Promise<readonly PluginInfo[]> {
    if (this.closed) throw new Error("plugin host is closed");
    assertUniqueIds(next);
    const nextIds = new Set(next.map((plugin) => plugin.id));
    const info: PluginInfo[] = [];
    let changed = false;

    for (const [index, plugin] of next.entries()) {
      const previous = this.active.get(plugin.id);
      if (previous !== undefined && previous.plugin.version === plugin.version) {
        info.push(activeInfo(plugin));
        continue;
      }
      changed = true;
      if (previous !== undefined) {
        this.active.delete(plugin.id);
        await previous.scope.dispose();
      }
      const loaded = await this.load(plugin, index);
      if (loaded.ok) {
        this.active.set(plugin.id, loaded.value);
        info.push(activeInfo(plugin));
        continue;
      }
      info.push({ ...activeInfo(plugin), status: "failed", error: loaded.error });
      if (previous === undefined) continue;
      const restored = await this.load(previous.plugin, index);
      if (restored.ok) this.active.set(plugin.id, restored.value);
    }

    for (const [id, entry] of [...this.active].reverse()) {
      if (nextIds.has(id)) continue;
      changed = true;
      this.active.delete(id);
      await entry.scope.dispose();
    }

    if (changed) this.target.rebuildAll();
    this.inventory = info;
    if (changed) await this.target.emit({ type: "plugin_updated", plugins: info });
    return info;
  }

  private async load(
    plugin: LoadedPlugin,
    order: number,
  ): Promise<ResultValue<ActivePlugin, string>> {
    const scope = new PluginScope(plugin.id, (error) => {
      const event: HarnessEvent = {
        type: "handler_error",
        kind: "plugin",
        plugin: plugin.id,
        error: error.message,
      };
      if (error.stack !== undefined) event.stack = error.stack;
      void this.target.emit(event);
    });
    const api = bindSessionApi(this.target, this, plugin, scope, order);
    try {
      await plugin.module.session(api);
      return Result.ok({ plugin, scope });
    } catch (error) {
      await scope.dispose();
      return Result.err(error instanceof Error ? error.message : String(error));
    }
  }
}

function activeInfo(plugin: LoadedPlugin): Extract<PluginInfo, { status: "active" }> {
  const { id, version, source, path } = plugin;
  return path === undefined
    ? { id, version, source, status: "active" }
    : { id, version, source, path, status: "active" };
}

function assertUniqueIds(plugins: readonly LoadedPlugin[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) throw new Error(`duplicate plugin id: ${plugin.id}`);
    seen.add(plugin.id);
  }
}
