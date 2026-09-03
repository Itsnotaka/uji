// TanStack Query over the SDK verbs. The shell paints first, then local IPC
// fills its data. Watches invalidate settled data; queries never poll except
// for the session directory, which has no cross-session watch verb yet.
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FileChange,
  Seq,
  SessionId,
  SessionInfo,
  SessionSnapshot,
  ThinkingLevel,
  VcsDiff,
} from "@uji-ai/core";
import type { DesktopVcsSnapshot, GitHubProviderState } from "../../shared/ipc.ts";
import { INITIAL_SESSION_FETCH_LIMIT, type SessionPage } from "./session-directory.ts";
import { uji } from "./uji.ts";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      staleTime: Infinity,
      retry: false,
    },
  },
});

export const keys = {
  host: ["host"] as const,
  workspaces: ["workspaces"] as const,
  sessions: ["sessions"] as const,
  sessionPreview: ["sessions", "preview"] as const,
  sessionSearch: (search: string) => ["sessions", "search", search] as const,
  providers: ["providers"] as const,
  models: ["models"] as const,
  modelDefault: ["modelDefault"] as const,
  github: ["github"] as const,
  session: (sessionId: SessionId) => ["session", sessionId] as const,
  snapshot: (sessionId: SessionId) => ["snapshot", sessionId] as const,
  changes: (sessionId: SessionId) => ["changes", sessionId] as const,
  workspaceChanges: ["changes", { kind: "workspace" }] as const,
  vcsSnapshot: ["vcs", "snapshot"] as const,
  vcsDiff: (repositoryId: string, revision: string, path: string) =>
    ["vcs", "diff", repositoryId, revision, path] as const,
};

const SNAPSHOT_WARM_MS = 1_000;

const readHost = () => uji.host.state();
const readWorkspaces = () => uji.workspace.list();
const readSessionPreview = () => uji.sessions.list({ limit: INITIAL_SESSION_FETCH_LIMIT });
const readModels = () => uji.host.models();
const readDefaultModel = () => uji.provider.models.default();
const readSession = async (sessionId: SessionId) => (await uji.sessions.get({ sessionId })) ?? null;
const readSnapshot = async (sessionId: SessionId): Promise<SessionSnapshot> => {
  const snapshot = await uji.sessions.snapshot({ sessionId });
  if (snapshot === undefined) throw new Error(`Unknown session: ${sessionId}`);
  return snapshot;
};

export function useHostState() {
  return useQuery({ queryKey: keys.host, queryFn: readHost });
}

export function useWorkspaces() {
  return useQuery({ queryKey: keys.workspaces, queryFn: readWorkspaces });
}

export function useSessionPreview(enabled = true) {
  return useQuery({
    queryKey: keys.sessionPreview,
    queryFn: readSessionPreview,
    enabled,
    // No directory watch verb yet; a slow tick keeps liveness honest.
    refetchInterval: enabled ? 5_000 : false,
  });
}

export function useSessionSearch(search: string, enabled = true) {
  const normalized = search.trim();
  return useQuery({
    queryKey: keys.sessionSearch(normalized),
    queryFn: () => uji.sessions.list({ search: normalized, limit: 50 }),
    enabled: enabled && normalized !== "",
  });
}

export function useSession(sessionId: SessionId) {
  return useQuery({
    queryKey: keys.session(sessionId),
    queryFn: () => readSession(sessionId),
  });
}

export function useSessionSnapshot(sessionId: SessionId) {
  return useQuery({
    queryKey: keys.snapshot(sessionId),
    queryFn: () => readSnapshot(sessionId),
    // Cached content paints immediately. Old local data refreshes behind the
    // page instead of becoming a navigation gate.
    staleTime: SNAPSHOT_WARM_MS,
    refetchOnMount: true,
  });
}

export function useRunChanges(sessionId: SessionId | undefined, enabled = true) {
  return useQuery<readonly FileChange[]>({
    queryKey: sessionId === undefined ? keys.workspaceChanges : keys.changes(sessionId),
    queryFn: () =>
      sessionId === undefined ? Promise.resolve([]) : uji.runs.changes({ sessionId }),
    enabled: enabled && sessionId !== undefined,
  });
}

export function useVcsSnapshot(enabled: boolean) {
  return useQuery<DesktopVcsSnapshot>({
    queryKey: keys.vcsSnapshot,
    queryFn: () => uji.host.vcs.snapshot(),
    enabled,
    refetchInterval: enabled ? 5_000 : false,
  });
}

export interface VcsDiffIdentity {
  readonly repositoryId: string;
  readonly revision: string;
  readonly path: string;
}

export function vcsDiffQueryKey(identity: VcsDiffIdentity) {
  return keys.vcsDiff(identity.repositoryId, identity.revision, identity.path);
}

export function useVcsDiff(identity: VcsDiffIdentity | undefined, enabled: boolean) {
  return useQuery<VcsDiff | undefined>({
    queryKey:
      identity === undefined
        ? keys.vcsDiff("unavailable", "unavailable", "")
        : vcsDiffQueryKey(identity),
    queryFn: async () => {
      if (identity === undefined) return undefined;
      return (await uji.workspace.vcs.diff({ paths: [identity.path] }))[0];
    },
    enabled: enabled && identity !== undefined,
  });
}

export function refreshVcs(): void {
  void queryClient.invalidateQueries({ queryKey: ["vcs"] });
}

export function useModels() {
  return useQuery({ queryKey: keys.models, queryFn: readModels });
}

/** What a fresh session will run with, for the draft composer's chip. */
export function useDefaultModel() {
  return useQuery({ queryKey: keys.modelDefault, queryFn: readDefaultModel });
}

export function useProviders() {
  return useQuery({ queryKey: keys.providers, queryFn: () => uji.host.providers() });
}

export function useGitHubState(enabled: boolean) {
  return useQuery<GitHubProviderState>({
    queryKey: keys.github,
    queryFn: () => uji.host.github.state(),
    enabled,
  });
}

export async function refreshGitHub(): Promise<GitHubProviderState> {
  const state = await uji.host.github.refresh();
  queryClient.setQueryData(keys.github, state);
  return state;
}

export async function signInGitHub(): Promise<GitHubProviderState> {
  const state = await uji.host.github.signIn();
  queryClient.setQueryData(keys.github, state);
  return state;
}

export async function signOutGitHub(): Promise<GitHubProviderState> {
  const state = await uji.host.github.signOut();
  queryClient.setQueryData(keys.github, state);
  return state;
}

function clearWorkspaceData(): void {
  const workspaceScopes = new Set([
    "sessions",
    "session",
    "snapshot",
    "changes",
    "vcs",
    "github",
    "modelDefault",
  ]);
  queryClient.removeQueries({
    predicate: (query) => workspaceScopes.has(String(query.queryKey[0])),
  });
}

let localLoadVersion = 0;

/** Refill workspace caches after a host transition, committing host state last. */
export async function loadLocalResources(): Promise<void> {
  const version = ++localLoadVersion;
  const [host, workspaces, models] = await Promise.all([
    readHost(),
    readWorkspaces(),
    readModels(),
  ]);

  if (host.workspace === undefined) {
    if (version !== localLoadVersion) return;
    clearWorkspaceData();
    queryClient.setQueryData(keys.workspaces, workspaces);
    queryClient.setQueryData(keys.models, models);
    queryClient.setQueryData(keys.host, host);
    return;
  }

  const [sessionPreview, defaultModel] = await Promise.all([
    readSessionPreview(),
    readDefaultModel(),
  ]);
  if (version !== localLoadVersion) return;

  clearWorkspaceData();
  queryClient.setQueryData(keys.workspaces, workspaces);
  queryClient.setQueryData(keys.models, models);
  queryClient.setQueryData(keys.sessionPreview, sessionPreview);
  queryClient.setQueryData(keys.modelDefault, defaultModel);
  for (const session of sessionPreview.items) {
    queryClient.setQueryData(keys.session(session.sessionId), session);
  }
  // Commit host last. Mounting the workspace shell now finds every local cache filled.
  queryClient.setQueryData(keys.host, host);
}

function cacheSnapshotSession(snapshot: SessionSnapshot): void {
  queryClient.setQueryData(keys.session(snapshot.session.sessionId), snapshot.session);
  queryClient.setQueryData<SessionPage>(keys.sessionPreview, (preview) =>
    preview === undefined
      ? preview
      : {
          ...preview,
          items: preview.items.map((session) =>
            session.sessionId === snapshot.session.sessionId ? snapshot.session : session,
          ),
        },
  );
}

async function fetchThreadSnapshot(
  sessionId: SessionId,
  staleTime: number,
): Promise<SessionSnapshot> {
  const snapshot = await queryClient.fetchQuery({
    queryKey: keys.snapshot(sessionId),
    queryFn: () => readSnapshot(sessionId),
    staleTime,
  });
  cacheSnapshotSession(snapshot);
  return snapshot;
}

/** Force one coherent snapshot after a mutation that needs its result. */
export async function loadThread(sessionId: SessionId): Promise<void> {
  await fetchThreadSnapshot(sessionId, 0);
}

interface ThreadRefreshState {
  dirty: boolean;
  requiredSeq: Seq | undefined;
}

const threadRefreshes = new Map<SessionId, ThreadRefreshState>();

/**
 * Refresh every settled thread field through the same one-call projection.
 * Replay can deliver many durable events together. Keep one local snapshot
 * read in flight and, if another event lands during it, do one follow-up read
 * so the cache cannot finish behind the newest commit.
 */
export function refreshThread(sessionId: SessionId, requiredSeq?: Seq): void {
  const active = threadRefreshes.get(sessionId);
  if (active !== undefined) {
    active.dirty = true;
    if (
      requiredSeq !== undefined &&
      (active.requiredSeq === undefined || requiredSeq > active.requiredSeq)
    ) {
      active.requiredSeq = requiredSeq;
    }
    return;
  }

  const state: ThreadRefreshState = { dirty: false, requiredSeq };
  threadRefreshes.set(sessionId, state);
  const drain = async (): Promise<void> => {
    do {
      state.dirty = false;
      const [, , snapshot] = await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.changes(sessionId), exact: true }),
        queryClient.invalidateQueries({ queryKey: ["vcs"] }),
        fetchThreadSnapshot(sessionId, 0),
      ]);
      if (state.requiredSeq !== undefined && snapshot.seq < state.requiredSeq) state.dirty = true;
    } while (state.dirty);
  };

  void drain()
    .catch(() => undefined)
    .finally(() => {
      if (threadRefreshes.get(sessionId) === state) threadRefreshes.delete(sessionId);
    });
}

/** Refresh old local data on intent without making navigation wait for it. */
export function warmThread(sessionId: SessionId): void {
  void fetchThreadSnapshot(sessionId, SNAPSHOT_WARM_MS).catch(() => undefined);
}

interface ConfigureSessionPatch {
  readonly model?: { readonly provider: string; readonly id: string };
  readonly thinkingLevel?: ThinkingLevel;
}

interface ConfigureRollback {
  readonly session: SessionInfo | null | undefined;
  readonly snapshot: SessionSnapshot | undefined;
  readonly sessionPreview: SessionPage | undefined;
}

function withSessionConfig(session: SessionInfo, patch: ConfigureSessionPatch): SessionInfo {
  return { ...session, config: { ...session.config, ...patch } };
}

/** Configure live run inputs through Query so every session projection moves together. */
export function useConfigureSession(sessionId: SessionId) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ["session", sessionId, "configure"],
    scope: { id: `session-config:${sessionId}` },
    mutationFn: async (patch: ConfigureSessionPatch) => {
      const outcome = await uji.sessions.configure({ sessionId, ...patch });
      if (outcome.kind === "unknown_model") throw new Error("That model is no longer available");
      return outcome;
    },
    onMutate: (patch): ConfigureRollback => {
      const session = client.getQueryData<SessionInfo | null>(keys.session(sessionId));
      const snapshot = client.getQueryData<SessionSnapshot>(keys.snapshot(sessionId));
      const sessionPreview = client.getQueryData<SessionPage>(keys.sessionPreview);

      client.setQueryData<SessionInfo | null>(keys.session(sessionId), (current) =>
        current === null || current === undefined ? current : withSessionConfig(current, patch),
      );
      client.setQueryData<SessionSnapshot>(keys.snapshot(sessionId), (current) =>
        current === undefined
          ? current
          : { ...current, session: withSessionConfig(current.session, patch) },
      );
      client.setQueryData<SessionPage>(keys.sessionPreview, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              items: current.items.map((item) =>
                item.sessionId === sessionId ? withSessionConfig(item, patch) : item,
              ),
            },
      );
      return { session, snapshot, sessionPreview };
    },
    onError: (_error, _patch, rollback) => {
      if (rollback === undefined) return;
      client.setQueryData(keys.session(sessionId), rollback.session);
      client.setQueryData(keys.snapshot(sessionId), rollback.snapshot);
      client.setQueryData(keys.sessionPreview, rollback.sessionPreview);
    },
    onSettled: () => refreshThread(sessionId),
  });
}

/** Delete a session, then refresh every directory view after it settles. */
export function useDeleteSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: SessionId) => uji.sessions.delete({ sessionId }),
    onSettled: () => client.invalidateQueries({ queryKey: keys.sessions }),
  });
}

export function useRenameSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId: SessionId; name: string }) => uji.sessions.rename(input),
    onSettled: () => client.invalidateQueries({ queryKey: keys.sessions }),
  });
}
