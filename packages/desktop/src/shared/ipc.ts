/**
 * The wire between the Electron main host and the renderer client.
 *
 * The SDK is already wire-shaped (design record, "The SDK"), so the mapping is
 * mechanical: one verb path per SDK verb, the verb's single input object as the
 * payload, its receipt or outcome union as the response. `watch` is the one
 * transport adaptation: an AsyncIterable cannot cross IPC, so it becomes a
 * start/stop pair around a push channel, cursor semantics unchanged.
 */
import type {
  ApplyOutcome,
  CancelOutcome,
  ConfigureOutcome,
  Disposer,
  EntryId,
  FileChange,
  HeadName,
  ModelInfo,
  Page,
  PluginInfo,
  RedeliverOutcome,
  RunId,
  SendReceipt,
  Seq,
  SessionEvent,
  SessionId,
  SessionInfo,
  SessionSnapshot,
  SettingInfo,
  ThinkingLevel,
  WorkspaceInfo,
  VcsDiff,
  VcsStatus,
} from "@uji-ai/core";
import type { Skill, UserMessage } from "@uji-ai/schema";

export const CALL_CHANNEL = "uji:call";
export const WATCH_START_CHANNEL = "uji:watch-start";
export const WATCH_STOP_CHANNEL = "uji:watch-stop";
export const WATCH_EVENT_CHANNEL = "uji:watch-event";
export const HOST_EVENT_CHANNEL = "uji:host-event";

/** Every SDK verb the bridge carries, one path per verb. */
export const SDK_VERB_PATHS = [
  "sessions.create",
  "sessions.get",
  "sessions.snapshot",
  "sessions.list",
  "sessions.rename",
  "sessions.delete",
  "sessions.configure",
  "messages.send",
  "messages.cancel",
  "messages.redeliver",
  "runs.abort",
  "runs.changes",
  "workspace.list",
  "workspace.forget",
  "workspace.vcs.diff",
  "provider.models.default",
  "plugins.list",
  "plugins.settings.list",
  "plugins.settings.apply",
  "plugins.resources.list",
] as const;

export type SdkVerbPath = (typeof SDK_VERB_PATHS)[number];

/** Host verbs beside the SDK: workspace lifecycle and provider auth. */
export const HOST_VERB_PATHS = [
  "host.state",
  "host.openWorkspace",
  "host.pickWorkspace",
  "host.trustWorkspace",
  "host.closeWorkspace",
  "host.providers",
  "host.login",
  "host.logout",
  "host.models",
  "host.vcs.snapshot",
  "host.github.state",
  "host.github.refresh",
  "host.github.signIn",
  "host.github.signOut",
  "host.openExternal",
] as const;

export type HostVerbPath = (typeof HOST_VERB_PATHS)[number];

export type CallPath = SdkVerbPath | HostVerbPath;

export interface WatchStartInput {
  readonly watchId: string;
  readonly sessionId: SessionId;
  /** Replay from this cursor. Omitted with `live` unset replays from the start. */
  readonly afterSeq?: Seq;
  /** Skip replay and start at the tip; `synced` still arrives first. */
  readonly live?: boolean;
}

export type WatchEnvelope =
  | { readonly watchId: string; readonly kind: "event"; readonly event: SessionEvent }
  | { readonly watchId: string; readonly kind: "ended"; readonly error?: string };

// ---------------------------------------------------------------------------
// host types
// ---------------------------------------------------------------------------

export interface HostState {
  readonly workspace: WorkspaceInfo | undefined;
  readonly platform: NodeJS.Platform;
}

export type OpenWorkspaceOutcome =
  | { kind: "opened"; workspace: WorkspaceInfo }
  | { kind: "needs_trust"; path: string }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

export interface ProviderStatus {
  readonly id: string;
  readonly name: string;
  readonly authenticated: boolean;
  /** e.g. "OAuth" or "API key" when authenticated. */
  readonly detail?: string;
  /** Present when the provider supports browser login. */
  readonly loginLabel?: string;
}

/** Desktop-local repository identity and cache revision. Core remains provider-neutral. */
export type DesktopVcsSnapshot =
  | {
      readonly kind: "not_repository";
      readonly repositoryId: string;
      readonly revision: "not-repository";
      readonly status: VcsStatus;
    }
  | {
      readonly kind: "repository";
      readonly repositoryId: string;
      readonly revision: string;
      readonly status: VcsStatus;
    };

export interface GitHubRepository {
  readonly owner: string;
  readonly name: string;
  readonly remoteName: string;
  /** Canonical public URL. Remote credentials and raw remote URLs never cross IPC. */
  readonly url: string;
}

export interface GitHubAccount {
  readonly login: string;
  readonly name: string | undefined;
  readonly avatarUrl: string | undefined;
}

export interface GitHubPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly draft: boolean;
  readonly headRefName: string;
  readonly baseRefName: string;
}

export type GitHubPullRequestContext =
  | { readonly kind: "none" }
  | { readonly kind: "ready"; readonly pullRequest: GitHubPullRequest }
  | { readonly kind: "error"; readonly message: string };

/** GitHub is optional enrichment; no variant changes local VCS availability. */
export type GitHubProviderState =
  | { readonly kind: "not_github" }
  | { readonly kind: "cli_missing"; readonly repository: GitHubRepository }
  | { readonly kind: "signed_out"; readonly repository: GitHubRepository }
  | {
      readonly kind: "ready";
      readonly repository: GitHubRepository;
      readonly account: GitHubAccount;
      readonly pullRequest: GitHubPullRequestContext;
    }
  | {
      readonly kind: "error";
      readonly repository: GitHubRepository | undefined;
      readonly message: string;
    };

export interface DesktopModelOption {
  readonly key: string;
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly reasoning: boolean;
  readonly thinkingLevels: readonly ThinkingLevel[];
}

export type HostEvent =
  | { kind: "workspace_opened"; workspace: WorkspaceInfo }
  | { kind: "workspace_closed" }
  | { kind: "auth_changed" }
  | { kind: "github_changed" }
  | { kind: "status"; message: string };

// ---------------------------------------------------------------------------
// the renderer-facing bridge, the SDK interfaces verbatim
// ---------------------------------------------------------------------------

/** Brand an id that crossed the wire. The renderer's route params take this path. */
export function asSessionId(value: string): SessionId {
  if (value === "") throw new Error("Invalid session id: empty");
  // SAFETY: the non-empty check establishes the core SessionId brand invariant.
  return value as SessionId;
}

export interface SessionsBridge {
  create(input?: { sessionId?: SessionId; name?: string }): Promise<SessionInfo>;
  get(input: { sessionId: SessionId }): Promise<SessionInfo | undefined>;
  snapshot(input: { sessionId: SessionId; head?: HeadName }): Promise<SessionSnapshot | undefined>;
  list(input?: { search?: string; limit?: number; cursor?: string }): Promise<Page<SessionInfo>>;
  rename(input: { sessionId: SessionId; name: string }): Promise<void>;
  delete(input: { sessionId: SessionId }): Promise<void>;
  configure(input: {
    sessionId: SessionId;
    model?: { provider: string; id: string };
    thinkingLevel?: ThinkingLevel;
  }): Promise<ConfigureOutcome>;
}

export interface MessagesBridge {
  send(input: {
    sessionId: SessionId;
    entryId?: EntryId;
    content: UserMessage["content"];
    delivery?: "steer" | "queue";
    head?: HeadName;
  }): Promise<SendReceipt>;
  cancel(input: { sessionId: SessionId; entryId: EntryId }): Promise<CancelOutcome>;
  redeliver(input: {
    sessionId: SessionId;
    entryId: EntryId;
    delivery: "steer" | "queue";
  }): Promise<RedeliverOutcome>;
}

export interface RunsBridge {
  abort(input: {
    sessionId: SessionId;
    runId?: RunId;
    continue?: boolean;
  }): Promise<{ kind: "requested"; runId: RunId } | { kind: "not_running" }>;
  changes(input: {
    sessionId: SessionId;
    head?: HeadName;
    runId?: RunId;
  }): Promise<readonly FileChange[]>;
}

/**
 * `workspace.list` and `workspace.forget` answer from the registry whether or
 * not a workspace is open, so the no-workspace stage speaks the same verbs as
 * everything else.
 */
export interface WorkspaceBridge {
  list(): Promise<readonly WorkspaceInfo[]>;
  forget(input: { path: string }): Promise<void>;
  vcs: {
    diff(input?: { paths?: readonly string[] }): Promise<readonly VcsDiff[]>;
  };
}

export interface ProviderBridge {
  models: {
    default(): Promise<ModelInfo | undefined>;
  };
}

export interface PluginsBridge {
  list(input: { sessionId: SessionId }): Promise<readonly PluginInfo[]>;
  settings: {
    list(input: { sessionId: SessionId }): Promise<readonly SettingInfo[]>;
    apply(input: { sessionId: SessionId; id: string; choiceId: string }): Promise<ApplyOutcome>;
  };
  resources: { list(input: { sessionId: SessionId }): Promise<readonly Skill[]> };
}

export type WatchInput =
  | { sessionId: SessionId; afterSeq?: Seq }
  | { sessionId: SessionId; live: true };

export interface HostBridge {
  state(): Promise<HostState>;
  /** Open a workspace by path; `needs_trust` sends the renderer to the trust gate. */
  openWorkspace(input: { path: string }): Promise<OpenWorkspaceOutcome>;
  /** Native folder picker, then open. */
  pickWorkspace(): Promise<OpenWorkspaceOutcome>;
  /** Grant trust and open in one step; the renderer's trust dialog confirms first. */
  trustWorkspace(input: { path: string }): Promise<OpenWorkspaceOutcome>;
  closeWorkspace(): Promise<void>;
  providers(): Promise<readonly ProviderStatus[]>;
  login(input: { provider: string }): Promise<void>;
  logout(input: { provider: string }): Promise<void>;
  /** The full catalog with thinking levels, for the model picker. */
  models(): Promise<readonly DesktopModelOption[]>;
  vcs: {
    /** Revision is desktop cache identity; status still comes from the generic VCS backend. */
    snapshot(): Promise<DesktopVcsSnapshot>;
  };
  github: {
    state(): Promise<GitHubProviderState>;
    refresh(): Promise<GitHubProviderState>;
    /** The renderer can call this only from a user gesture. `gh` owns the credentials. */
    signIn(): Promise<GitHubProviderState>;
    signOut(): Promise<GitHubProviderState>;
  };
  openExternal(input: { url: string }): Promise<void>;
  onEvent(listener: (event: HostEvent) => void): Disposer;
}

/** What `window.uji` is: the SDK verbatim, plus watch-over-push and the host. */
export interface UjiBridge {
  readonly sessions: SessionsBridge;
  readonly messages: MessagesBridge;
  readonly runs: RunsBridge;
  readonly workspace: WorkspaceBridge;
  readonly provider: ProviderBridge;
  readonly plugins: PluginsBridge;
  /**
   * `onError` hears a watch that ended with an error (the SDK's `watch`
   * threw, or the start itself was refused), so a failure never dissolves
   * into silence.
   */
  watch(
    input: WatchInput,
    onEvent: (event: SessionEvent) => void,
    onError?: (error: Error) => void,
  ): Disposer;
  readonly host: HostBridge;
}

/** The authoritative path-to-method relationship carried by Electron IPC. */
export interface CallMethodByPath {
  readonly "sessions.create": UjiBridge["sessions"]["create"];
  readonly "sessions.get": UjiBridge["sessions"]["get"];
  readonly "sessions.snapshot": UjiBridge["sessions"]["snapshot"];
  readonly "sessions.list": UjiBridge["sessions"]["list"];
  readonly "sessions.rename": UjiBridge["sessions"]["rename"];
  readonly "sessions.delete": UjiBridge["sessions"]["delete"];
  readonly "sessions.configure": UjiBridge["sessions"]["configure"];
  readonly "messages.send": UjiBridge["messages"]["send"];
  readonly "messages.cancel": UjiBridge["messages"]["cancel"];
  readonly "messages.redeliver": UjiBridge["messages"]["redeliver"];
  readonly "runs.abort": UjiBridge["runs"]["abort"];
  readonly "runs.changes": UjiBridge["runs"]["changes"];
  readonly "workspace.list": UjiBridge["workspace"]["list"];
  readonly "workspace.forget": UjiBridge["workspace"]["forget"];
  readonly "workspace.vcs.diff": UjiBridge["workspace"]["vcs"]["diff"];
  readonly "provider.models.default": UjiBridge["provider"]["models"]["default"];
  readonly "plugins.list": UjiBridge["plugins"]["list"];
  readonly "plugins.settings.list": UjiBridge["plugins"]["settings"]["list"];
  readonly "plugins.settings.apply": UjiBridge["plugins"]["settings"]["apply"];
  readonly "plugins.resources.list": UjiBridge["plugins"]["resources"]["list"];
  readonly "host.state": UjiBridge["host"]["state"];
  readonly "host.openWorkspace": UjiBridge["host"]["openWorkspace"];
  readonly "host.pickWorkspace": UjiBridge["host"]["pickWorkspace"];
  readonly "host.trustWorkspace": UjiBridge["host"]["trustWorkspace"];
  readonly "host.closeWorkspace": UjiBridge["host"]["closeWorkspace"];
  readonly "host.providers": UjiBridge["host"]["providers"];
  readonly "host.login": UjiBridge["host"]["login"];
  readonly "host.logout": UjiBridge["host"]["logout"];
  readonly "host.models": UjiBridge["host"]["models"];
  readonly "host.vcs.snapshot": UjiBridge["host"]["vcs"]["snapshot"];
  readonly "host.github.state": UjiBridge["host"]["github"]["state"];
  readonly "host.github.refresh": UjiBridge["host"]["github"]["refresh"];
  readonly "host.github.signIn": UjiBridge["host"]["github"]["signIn"];
  readonly "host.github.signOut": UjiBridge["host"]["github"]["signOut"];
  readonly "host.openExternal": UjiBridge["host"]["openExternal"];
}

export type CallInput<P extends CallPath> =
  Parameters<CallMethodByPath[P]> extends [] ? undefined : Parameters<CallMethodByPath[P]>[0];

export type CallOutput<P extends CallPath> = Awaited<ReturnType<CallMethodByPath[P]>>;

export type CallRequestFor<P extends CallPath> = P extends CallPath
  ? { readonly path: P; readonly input: CallInput<P> }
  : never;

export type CallRequest = { readonly [P in CallPath]: CallRequestFor<P> }[CallPath];

export type CallReplyFor<P extends CallPath> =
  | { readonly path: P; readonly ok: true; readonly value: CallOutput<P> }
  | { readonly path: P; readonly ok: false; readonly message: string };

export type CallReply = { readonly [P in CallPath]: CallReplyFor<P> }[CallPath];
