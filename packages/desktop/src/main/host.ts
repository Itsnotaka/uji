/**
 * The desktop host over the SDK: one workspace open at a time, composed with
 * `createUji` and volunteered as a runner with `attach()`, so crash resume is
 * core's, not ours. Every renderer request lands in `call` as a verb path plus
 * one input object — the SDK's own wire shape — and `watch` becomes a pump per
 * subscription that pushes events back over IPC.
 *
 * Electron specifics (windows, dialogs, shell) are injected, so this class
 * tests headless under `node --test`.
 */
import { join } from "node:path";
import { clampThinkingLevel } from "@uji-ai/ai";
import type { MutableModels } from "@uji-ai/ai";
import { createUji } from "@uji-ai/core";
import type { Disposer, Uji, WorkspaceInfo } from "@uji-ai/core";
// Hosts name their storage backend through the store entry (design record,
// import rules), so the barrel cut will not touch this file.
import { SqliteSessionRepo } from "@uji-ai/core/store";
import type {
  CallInput,
  CallOutput,
  CallPath,
  HostEvent,
  HostState,
  GitHubProviderState,
  OpenWorkspaceOutcome,
  SdkVerbPath,
  WatchEnvelope,
  WatchStartInput,
} from "../shared/ipc.ts";
import {
  browserLogin,
  createDesktopModels,
  loadPersistedCatalog,
  modelOptions,
  providerStatuses,
  resolveFallbackModel,
} from "./catalog.ts";
import { safeExternalUrl } from "./external-url.ts";
import type { GitHubProvider } from "./github.ts";
import { CALL_INPUT_SCHEMAS, sdkVerb, type SdkVerb } from "./ipc-inputs.ts";
import { resolveDesktopPlugins } from "./plugins.ts";
import { createGitVcs } from "./vcs.ts";
import type { DesktopGitVcs } from "./vcs.ts";
import { createTrustStore, createWorkspaceRegistry } from "./workspaces.ts";

const DEFAULT_THINKING_LEVEL = "medium";

export interface DesktopHostDependencies {
  /** Push a host event to the focused window; dropped when none is open. */
  emitHostEvent(event: HostEvent): void;
  /** Push one watch envelope to the subscribing window. */
  emitWatchEvent(envelope: WatchEnvelope): void;
  openExternal(url: string): void;
  /** Native folder picker; resolves undefined on cancel. */
  pickFolder(): Promise<string | undefined>;
}

interface OpenWorkspace {
  readonly workspace: WorkspaceInfo;
  readonly sdk: Uji;
  readonly store: SqliteSessionRepo;
  readonly detach: Disposer;
  readonly vcs: DesktopGitVcs;
  readonly github: () => Promise<GitHubProvider>;
}

/** Each closure decodes before acquiring the open workspace. */
const SDK_DISPATCH = {
  "sessions.create": sdkVerb(CALL_INPUT_SCHEMAS["sessions.create"], (sdk, input) =>
    sdk.sessions.create(input),
  ),
  "sessions.get": sdkVerb(CALL_INPUT_SCHEMAS["sessions.get"], (sdk, input) =>
    sdk.sessions.get(input),
  ),
  "sessions.snapshot": sdkVerb(CALL_INPUT_SCHEMAS["sessions.snapshot"], (sdk, input) =>
    sdk.sessions.snapshot(input),
  ),
  "sessions.list": sdkVerb(CALL_INPUT_SCHEMAS["sessions.list"], (sdk, input) =>
    sdk.sessions.list(input),
  ),
  "sessions.rename": sdkVerb(CALL_INPUT_SCHEMAS["sessions.rename"], (sdk, input) =>
    sdk.sessions.rename(input),
  ),
  "sessions.delete": sdkVerb(CALL_INPUT_SCHEMAS["sessions.delete"], (sdk, input) =>
    sdk.sessions.delete(input),
  ),
  "sessions.configure": sdkVerb(CALL_INPUT_SCHEMAS["sessions.configure"], (sdk, input) =>
    sdk.sessions.configure(input),
  ),
  "messages.send": sdkVerb(CALL_INPUT_SCHEMAS["messages.send"], (sdk, input) =>
    sdk.messages.send(input),
  ),
  "messages.cancel": sdkVerb(CALL_INPUT_SCHEMAS["messages.cancel"], (sdk, input) =>
    sdk.messages.cancel(input),
  ),
  "messages.redeliver": sdkVerb(CALL_INPUT_SCHEMAS["messages.redeliver"], (sdk, input) =>
    sdk.messages.redeliver(input),
  ),
  "runs.abort": sdkVerb(CALL_INPUT_SCHEMAS["runs.abort"], (sdk, input) => sdk.runs.abort(input)),
  "runs.changes": sdkVerb(CALL_INPUT_SCHEMAS["runs.changes"], (sdk, input) =>
    sdk.runs.changes(input),
  ),
  "workspace.vcs.diff": sdkVerb(CALL_INPUT_SCHEMAS["workspace.vcs.diff"], (sdk, input) =>
    sdk.workspace.vcs.diff(input),
  ),
  "provider.models.default": sdkVerb(CALL_INPUT_SCHEMAS["provider.models.default"], (sdk) =>
    sdk.provider.models.default(),
  ),
  "plugins.list": sdkVerb(CALL_INPUT_SCHEMAS["plugins.list"], (sdk, input) =>
    sdk.plugins.list(input),
  ),
  "plugins.settings.list": sdkVerb(CALL_INPUT_SCHEMAS["plugins.settings.list"], (sdk, input) =>
    sdk.plugins.settings.list(input),
  ),
  "plugins.settings.apply": sdkVerb(CALL_INPUT_SCHEMAS["plugins.settings.apply"], (sdk, input) =>
    sdk.plugins.settings.apply(input),
  ),
  "plugins.resources.list": sdkVerb(CALL_INPUT_SCHEMAS["plugins.resources.list"], (sdk, input) =>
    sdk.plugins.resources.list(input),
  ),
} satisfies Record<Exclude<SdkVerbPath, "workspace.list" | "workspace.forget">, SdkVerb>;

function isSdkVerb(
  path: CallPath,
): path is Exclude<SdkVerbPath, "workspace.list" | "workspace.forget"> {
  // hasOwn, not `in`: the path is renderer input and must never walk the prototype chain.
  return Object.hasOwn(SDK_DISPATCH, path);
}

export class DesktopHost {
  private readonly dependencies: DesktopHostDependencies;
  private readonly trustStore = createTrustStore();
  private readonly registry = createWorkspaceRegistry();
  private modelsPromise: Promise<MutableModels> | undefined;
  private open: OpenWorkspace | undefined;
  private lifecycle: Promise<void> = Promise.resolve();
  private readonly watches = new Map<string, AbortController>();
  private closed = false;

  constructor(dependencies: DesktopHostDependencies) {
    this.dependencies = dependencies;
  }

  /** The one renderer entry point: a verb path and its single input object. */
  call<P extends CallPath>(path: P, input: CallInput<P>): Promise<CallOutput<P>>;
  async call(path: CallPath, input: CallInput<CallPath>): Promise<CallOutput<CallPath>> {
    // The registry answers before any workspace is open, so the rail's recents
    // speak the same verb the SDK defines.
    if (path === "workspace.list") {
      CALL_INPUT_SCHEMAS[path].parse(input);
      return this.registry.list();
    }
    if (path === "workspace.forget") {
      const decoded = CALL_INPUT_SCHEMAS[path].parse(input);
      await this.registry.forget(decoded.path);
      return undefined;
    }
    if (isSdkVerb(path)) {
      const decoded = CALL_INPUT_SCHEMAS[path].parse(input);
      return SDK_DISPATCH[path].invoke(decoded, () => this.requireWorkspace().sdk);
    }
    switch (path) {
      case "host.state":
        CALL_INPUT_SCHEMAS[path].parse(input);
        return this.state();
      case "host.openWorkspace":
        return this.openWorkspace(CALL_INPUT_SCHEMAS[path].parse(input).path);
      case "host.pickWorkspace":
        CALL_INPUT_SCHEMAS[path].parse(input);
        return this.pickWorkspace();
      case "host.trustWorkspace":
        return this.trustWorkspace(CALL_INPUT_SCHEMAS[path].parse(input).path);
      case "host.closeWorkspace":
        CALL_INPUT_SCHEMAS[path].parse(input);
        return this.closeWorkspace();
      case "host.providers":
        CALL_INPUT_SCHEMAS[path].parse(input);
        return providerStatuses(await this.models());
      case "host.login":
        return this.login(CALL_INPUT_SCHEMAS[path].parse(input).provider);
      case "host.logout":
        return this.logout(CALL_INPUT_SCHEMAS[path].parse(input).provider);
      case "host.models":
        CALL_INPUT_SCHEMAS[path].parse(input);
        return modelOptions(await this.models());
      case "host.vcs.snapshot":
        CALL_INPUT_SCHEMAS[path].parse(input);
        return this.requireWorkspace().vcs.snapshot();
      case "host.github.state":
        CALL_INPUT_SCHEMAS[path].parse(input);
        return (await this.requireWorkspace().github()).state();
      case "host.github.refresh":
        CALL_INPUT_SCHEMAS[path].parse(input);
        return (await this.requireWorkspace().github()).state(true);
      case "host.github.signIn":
        CALL_INPUT_SCHEMAS[path].parse(input);
        return this.changeGitHubAuth("signIn");
      case "host.github.signOut":
        CALL_INPUT_SCHEMAS[path].parse(input);
        return this.changeGitHubAuth("signOut");
      case "host.openExternal": {
        const { url } = CALL_INPUT_SCHEMAS[path].parse(input);
        this.dependencies.openExternal(safeExternalUrl(url));
        return undefined;
      }
      default:
        path satisfies never;
        throw new Error("Unknown verb");
    }
  }

  watchStart(input: WatchStartInput): void {
    if (this.watches.has(input.watchId)) throw new Error(`Watch already exists: ${input.watchId}`);
    const { sdk } = this.requireWorkspace();
    const stop = new AbortController();
    this.watches.set(input.watchId, stop);
    void (async () => {
      try {
        const source =
          input.live === true
            ? sdk.watch({ sessionId: input.sessionId, live: true, signal: stop.signal })
            : sdk.watch({
                sessionId: input.sessionId,
                ...(input.afterSeq === undefined ? {} : { afterSeq: input.afterSeq }),
                signal: stop.signal,
              });
        for await (const event of source) {
          if (stop.signal.aborted) return;
          this.dependencies.emitWatchEvent({ watchId: input.watchId, kind: "event", event });
        }
        if (!stop.signal.aborted) {
          this.dependencies.emitWatchEvent({ watchId: input.watchId, kind: "ended" });
        }
      } catch (cause) {
        if (!stop.signal.aborted) {
          this.dependencies.emitWatchEvent({
            watchId: input.watchId,
            kind: "ended",
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      } finally {
        this.watches.delete(input.watchId);
      }
    })();
  }

  watchStop(watchId: string): void {
    this.watches.get(watchId)?.abort();
    this.watches.delete(watchId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.serialize(() => this.teardownOpen());
  }

  private state(): HostState {
    return { workspace: this.open?.workspace, platform: process.platform };
  }

  private requireWorkspace(): OpenWorkspace {
    if (this.open === undefined) throw new Error("No workspace is open");
    return this.open;
  }

  private models(): Promise<MutableModels> {
    this.modelsPromise ??= (async () => {
      const models = createDesktopModels();
      await loadPersistedCatalog(models);
      return models;
    })();
    return this.modelsPromise;
  }

  /** Serialize workspace lifecycle so a double-click cannot compose twice. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async pickWorkspace(): Promise<OpenWorkspaceOutcome> {
    const path = await this.dependencies.pickFolder();
    if (path === undefined) return { kind: "cancelled" };
    return this.openWorkspace(path);
  }

  private trustWorkspace(path: string): Promise<OpenWorkspaceOutcome> {
    return this.serialize(async () => {
      // The renderer's trust dialog confirmed; record the grant, then open.
      await this.trustStore.trust(path);
      return this.composeTrusted(path);
    });
  }

  private openWorkspace(path: string): Promise<OpenWorkspaceOutcome> {
    return this.serialize<OpenWorkspaceOutcome>(async () => {
      const resolution = await this.trustStore.resolve(path).catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Cannot open ${path}: ${message}`);
      });
      if (resolution.kind === "unknown") return { kind: "needs_trust", path: resolution.cwd };
      return this.composeTrusted(resolution.workspace.cwd);
    }).catch((cause): OpenWorkspaceOutcome => ({
      kind: "failed",
      message: cause instanceof Error ? cause.message : String(cause),
    }));
  }

  /** Compose the SDK for a workspace the trust store has already admitted. */
  private async composeTrusted(cwd: string): Promise<OpenWorkspaceOutcome> {
    const workspace = await this.trustStore.require(cwd);
    if (this.open?.workspace.path === workspace.cwd)
      return { kind: "opened", workspace: this.open.workspace };
    await this.teardownOpen();

    const models = await this.models();
    const fallback = await resolveFallbackModel(models);
    const resolved = await resolveDesktopPlugins(workspace, { model: fallback, models });
    for (const failure of resolved.failures) {
      this.dependencies.emitHostEvent({
        kind: "status",
        message: `plugin ${failure.path}: ${failure.error}`,
      });
    }
    const store = new SqliteSessionRepo(join(workspace.cwd, ".uji", "sessions.db"));
    const vcs = createGitVcs(workspace.cwd);
    let githubPromise: Promise<GitHubProvider> | undefined;
    const github = (): Promise<GitHubProvider> => {
      githubPromise ??= import("./github.ts").then((module) =>
        module.createGitHubProvider(workspace.cwd),
      );
      return githubPromise;
    };
    let sdk: Uji | undefined;
    try {
      sdk = await createUji({
        store,
        streamFn: (model, context, streamOptions) =>
          models.streamSimple(model, context, streamOptions),
        models,
        model: fallback,
        thinkingLevel: clampThinkingLevel(fallback, DEFAULT_THINKING_LEVEL),
        plugins: resolved.plugins,
        env: { cwd: workspace.cwd },
        vcs,
        workspaces: this.registry,
      });
      const detach = sdk.attach();
      const info = (await this.registry.list()).find((entry) => entry.path === workspace.cwd) ?? {
        path: workspace.cwd,
        name: workspace.cwd.split("/").at(-1) ?? workspace.cwd,
        lastOpenedAt: Date.now(),
      };
      this.open = { workspace: info, sdk, store, detach, vcs, github };
      this.dependencies.emitHostEvent({ kind: "workspace_opened", workspace: info });
      return { kind: "opened", workspace: info };
    } catch (error) {
      await sdk?.close().catch(() => undefined);
      await store.close().catch(() => undefined);
      throw error;
    }
  }

  private closeWorkspace(): Promise<void> {
    return this.serialize(async () => {
      await this.teardownOpen();
      this.dependencies.emitHostEvent({ kind: "workspace_closed" });
    });
  }

  private async teardownOpen(): Promise<void> {
    const open = this.open;
    if (open === undefined) return;
    this.open = undefined;
    for (const [watchId, stop] of this.watches) {
      stop.abort();
      this.watches.delete(watchId);
    }
    open.detach();
    await open.sdk.close().catch(() => undefined);
    await open.store.close().catch(() => undefined);
  }

  private async login(provider: string): Promise<void> {
    const models = await this.models();
    await browserLogin(
      models,
      provider,
      (url) => this.dependencies.openExternal(url),
      (message) => this.dependencies.emitHostEvent({ kind: "status", message }),
    );
    this.dependencies.emitHostEvent({ kind: "auth_changed" });
  }

  private async logout(provider: string): Promise<void> {
    const models = await this.models();
    await models.logout(provider);
    this.dependencies.emitHostEvent({ kind: "auth_changed" });
  }

  private async changeGitHubAuth(verb: "signIn" | "signOut"): Promise<GitHubProviderState> {
    const state = await (await this.requireWorkspace().github())[verb]();
    this.dependencies.emitHostEvent({ kind: "github_changed" });
    return state;
  }
}
