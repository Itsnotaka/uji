/**
 * The rail: new chat, search, and customize on top, then a persistent
 * workspace collection. The open workspace carries its sessions, recents
 * below it open on click, and the collection header owns folder opening.
 * Everything you switch between lives in this one column.
 *
 * Every row shares one geometry: a leading icon slot, the label, and one
 * trailing column for shortcuts, timestamps, and hover actions. Labels
 * therefore start and end on the same edges from the top of the rail to the
 * footer.
 *
 * Row edit state lives at the rail root so a directory refetch cannot drop an
 * in-progress rename. A short hover intent warms local thread data and route
 * code independently; navigation itself never waits for either cache.
 *
 * Based on https://github.com/interfaces-lab/honk/blob/main/packages/app/src/desktop-extensions/vertical-sidebar/view.tsx
 */
import * as stylex from "@stylexjs/stylex";
import { Collapsible } from "@base-ui/react/collapsible";
import { useQueryClient } from "@tanstack/react-query";
import { useMatch } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { SessionId, SessionInfo, WorkspaceInfo } from "@uji-ai/core";
import { ConfirmDialog } from "../components/confirm-dialog.tsx";
import { Icon } from "../components/icons.tsx";
import { focus, formatTimeAgo, Kbd, StatusDot } from "../components/ui.tsx";
import { usePaneActions } from "../layout/pane-context.tsx";
import { createSessionDragSource, useSessionDragSnapshot } from "../layout/session-drag.ts";
import {
  keys,
  warmThread,
  useDeleteSession,
  useHostState,
  useRenameSession,
  useSessionPreview,
  useSessionSearch,
  useWorkspaces,
} from "../queries.ts";
import {
  loadRemainingSessions,
  sessionPreviewHasOverflow,
  visibleSessions,
} from "../session-directory.ts";
import { uji } from "../uji.ts";
import { sidebarStyles as styles } from "./sidebar.stylex.ts";
import { useGitHubAccount, type GitHubAccountViewModel } from "./github-account.ts";
import { handleOpenOutcome } from "./open-workspace.tsx";
import { shellActions } from "./shell-state.ts";

interface SessionEdit {
  readonly sessionId: SessionId;
  readonly draft: string;
}

type SessionSearchState =
  | { readonly kind: "closed" }
  | { readonly kind: "open"; readonly query: string };

type SessionDeletionState =
  | { readonly kind: "closed" }
  | { readonly kind: "open"; readonly sessionId: SessionId };

interface WorkspaceDirectoryState {
  readonly workspacePath: string | undefined;
  readonly search: SessionSearchState;
  readonly editing: SessionEdit | undefined;
  readonly expandedSessions: readonly SessionInfo[] | undefined;
  readonly showAllSessions: boolean;
  readonly loadingMoreSessions: boolean;
}

function emptyWorkspaceDirectory(workspacePath: string | undefined): WorkspaceDirectoryState {
  return {
    workspacePath,
    search: { kind: "closed" },
    editing: undefined,
    expandedSessions: undefined,
    showAllSessions: false,
    loadingMoreSessions: false,
  };
}

function sessionTitle(session: SessionInfo): string {
  return session.name ?? session.preview ?? "New session";
}

function isWorking(session: SessionInfo): boolean {
  return session.heads.some((head) => head.run?.kind === "live");
}

export function Sidebar(): ReactElement {
  const panes = usePaneActions();
  const queryClient = useQueryClient();
  const host = useHostState();
  const open = host.data?.workspace;
  const workspacePath = open?.path;
  const workspaces = useWorkspaces();
  const sessionPreview = useSessionPreview(open !== undefined);
  const deleteSession = useDeleteSession();
  const renameSession = useRenameSession();
  // The footer is the one always-visible account surface, so it reads the
  // GitHub state itself. A fixed placeholder keeps its geometry stable while
  // that loads or when the project has no GitHub remote.
  const account = useGitHubAccount(open !== undefined);
  const threadMatch = useMatch({
    from: "/_workspace/session/$sessionId",
    shouldThrow: false,
  });
  const searchID = useId();
  const sessionCollectionID = useId();
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const searchAction = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const [deletion, setDeletion] = useState<SessionDeletionState>({ kind: "closed" });
  const [storedDirectory, setStoredDirectory] = useState<WorkspaceDirectoryState>(() =>
    emptyWorkspaceDirectory(workspacePath),
  );
  const directory =
    storedDirectory.workspacePath === workspacePath
      ? storedDirectory
      : emptyWorkspaceDirectory(workspacePath);
  const { search, editing, expandedSessions, showAllSessions, loadingMoreSessions } = directory;

  const updateDirectory = (
    update: (current: WorkspaceDirectoryState) => WorkspaceDirectoryState,
  ): void => {
    setStoredDirectory((current) =>
      update(
        current.workspacePath === workspacePath ? current : emptyWorkspaceDirectory(workspacePath),
      ),
    );
  };
  const setSearch = (value: SessionSearchState): void => {
    updateDirectory((current) => ({ ...current, search: value }));
  };
  const setEditing = (value: SessionEdit | undefined): void => {
    updateDirectory((current) => ({ ...current, editing: value }));
  };
  const setShowAllSessions = (value: boolean): void => {
    updateDirectory((current) => ({ ...current, showAllSessions: value }));
  };
  const setLoadingMoreSessions = (value: boolean): void => {
    updateDirectory((current) => ({ ...current, loadingMoreSessions: value }));
  };

  const activeSessionId = threadMatch?.params.sessionId;
  const mac = host.data?.platform === "darwin";
  const searchOpen = search.kind === "open";
  const searchQuery = searchOpen ? search.query : "";
  const searching = searchQuery.trim() !== "";
  const searchResults = useSessionSearch(searchQuery, open !== undefined && searching);
  const displayedSessions = searching
    ? (searchResults.data?.items ?? [])
    : sessionPreview.data === undefined
      ? []
      : visibleSessions(sessionPreview.data, expandedSessions, showAllSessions);
  const recents = (workspaces.data ?? []).filter((workspace) => workspace.path !== open?.path);

  const closeSearch = (): void => {
    searchAction.current?.focus();
    setSearch({ kind: "closed" });
  };

  const warmSession = (sessionId: SessionId): void => {
    warmThread(sessionId);
  };

  const toggleRemainingSessions = (): void => {
    if (showAllSessions) {
      setShowAllSessions(false);
      return;
    }
    const preview = sessionPreview.data;
    if (preview === undefined) return;
    if (expandedSessions !== undefined || preview.next === undefined) {
      setShowAllSessions(true);
      return;
    }
    setLoadingMoreSessions(true);
    const requestedWorkspacePath = workspacePath;
    void loadRemainingSessions(preview, (input) => uji.sessions.list(input))
      .then((sessions) => {
        setStoredDirectory((current) =>
          current.workspacePath === requestedWorkspacePath
            ? {
                ...current,
                expandedSessions: sessions,
                showAllSessions: true,
              }
            : current,
        );
      })
      .catch(() => undefined)
      .finally(() => {
        setStoredDirectory((current) =>
          current.workspacePath === requestedWorkspacePath
            ? { ...current, loadingMoreSessions: false }
            : current,
        );
      });
  };

  const forgetWorkspace = (path: string): void => {
    void uji.workspace
      .forget({ path })
      .then(() => queryClient.invalidateQueries({ queryKey: keys.workspaces }));
  };

  const commitRename = (): void => {
    if (editing === undefined) return;
    const name = editing.draft.replaceAll(/\s+/g, " ").trim();
    setEditing(undefined);
    if (name !== "") renameSession.mutate({ sessionId: editing.sessionId, name });
  };

  return (
    <>
      <nav {...stylex.props(styles.rail)} aria-label="Sessions and workspaces">
        <div {...stylex.props(styles.primaryActions)}>
          <button
            type="button"
            {...stylex.props(
              styles.navRow,
              focus.ringInset,
              threadMatch === undefined && !searchOpen && styles.navRowActive,
            )}
            onClick={() => {
              panes.newChat();
            }}
          >
            <span {...stylex.props(styles.navIcon)}>
              <Icon name="plus" size={14} />
            </span>
            <span {...stylex.props(styles.navLabel)}>New chat</span>
            <span {...stylex.props(styles.shortcutSlot)}>
              {host.data !== undefined && <Kbd>{mac ? "⌘N" : "Ctrl+N"}</Kbd>}
            </span>
          </button>

          <button
            type="button"
            ref={searchAction}
            aria-expanded={searchOpen}
            aria-controls={searchOpen ? searchID : undefined}
            disabled={open === undefined}
            {...stylex.props(
              styles.navRow,
              focus.ringInset,
              searchOpen && styles.navRowActive,
              open === undefined && styles.navRowDisabled,
            )}
            onClick={() => {
              if (searchOpen) {
                searchInput.current?.focus();
                return;
              }
              setSessionsOpen(true);
              setSearch({ kind: "open", query: "" });
            }}
          >
            <span {...stylex.props(styles.navIcon)}>
              <Icon name="search" size={14} />
            </span>
            <span {...stylex.props(styles.navLabel)}>Search</span>
          </button>

          <button
            type="button"
            aria-haspopup="dialog"
            {...stylex.props(styles.navRow, focus.ringInset)}
            onClick={(event) =>
              shellActions.openSettings("customize", {
                sessionId: activeSessionId,
                trigger: event.currentTarget,
              })
            }
          >
            <span {...stylex.props(styles.navIcon)}>
              <Icon name="sparkle" size={14} />
            </span>
            <span {...stylex.props(styles.navLabel)}>Customize</span>
          </button>

          {searchOpen && open !== undefined && (
            <div id={searchID} role="search" {...stylex.props(styles.search)}>
              <Icon name="search" size={13} />
              <input
                ref={searchInput}
                autoFocus
                aria-label="Search sessions"
                {...stylex.props(styles.searchInput)}
                placeholder="Search…"
                value={searchQuery}
                onChange={(event) => setSearch({ kind: "open", query: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  if (searchQuery !== "") {
                    setSearch({ kind: "open", query: "" });
                    return;
                  }
                  closeSearch();
                }}
              />
              <button
                type="button"
                aria-label={searchQuery === "" ? "Close search" : "Clear search"}
                title={searchQuery === "" ? "Close search" : "Clear search"}
                {...stylex.props(styles.clearSearch, focus.ringInset)}
                onClick={() => {
                  if (searchQuery === "") {
                    closeSearch();
                    return;
                  }
                  setSearch({ kind: "open", query: "" });
                  searchInput.current?.focus();
                }}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          )}
        </div>

        <div data-uji-scrollport {...stylex.props(styles.scroll)}>
          <section aria-label="Workspaces" {...stylex.props(styles.section)}>
            <div {...stylex.props(styles.sectionHeader)}>
              <span {...stylex.props(styles.sectionLabel)}>Workspaces</span>
              <button
                type="button"
                aria-label="Open folder…"
                title="Open folder…"
                {...stylex.props(styles.action, focus.ringInset)}
                onClick={() => void uji.host.pickWorkspace().then(handleOpenOutcome)}
              >
                <Icon name="folder-open" size={13} />
              </button>
            </div>

            {host.isPending && (
              <div aria-busy="true" {...stylex.props(styles.quiet)}>
                Loading…
              </div>
            )}
            {open !== undefined && (
              <Collapsible.Root
                open={sessionsOpen}
                onOpenChange={setSessionsOpen}
                {...stylex.props(styles.workspaceCollapsible)}
              >
                <Collapsible.Trigger
                  title={open.path}
                  {...stylex.props(styles.row, focus.ringInset)}
                >
                  <span {...stylex.props(styles.rowIcon)}>
                    <span {...stylex.props(styles.workspaceGlyph)}>
                      <span {...stylex.props(styles.workspaceFolder)}>
                        <Icon name={sessionsOpen ? "folder-open" : "folder"} size={14} />
                      </span>
                      <span
                        {...stylex.props(
                          styles.workspaceChevron,
                          sessionsOpen && styles.workspaceChevronOpen,
                        )}
                      >
                        <Icon name="chevron-right" size={13} />
                      </span>
                    </span>
                  </span>
                  <span {...stylex.props(styles.rowTitle)}>{open.name}</span>
                </Collapsible.Trigger>

                <Collapsible.Panel id={sessionCollectionID} {...stylex.props(styles.sessionList)}>
                  {(searching ? searchResults.isPending : sessionPreview.isPending) && (
                    <div aria-busy="true" {...stylex.props(styles.quiet)}>
                      Loading sessions…
                    </div>
                  )}
                  {(searching ? searchResults.data : sessionPreview.data) !== undefined &&
                    displayedSessions.length === 0 && (
                      <div {...stylex.props(styles.quiet)}>
                        {searching ? "No matches" : "No sessions yet"}
                      </div>
                    )}
                  {displayedSessions.map((session) => (
                    <SessionRow
                      key={session.sessionId}
                      session={session}
                      selected={session.sessionId === activeSessionId}
                      editing={editing?.sessionId === session.sessionId ? editing.draft : undefined}
                      onOpen={() => panes.openSession(session.sessionId)}
                      onHover={() => warmSession(session.sessionId)}
                      onDelete={(trigger) => {
                        deleteSession.reset();
                        deleteTrigger.current = trigger;
                        setDeletion({ kind: "open", sessionId: session.sessionId });
                      }}
                      onEditStart={() =>
                        setEditing({
                          sessionId: session.sessionId,
                          draft: sessionTitle(session),
                        })
                      }
                      onEditChange={(draft) => setEditing({ sessionId: session.sessionId, draft })}
                      onEditCommit={commitRename}
                      onEditCancel={() => setEditing(undefined)}
                    />
                  ))}
                  {!searching &&
                    sessionPreview.data !== undefined &&
                    sessionPreviewHasOverflow(sessionPreview.data) && (
                      <button
                        type="button"
                        aria-expanded={showAllSessions}
                        aria-busy={loadingMoreSessions}
                        disabled={loadingMoreSessions}
                        {...stylex.props(styles.showMore, focus.ringInset)}
                        onClick={toggleRemainingSessions}
                      >
                        {showAllSessions ? "Show less" : "Show more…"}
                      </button>
                    )}
                </Collapsible.Panel>
              </Collapsible.Root>
            )}

            {recents.map((workspace) => (
              <WorkspaceRow
                key={workspace.path}
                workspace={workspace}
                onForget={() => forgetWorkspace(workspace.path)}
              />
            ))}
          </section>
        </div>

        <div {...stylex.props(styles.footer)}>
          <div {...stylex.props(styles.footerRow)}>
            <AccountFooterRow
              account={account}
              onOpenSettings={(trigger) => shellActions.openSettings("accounts", { trigger })}
            />
            <button
              type="button"
              aria-label="Settings"
              title="Settings"
              {...stylex.props(styles.footerSettings, focus.ringInset)}
              onClick={(event) =>
                shellActions.openSettings("general", { trigger: event.currentTarget })
              }
            >
              <Icon name="settings" size={14} />
            </button>
          </div>
        </div>
      </nav>
      <ConfirmDialog
        open={deletion.kind === "open"}
        pending={deleteSession.isPending}
        error={deleteSession.isError ? "Couldn't delete this session. Try again." : undefined}
        returnFocusRef={deleteTrigger}
        onOpenChange={(nextOpen) => {
          if (nextOpen) return;
          deleteSession.reset();
          setDeletion({ kind: "closed" });
        }}
        onConfirm={() => {
          if (deletion.kind !== "open") return;
          const { sessionId } = deletion;
          deleteSession.mutate(sessionId, {
            onSuccess: () => {
              setDeletion({ kind: "closed" });
              panes.removeSession(sessionId);
            },
          });
        }}
      />
    </>
  );
}

/**
 * Who is signed in, or the way to sign in. Anything else the account can be
 * (loading, no remote, no CLI, an error) belongs in Settings, so the row
 * holds its height and says nothing.
 */
function AccountFooterRow({
  account,
  onOpenSettings,
}: {
  account: GitHubAccountViewModel;
  onOpenSettings: (trigger: HTMLElement) => void;
}): ReactElement {
  switch (account.kind) {
    case "loading":
    case "no_remote":
    case "cli_missing":
    case "error":
      return <div aria-hidden={true} {...stylex.props(styles.accountPlaceholder)} />;
    case "signed_out":
    case "connecting":
    case "signed_in":
      break;
    default: {
      const _exhaustive: never = account;
      return _exhaustive;
    }
  }

  const avatarUrl = account.kind === "signed_in" ? account.account.avatarUrl : undefined;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      disabled={account.kind === "connecting"}
      {...stylex.props(styles.navRow, styles.accountButton, focus.ringInset)}
      onClick={(event) => onOpenSettings(event.currentTarget)}
    >
      <span {...stylex.props(styles.navIcon, styles.avatarSlot)}>
        {avatarUrl === undefined ? (
          <Icon name="user" size={14} />
        ) : (
          <img alt="" src={avatarUrl} {...stylex.props(styles.avatar)} />
        )}
      </span>
      <span {...stylex.props(styles.navLabel)}>
        {account.kind === "signed_in" ? account.account.login : "GitHub"}
      </span>
    </button>
  );
}

/**
 * A recent project. A div, not a button: it nests the forget control, and
 * buttons cannot nest. The action shows on hover and on focus-within, so
 * keyboard users can reach it too.
 */
function WorkspaceRow({
  workspace,
  onForget,
}: {
  workspace: WorkspaceInfo;
  onForget: () => void;
}): ReactElement {
  const open = (): void => {
    void uji.host.openWorkspace({ path: workspace.path }).then(handleOpenOutcome);
  };
  return (
    <div
      {...stylex.props(styles.row, focus.ringInset)}
      role="link"
      tabIndex={0}
      title={workspace.path}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) open();
      }}
    >
      <span {...stylex.props(styles.rowIcon)}>
        <Icon name="folder" size={14} />
      </span>
      <span {...stylex.props(styles.rowTitle)}>{workspace.name}</span>
      <span {...stylex.props(styles.trailing)}>
        <span {...stylex.props(styles.rowMeta)}>{formatTimeAgo(workspace.lastOpenedAt)}</span>
        <span {...stylex.props(styles.rowActions)}>
          <button
            type="button"
            aria-label="Remove from recents"
            title="Remove from recents"
            {...stylex.props(styles.action, focus.ringInset)}
            onClick={(event) => {
              event.stopPropagation();
              onForget();
            }}
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      </span>
    </div>
  );
}

interface SessionRowProps {
  session: SessionInfo;
  selected: boolean;
  editing: string | undefined;
  onOpen: () => void;
  onHover: () => void;
  onDelete: (trigger: HTMLButtonElement) => void;
  onEditStart: () => void;
  onEditChange: (draft: string) => void;
  onEditCommit: () => void;
  onEditCancel: () => void;
}

function SessionRow({
  session,
  selected,
  editing,
  onOpen,
  onHover,
  onDelete,
  onEditStart,
  onEditChange,
  onEditCommit,
  onEditCancel,
}: SessionRowProps): ReactElement {
  const warmTimer = useRef<number | undefined>(undefined);
  const drag = useSessionDragSnapshot();
  const dragSource = createSessionDragSource(session.sessionId);
  const dragging = drag.kind === "active" && drag.sessionId === session.sessionId;
  const working = isWorking(session);

  const cancelWarm = (): void => {
    if (warmTimer.current === undefined) return;
    window.clearTimeout(warmTimer.current);
    warmTimer.current = undefined;
  };

  const warmSoon = (): void => {
    cancelWarm();
    warmTimer.current = window.setTimeout(() => {
      warmTimer.current = undefined;
      onHover();
    }, 50);
  };

  const warmNow = (): void => {
    cancelWarm();
    onHover();
  };

  useEffect(
    () => () => {
      if (warmTimer.current !== undefined) window.clearTimeout(warmTimer.current);
    },
    [],
  );

  if (editing !== undefined) {
    return (
      <div {...stylex.props(styles.row)}>
        <input
          {...stylex.props(styles.renameInput)}
          value={editing}
          autoFocus
          onChange={(event) => onEditChange(event.target.value)}
          onBlur={onEditCommit}
          onKeyDown={(event) => {
            if (event.key === "Enter") onEditCommit();
            if (event.key === "Escape") onEditCancel();
          }}
        />
      </div>
    );
  }

  return (
    <div
      draggable={dragSource.draggable}
      {...stylex.props(
        styles.row,
        focus.ringInset,
        selected && styles.rowSelected,
        dragging && styles.rowDragging,
      )}
      role="link"
      tabIndex={0}
      onDragStart={dragSource.onDragStart}
      onClickCapture={dragSource.onClickCapture}
      onPointerEnter={() => {
        warmSoon();
      }}
      onPointerLeave={() => {
        cancelWarm();
      }}
      onPointerDown={(event) => {
        dragSource.onPointerDown(event);
        if (event.target === event.currentTarget) warmNow();
      }}
      onFocus={(event) => {
        if (event.target === event.currentTarget) warmNow();
      }}
      onClick={onOpen}
      onKeyDown={(event) => {
        // Only the row itself: Enter on a nested action must not also open.
        if (event.key === "Enter" && event.target === event.currentTarget) onOpen();
      }}
    >
      <span {...stylex.props(styles.rowIcon)}>
        <StatusDot working={working} />
      </span>
      <span {...stylex.props(styles.rowTitle)}>{sessionTitle(session)}</span>
      <span {...stylex.props(styles.trailing)}>
        <span {...stylex.props(styles.rowMeta)}>{formatTimeAgo(session.lastActivityAt)}</span>
        <span data-uji-session-row-actions="" {...stylex.props(styles.rowActions)}>
          <button
            type="button"
            aria-label="Rename"
            title="Rename"
            {...stylex.props(styles.action, focus.ringInset)}
            onClick={(event) => {
              event.stopPropagation();
              onEditStart();
            }}
          >
            <Icon name="pencil" size={12} />
          </button>
          <button
            type="button"
            aria-label="Delete"
            title="Delete"
            {...stylex.props(styles.action, focus.ringInset)}
            onClick={(event) => {
              event.stopPropagation();
              onDelete(event.currentTarget);
            }}
          >
            <Icon name="trash" size={12} />
          </button>
        </span>
      </span>
    </div>
  );
}
