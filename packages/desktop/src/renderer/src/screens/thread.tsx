/**
 * The persistent desktop stage. Pane hosts are keyed only by PaneId; selecting
 * another session changes a host's data binding without replacing its DOM or
 * its view-state owner.
 */
import * as stylex from "@stylexjs/stylex";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { CSSProperties, PointerEvent, ReactElement, ReactNode, RefObject } from "react";
import type { SessionId, ThinkingLevel, Turn } from "@uji-ai/core";
import type { DesktopVcsSnapshot } from "../../../shared/ipc.ts";
import { Composer, ComposerFrame } from "../conversation/composer.tsx";
import { ModelPicker } from "../conversation/model-picker.tsx";
import { Prose } from "../conversation/prose.tsx";
import { ReasoningBlock, TurnView } from "../conversation/turn-view.tsx";
import { handleOpenOutcome } from "../chrome/open-workspace.tsx";
import { ConfirmDialog } from "../components/confirm-dialog.tsx";
import { Icon } from "../components/icons.tsx";
import { Menu, MenuItem, MenuSeparator } from "../components/menu.tsx";
import { Button, IconButton } from "../components/ui.tsx";
import {
  usePaneActions,
  usePaneControllerSnapshot,
  usePaneViewStateStore,
} from "../layout/pane-context.tsx";
import {
  activePane,
  BLANK_SELECTION,
  clampSplitRatio,
  orderedPanes,
  paneById,
} from "../layout/pane-layout.ts";
import type {
  DropPlacement,
  PaneId,
  PaneLayout,
  PaneState,
  SplitDirection,
} from "../layout/pane-layout.ts";
import { subscribeSessionDragEvents } from "../layout/session-drag.ts";
import type { SessionDragPoint } from "../layout/session-drag.ts";
import type { BlankViewState, SessionViewState } from "../layout/session-view-state.ts";
import { useSessionLive } from "../live.ts";
import type { LiveSnapshot } from "../live.ts";
import {
  keys,
  loadThread,
  queryClient,
  useDefaultModel,
  useDeleteSession,
  useHostState,
  useModels,
  useRenameSession,
  useSession,
  useSessionSnapshot,
  useVcsSnapshot,
} from "../queries.ts";
import { conversation } from "../theme/schema.stylex.ts";
import { t } from "../theme/vars.stylex.ts";
import { uji } from "../uji.ts";
import type { DesktopModelOption } from "../uji.ts";
import { WORKBENCH_STAGE_PANE_KEY } from "../workbench/controller.ts";
import type { WorkbenchTarget } from "../workbench/controller.ts";
import { Workbench } from "../workbench/workbench.tsx";

const styles = stylex.create({
  stage: {
    display: "flex",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  },
  panes: {
    position: "relative",
    display: "flex",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  },
  splitRight: { flexDirection: "row" },
  splitDown: { flexDirection: "column" },
  pane: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: t.bgBase,
  },
  paneSingle: { flex: 1 },
  paneLeading: { flexGrow: 0, flexShrink: 0, flexBasis: "var(--uji-pane-basis, 50%)" },
  paneTrailing: { flex: 1 },
  paneActive: { boxShadow: `inset 0 0 0 1px ${t.strokeFocused}` },
  screen: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    height: conversation.headerHeight,
    paddingInline: 12,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: t.strokeTertiary,
    flexShrink: 0,
  },
  title: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: t.fontBase,
    fontWeight: 600,
    color: t.textPrimary,
  },
  headerActions: { display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 },
  renameInput: {
    flex: 1,
    minWidth: 0,
    height: 24,
    paddingInline: 6,
    borderRadius: t.radiusSm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: t.borderAccent,
    backgroundColor: t.bgElevated,
    color: t.textPrimary,
    fontSize: t.fontBase,
    fontWeight: 600,
    outline: "none",
  },
  body: { position: "relative", display: "flex", flex: 1, minHeight: 0, minWidth: 0 },
  conversation: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 },
  scroll: { flex: 1, minHeight: 0, overflowY: "auto" },
  transcript: {
    display: "flex",
    flexDirection: "column",
    gap: conversation.turnGap,
    width: `min(${conversation.measure}, 100%)`,
    marginInline: "auto",
    paddingInline: conversation.gutter,
    paddingTop: 22,
    paddingBottom: 18,
  },
  banner: {
    width: "fit-content",
    padding: "5px 10px",
    borderRadius: t.radiusLg,
    backgroundColor: t.fillWarningSubtle,
    color: t.textWarning,
    fontSize: t.fontSm,
  },
  loading: { color: t.textTertiary, fontSize: t.fontSm },
  working: {
    display: "flex",
    gap: 4,
    width: "max-content",
    padding: "10px 12px",
    borderRadius: 14,
    backgroundColor: t.fillBubbleAgent,
  },
  workingDot: {
    width: 5,
    height: 5,
    borderRadius: t.radiusFull,
    backgroundColor: t.textTertiary,
    animationName: stylex.keyframes({
      "0%": { opacity: 0.3 },
      "50%": { opacity: 1 },
      "100%": { opacity: 0.3 },
    }),
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none", opacity: 0.65 },
  },
  workingDot2: { animationDelay: "0.2s" },
  workingDot3: { animationDelay: "0.4s" },
  blank: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    minHeight: 0,
    paddingBottom: 80,
  },
  blankColumn: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    width: "min(620px, calc(100% - 48px))",
  },
  greeting: { paddingInlineStart: 4, color: t.textTertiary, fontSize: t.fontLg },
  workspaceContext: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    minWidth: 0,
    paddingInline: 4,
    color: t.textSecondary,
    fontSize: t.fontSm,
  },
  workspaceContextItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    minWidth: 0,
  },
  workspaceContextPath: { flex: 1 },
  workspaceContextText: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  blankHint: { paddingInlineStart: 4, color: t.textTertiary, fontSize: t.fontBase },
  blankActions: { display: "flex", gap: 8, paddingInlineStart: 4 },
  error: { paddingInlineStart: 4, color: t.textDanger, fontSize: t.fontBase },
  sash: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    zIndex: 4,
    touchAction: "none",
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
    outlineColor: t.strokeFocused,
    outlineOffset: -2,
  },
  sashRight: { width: 9, cursor: "col-resize" },
  sashDown: { height: 9, cursor: "row-resize" },
  sashLine: { backgroundColor: t.strokeTertiary, pointerEvents: "none" },
  sashLineRight: { width: 1, height: "100%" },
  sashLineDown: { width: "100%", height: 1 },
  dropPreviewLayer: {
    position: "absolute",
    inset: 2,
    zIndex: 1000,
    overflow: "hidden",
    pointerEvents: "none",
  },
  dropPreview: {
    position: "absolute",
    borderRadius: t.radiusSm,
    backgroundColor: `color-mix(in srgb, ${t.fillAccent} 28%, transparent)`,
    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${t.fillAccent} 62%, transparent)`,
    pointerEvents: "none",
    transitionProperty: "top, left, width, height, opacity",
    transitionDuration: "100ms",
    transitionTimingFunction: "ease",
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0s" },
  },
});

const EMPTY_TURNS: readonly Turn[] = [];

function repositoryBranch(snapshot: DesktopVcsSnapshot | undefined): string | undefined {
  if (snapshot === undefined) return undefined;
  switch (snapshot.kind) {
    case "not_repository":
      return undefined;
    case "repository":
      return snapshot.status.branch;
    default: {
      const _exhaustive: never = snapshot;
      return _exhaustive;
    }
  }
}

function settledEntryIds(turns: readonly Turn[]): Set<string> {
  const ids = new Set<string>();
  for (const turn of turns) {
    if (turn.kind !== "turn") continue;
    for (const part of turn.parts) {
      if (part.kind === "assistant" || part.kind === "thinking" || part.kind === "user") {
        ids.add(part.entryId);
      }
    }
  }
  return ids;
}

function LiveTurn({
  live,
  settled,
  working,
}: {
  live: LiveSnapshot;
  settled: Set<string>;
  working: boolean;
}): ReactElement | null {
  const parts = live.order.filter((ref) => ref.kind !== "tool" && !settled.has(ref.entryId));
  const hasStreaming = parts.length > 0;
  const busy = live.runState !== "idle" || working;
  if (!hasStreaming && !busy) return null;

  return (
    <div>
      {parts.map((ref) => {
        if (ref.kind === "thinking") {
          const text = live.thinking.get(`${ref.entryId}:${String(ref.contentIndex)}`) ?? "";
          return (
            <ReasoningBlock
              key={`thinking:${ref.entryId}:${String(ref.contentIndex)}`}
              text={text}
              streaming
            />
          );
        }
        if (ref.kind === "text") {
          const text = live.text.get(`${ref.entryId}:${String(ref.contentIndex)}`) ?? "";
          return text === "" ? null : (
            <Prose key={`text:${ref.entryId}:${String(ref.contentIndex)}`} markdown={text} />
          );
        }
        return null;
      })}
      {!hasStreaming && busy && (
        <div {...stylex.props(styles.working)}>
          <span {...stylex.props(styles.workingDot)} />
          <span {...stylex.props(styles.workingDot, styles.workingDot2)} />
          <span {...stylex.props(styles.workingDot, styles.workingDot3)} />
        </div>
      )}
    </div>
  );
}

type SessionViewUpdate = (current: SessionViewState) => SessionViewState;
type BlankViewUpdate = (current: BlankViewState) => BlankViewState;
type SessionDeletionState =
  | { readonly kind: "closed" }
  | { readonly kind: "open"; readonly sessionId: SessionId };

function useSessionViewBinding(
  sessionId: SessionId,
  paneId: PaneId,
): readonly [SessionViewState, (update: SessionViewUpdate) => void] {
  const store = usePaneViewStateStore();
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const state = store.readSession(sessionId, paneId);
  const update = useCallback(
    (change: SessionViewUpdate): void => {
      store.updateSession(sessionId, paneId, change);
      redraw();
    },
    [paneId, sessionId, store],
  );
  return [state, update];
}

function useBlankViewBinding(
  paneId: PaneId,
): readonly [BlankViewState, (update: BlankViewUpdate) => void] {
  const store = usePaneViewStateStore();
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const state = store.readBlank(paneId);
  const update = useCallback(
    (change: BlankViewUpdate): void => {
      store.writeBlank(paneId, change(store.readBlank(paneId)));
      redraw();
    },
    [paneId, store],
  );
  return [state, update];
}

function PaneHeader({
  paneId,
  title,
  sessionItems,
  menuTriggerRef,
}: {
  paneId: PaneId;
  title: ReactNode;
  /** Session-only entries appended below the layout entries. */
  sessionItems?: ReactNode;
  menuTriggerRef?: RefObject<HTMLButtonElement | null>;
}): ReactElement {
  const actions = usePaneActions();
  const { layout } = usePaneControllerSnapshot();
  const host = useHostState();
  const canSplit = layout.kind === "single";
  const mac = host.data?.platform === "darwin";
  const modifier = mac ? "⌘" : "Ctrl+";
  const shift = mac ? "⇧" : "Shift+";

  return (
    <div {...stylex.props(styles.header)}>
      <span {...stylex.props(styles.title)}>{title}</span>
      <span {...stylex.props(styles.headerActions)}>
        <Menu
          label="Pane actions"
          align="end"
          trigger={<IconButton ref={menuTriggerRef} icon="more" label="Pane actions" />}
        >
          <MenuItem
            icon="split-down"
            meta={`${shift}${modifier}D`}
            disabled={!canSplit}
            onSelect={() => actions.split("down")}
          >
            Split Down
          </MenuItem>
          <MenuItem
            icon="split-right"
            meta={`${modifier}D`}
            disabled={!canSplit}
            onSelect={() => actions.split("right")}
          >
            Split Right
          </MenuItem>
          <MenuItem icon="x" onSelect={() => actions.close(paneId)}>
            Close Panel
          </MenuItem>
          {sessionItems}
        </Menu>
      </span>
    </div>
  );
}

function SessionConversation({
  paneId,
  sessionId,
  inputRef,
}: {
  paneId: PaneId;
  sessionId: SessionId;
  inputRef: (element: HTMLTextAreaElement | null) => void;
}): ReactElement {
  const host = useHostState();
  const panes = usePaneActions();
  const session = useSession(sessionId);
  const renameSession = useRenameSession();
  const deleteSession = useDeleteSession();
  const [draftName, setDraftName] = useState<string | undefined>();
  const [deletion, setDeletion] = useState<SessionDeletionState>({ kind: "closed" });
  const paneMenuTrigger = useRef<HTMLButtonElement>(null);
  const snapshot = useSessionSnapshot(sessionId);
  const turns = snapshot.data?.transcript ?? EMPTY_TURNS;
  const settled = useMemo(() => settledEntryIds(turns), [turns]);
  const live = useSessionLive(sessionId, snapshot.data?.seq, settled);
  const viewStore = usePaneViewStateStore();
  const [viewState, updateViewState] = useSessionViewBinding(sessionId, paneId);
  const working =
    live.runState !== "idle" ||
    snapshot.data?.session.heads.some((head) => head.run?.kind === "live") === true;
  const cwd = host.data?.workspace?.path;
  const scrollRef = useRef<HTMLDivElement>(null);
  const ready = snapshot.data !== undefined;

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const restored = viewStore.readSession(sessionId, paneId).scroll;
    element.scrollTop = restored.bottomPinned ? element.scrollHeight : restored.top;
  }, [paneId, ready, sessionId, viewStore]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null && viewStore.readSession(sessionId, paneId).scroll.bottomPinned) {
      element.scrollTop = element.scrollHeight;
    }
  });

  const title =
    snapshot.data?.session.name ??
    snapshot.data?.session.preview ??
    session.data?.name ??
    session.data?.preview ??
    "New session";
  const commitRename = (): void => {
    if (draftName === undefined) return;
    const name = draftName.replaceAll(/\s+/g, " ").trim();
    setDraftName(undefined);
    if (name !== "" && name !== title) renameSession.mutate({ sessionId, name });
  };

  const requestDelete = (): void => {
    deleteSession.reset();
    setDeletion({ kind: "open", sessionId });
  };

  return (
    <div {...stylex.props(styles.screen)} aria-busy={snapshot.isLoading}>
      <PaneHeader
        paneId={paneId}
        menuTriggerRef={paneMenuTrigger}
        title={
          draftName === undefined ? (
            title
          ) : (
            <input
              aria-label="Session name"
              autoFocus
              {...stylex.props(styles.renameInput)}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitRename();
                if (event.key === "Escape") setDraftName(undefined);
              }}
            />
          )
        }
        sessionItems={
          <>
            <MenuSeparator />
            <MenuItem icon="pencil" onSelect={() => setDraftName(title)}>
              Rename
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon="trash" danger onSelect={requestDelete}>
              Delete
            </MenuItem>
          </>
        }
      />

      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.conversation)}>
          <div
            ref={scrollRef}
            data-uji-scrollport="balanced"
            {...stylex.props(styles.scroll)}
            onScroll={(event) => {
              const element = event.currentTarget;
              const bottomPinned =
                element.scrollHeight - element.scrollTop - element.clientHeight < 60;
              viewStore.updateSession(sessionId, paneId, (current) => ({
                ...current,
                scroll: { top: element.scrollTop, bottomPinned },
              }));
            }}
          >
            <div {...stylex.props(styles.transcript)}>
              {snapshot.isLoading && turns.length === 0 && (
                <div {...stylex.props(styles.loading)}>Loading conversation…</div>
              )}
              {snapshot.isError && (
                <div {...stylex.props(styles.banner)}>This conversation could not be loaded.</div>
              )}
              {turns.map((turn, index) => (
                <TurnView
                  key={turn.kind === "turn" ? turn.id : `${turn.kind}:${String(index)}`}
                  turn={turn}
                  liveTools={live.tools}
                  cwd={cwd}
                />
              ))}
              {live.runState === "retrying" && live.retry !== undefined && (
                <div {...stylex.props(styles.banner)}>
                  Retrying ({String(live.retry.attempt)}/{String(live.retry.maxAttempts)}):{" "}
                  {live.retry.message}
                </div>
              )}
              {live.runState === "compacting" && (
                <div {...stylex.props(styles.banner)}>Compacting context…</div>
              )}
              <LiveTurn live={live} settled={settled} working={working} />
            </div>
          </div>

          <Composer
            sessionId={sessionId}
            working={working}
            pending={snapshot.data?.pending ?? []}
            disabled={snapshot.data === undefined || snapshot.isError}
            viewState={viewState.composer}
            onViewStateChange={(updateComposer) =>
              updateViewState((current) => ({
                ...current,
                composer: updateComposer(current.composer),
              }))
            }
            inputRef={inputRef}
            autoFocus={false}
          />
        </div>
      </div>
      <ConfirmDialog
        open={deletion.kind === "open"}
        pending={deleteSession.isPending}
        error={deleteSession.isError ? "Couldn't delete this session. Try again." : undefined}
        returnFocusRef={paneMenuTrigger}
        onOpenChange={(nextOpen) => {
          if (nextOpen) return;
          deleteSession.reset();
          setDeletion({ kind: "closed" });
        }}
        onConfirm={() => {
          if (deletion.kind !== "open") return;
          const { sessionId: targetSessionId } = deletion;
          deleteSession.mutate(targetSessionId, {
            onSuccess: () => {
              setDeletion({ kind: "closed" });
              panes.removeSession(targetSessionId);
            },
          });
        }}
      />
    </div>
  );
}

function BlankConversation({
  paneId,
  inputRef,
}: {
  paneId: PaneId;
  inputRef: (element: HTMLTextAreaElement | null) => void;
}): ReactElement {
  const host = useHostState();
  const { layout } = usePaneControllerSnapshot();
  const workspace = host.data?.workspace;
  const vcs = useVcsSnapshot(workspace !== undefined);
  const models = useModels();
  const fallback = useDefaultModel();
  const actions = usePaneActions();
  const [viewState, updateViewState] = useBlankViewBinding(paneId);
  const [picked, setPicked] = useState<DesktopModelOption | undefined>();
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const branch = repositoryBranch(vcs.data);
  const options = models.data ?? [];
  const current =
    picked ??
    options.find(
      (option) => option.provider === fallback.data?.provider && option.id === fallback.data.id,
    );

  const start = (): void => {
    const content = viewState.composer.draft.trim();
    if (content === "" || sending) return;
    setSending(true);
    setError(undefined);
    void (async () => {
      const session = await uji.sessions.create();
      if (picked !== undefined || thinkingLevel !== undefined) {
        await uji.sessions.configure({
          sessionId: session.sessionId,
          ...(picked === undefined ? {} : { model: { provider: picked.provider, id: picked.id } }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        });
      }
      await uji.messages.send({ sessionId: session.sessionId, content });
      updateViewState(() => ({
        composer: { draft: "", selectionStart: 0, selectionEnd: 0, focused: false },
      }));
      void queryClient.invalidateQueries({ queryKey: keys.sessions });
      void loadThread(session.sessionId).catch(() => undefined);
      actions.openSessionInPane(paneId, session.sessionId);
    })().catch((cause: unknown) => {
      setSending(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  // No workspace yet: the stage stays mounted and asks for a folder instead of
  // swapping to a separate home screen. Recents live in the rail.
  if (host.data !== undefined && workspace === undefined) {
    return (
      <div {...stylex.props(styles.screen)}>
        {layout.kind === "split" && <PaneHeader paneId={paneId} title="New chat" />}
        <div {...stylex.props(styles.blank)}>
          <div {...stylex.props(styles.blankColumn)}>
            <div {...stylex.props(styles.greeting)}>Open a folder to start.</div>
            <div {...stylex.props(styles.blankHint)}>
              Uji works inside one project at a time. Recent projects are in the sidebar.
            </div>
            <div {...stylex.props(styles.blankActions)}>
              <Button
                variant="primary"
                icon="folder-open"
                onClick={() => void uji.host.pickWorkspace().then(handleOpenOutcome)}
              >
                Open folder…
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div {...stylex.props(styles.screen)}>
      {layout.kind === "split" && <PaneHeader paneId={paneId} title="New chat" />}
      <div {...stylex.props(styles.blank)}>
        <div {...stylex.props(styles.blankColumn)}>
          {workspace !== undefined && (
            <div {...stylex.props(styles.workspaceContext)}>
              <span
                title={workspace.path}
                {...stylex.props(styles.workspaceContextItem, styles.workspaceContextPath)}
              >
                <Icon name="folder" size={13} />
                <span {...stylex.props(styles.workspaceContextText)}>{workspace.path}</span>
              </span>
              {branch !== undefined && (
                <span title={branch} {...stylex.props(styles.workspaceContextItem)}>
                  <Icon name="git-branch" size={13} />
                  <span {...stylex.props(styles.workspaceContextText)}>{branch}</span>
                </span>
              )}
            </div>
          )}
          <ComposerFrame
            value={viewState.composer.draft}
            onChange={(draft) =>
              updateViewState((currentState) => ({
                composer: {
                  ...currentState.composer,
                  draft,
                  selectionStart: Math.min(currentState.composer.selectionStart, draft.length),
                  selectionEnd: Math.min(currentState.composer.selectionEnd, draft.length),
                },
              }))
            }
            onSubmit={start}
            placeholder="Message Uji…"
            disabled={sending}
            inputRef={inputRef}
            selectionStart={viewState.composer.selectionStart}
            selectionEnd={viewState.composer.selectionEnd}
            onSelectionChange={(selectionStart, selectionEnd) =>
              updateViewState((currentState) => ({
                composer: { ...currentState.composer, selectionStart, selectionEnd },
              }))
            }
            onFocusChange={(focused) =>
              updateViewState((currentState) => ({
                composer: { ...currentState.composer, focused },
              }))
            }
            model={
              <ModelPicker
                current={current}
                options={options}
                thinkingLevel={thinkingLevel}
                onModelSelect={(option, level) => {
                  setPicked(option);
                  setThinkingLevel(level);
                }}
                onThinkingLevel={setThinkingLevel}
              />
            }
          />
          {error !== undefined && <div {...stylex.props(styles.error)}>{error}</div>}
        </div>
      </div>
    </div>
  );
}

interface SessionDropTarget {
  readonly paneId: PaneId;
  readonly placement: DropPlacement;
}

/** Cursor's pane target uses the nearest normalized edge and a central 25% zone. */
function placementAt(
  element: HTMLElement,
  point: SessionDragPoint,
  allowCenter: boolean,
): DropPlacement | undefined {
  const bounds = element.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;
  const x = (point.clientX - bounds.left) / bounds.width;
  const y = (point.clientY - bounds.top) / bounds.height;
  const distances: readonly (readonly [Exclude<DropPlacement, "center">, number])[] = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  const [placement, distance] = distances.reduce((best, next) => (next[1] < best[1] ? next : best));
  return allowCenter && distance > 0.375 ? "center" : placement;
}

function paneIdFromAttribute(value: string | null): PaneId | undefined {
  switch (value) {
    case "primary":
    case "secondary":
      return value;
    default:
      return undefined;
  }
}

function sessionDropTargetAt(
  container: HTMLDivElement,
  layout: PaneLayout,
  sessionId: SessionId,
  point: SessionDragPoint,
): SessionDropTarget | undefined {
  const hit = container.ownerDocument.elementFromPoint(point.clientX, point.clientY);
  const paneElement = hit?.closest<HTMLElement>("[data-uji-pane-id]");
  if (paneElement === undefined || paneElement === null || !container.contains(paneElement)) {
    return undefined;
  }
  const paneId = paneIdFromAttribute(paneElement.getAttribute("data-uji-pane-id"));
  if (paneId === undefined) return undefined;
  const pane = paneById(layout, paneId);
  if (
    pane === undefined ||
    (pane.selection.kind === "session" && pane.selection.sessionId === sessionId)
  ) {
    return undefined;
  }
  const placement = placementAt(paneElement, point, layout.kind === "split");
  return placement === undefined ? undefined : { paneId, placement };
}

function panePreviewRect(
  layout: Extract<PaneLayout, { kind: "split" }>,
  paneId: PaneId,
): CSSProperties {
  const leading = layout.order[0] === paneId;
  const leadingSize = `${String(layout.ratio * 100)}%`;
  const trailingSize = `${String((1 - layout.ratio) * 100)}%`;
  if (layout.direction === "right") {
    return {
      top: 0,
      left: leading ? 0 : leadingSize,
      width: leading ? leadingSize : trailingSize,
      height: "100%",
    };
  }
  return {
    top: leading ? 0 : leadingSize,
    left: 0,
    width: "100%",
    height: leading ? leadingSize : trailingSize,
  };
}

function dropPreviewRect(layout: PaneLayout, target: SessionDropTarget): CSSProperties {
  const leadingSize = layout.kind === "single" ? "50%" : `${String(layout.ratio * 100)}%`;
  const trailingSize = layout.kind === "single" ? "50%" : `${String((1 - layout.ratio) * 100)}%`;
  switch (target.placement) {
    case "top":
      return { top: 0, left: 0, width: "100%", height: leadingSize };
    case "bottom":
      return { top: leadingSize, left: 0, width: "100%", height: trailingSize };
    case "left":
      return { top: 0, left: 0, width: leadingSize, height: "100%" };
    case "right":
      return { top: 0, left: leadingSize, width: trailingSize, height: "100%" };
    case "center":
      return layout.kind === "single"
        ? { top: 0, left: 0, width: "100%", height: "100%" }
        : panePreviewRect(layout, target.paneId);
    default: {
      const _exhaustive: never = target.placement;
      return _exhaustive;
    }
  }
}

function DropPreview({
  layout,
  target,
}: {
  readonly layout: PaneLayout;
  readonly target: SessionDropTarget;
}): ReactElement {
  return (
    <div aria-hidden="true" {...stylex.props(styles.dropPreviewLayer)}>
      <div
        data-uji-drop-preview=""
        {...stylex.props(styles.dropPreview)}
        style={dropPreviewRect(layout, target)}
      />
    </div>
  );
}

function PaneHost({
  pane,
  active,
  position,
}: {
  pane: PaneState;
  active: boolean;
  position: "single" | "leading" | "trailing";
}): ReactElement {
  const actions = usePaneActions();
  const { focusRequest } = usePaneControllerSnapshot();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachInput = useCallback((element: HTMLTextAreaElement | null) => {
    inputRef.current = element;
  }, []);

  useLayoutEffect(() => {
    if (focusRequest.paneId === pane.id) inputRef.current?.focus();
  }, [focusRequest.paneId, focusRequest.revision, pane.id]);

  return (
    <section
      aria-label={`${active ? "Active " : ""}chat pane`}
      data-uji-pane-id={pane.id}
      {...stylex.props(
        styles.pane,
        position === "single" && styles.paneSingle,
        position === "leading" && styles.paneLeading,
        position === "trailing" && styles.paneTrailing,
        active && position !== "single" && styles.paneActive,
      )}
      onPointerDown={() => actions.focus(pane.id)}
      onFocusCapture={() => actions.focus(pane.id)}
    >
      {pane.selection.kind === "session" ? (
        <SessionConversation
          paneId={pane.id}
          sessionId={pane.selection.sessionId}
          inputRef={attachInput}
        />
      ) : (
        <BlankConversation paneId={pane.id} inputRef={attachInput} />
      )}
    </section>
  );
}

function SplitSash({
  direction,
  ratio,
  containerRef,
}: {
  direction: SplitDirection;
  ratio: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
}): ReactElement {
  const actions = usePaneActions();
  const dragRatio = useRef<number | undefined>(undefined);

  const ratioFromPointer = (event: PointerEvent<HTMLDivElement>): number | undefined => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const bounds = container.getBoundingClientRect();
    const size = direction === "right" ? bounds.width : bounds.height;
    if (size <= 0) return undefined;
    const pixels = direction === "right" ? event.clientX - bounds.left : event.clientY - bounds.top;
    return clampSplitRatio(pixels / size);
  };

  const applyRatio = (nextRatio: number): void => {
    containerRef.current?.style.setProperty("--uji-pane-basis", `${String(nextRatio * 100)}%`);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="Resize chat panes"
      aria-orientation={direction === "right" ? "vertical" : "horizontal"}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(ratio * 100)}
      {...stylex.props(styles.sash, direction === "right" ? styles.sashRight : styles.sashDown)}
      onPointerDown={(event) => {
        const nextRatio = ratioFromPointer(event);
        if (nextRatio === undefined) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRatio.current = nextRatio;
        applyRatio(nextRatio);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const nextRatio = ratioFromPointer(event);
        if (nextRatio === undefined) return;
        dragRatio.current = nextRatio;
        applyRatio(nextRatio);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        const completed = dragRatio.current;
        dragRatio.current = undefined;
        if (completed !== undefined) actions.resize(completed);
      }}
      onPointerCancel={() => {
        dragRatio.current = undefined;
        applyRatio(ratio);
      }}
      onKeyDown={(event) => {
        const previous = direction === "right" ? "ArrowLeft" : "ArrowUp";
        const next = direction === "right" ? "ArrowRight" : "ArrowDown";
        if (event.key !== previous && event.key !== next) return;
        event.preventDefault();
        const step = event.shiftKey ? 0.1 : 0.02;
        actions.resize(ratio + (event.key === previous ? -step : step));
      }}
    >
      <span
        {...stylex.props(
          styles.sashLine,
          direction === "right" ? styles.sashLineRight : styles.sashLineDown,
        )}
      />
    </div>
  );
}

export function ThreadScreen({
  routeSessionId,
}: {
  routeSessionId: SessionId | undefined;
}): ReactElement {
  const { layout } = usePaneControllerSnapshot();
  const actions = usePaneActions();
  const host = useHostState();
  const containerRef = useRef<HTMLDivElement>(null);
  const [draggedSession, setDraggedSession] = useState<SessionId | undefined>();
  const [dropTarget, setDropTarget] = useState<SessionDropTarget | undefined>();
  const panes = orderedPanes(layout);
  const leading = panes[0] ?? activePane(layout);
  const trailing = layout.kind === "split" ? (panes[1] ?? layout.secondary) : undefined;
  const activeSelection = activePane(layout).selection;
  const workspacePath = host.data?.workspace?.path;
  const workbenchTarget: WorkbenchTarget | undefined =
    activeSelection.kind === "session"
      ? { kind: "session", sessionId: activeSelection.sessionId }
      : workspacePath === undefined
        ? undefined
        : { kind: "workspace", workspacePath };

  useLayoutEffect(() => {
    actions.syncRoute(
      routeSessionId === undefined
        ? BLANK_SELECTION
        : { kind: "session", sessionId: routeSessionId },
    );
  }, [actions, routeSessionId]);

  useLayoutEffect(() => {
    if (layout.kind !== "split") return;
    containerRef.current?.style.setProperty("--uji-pane-basis", `${String(layout.ratio * 100)}%`);
  }, [layout]);

  const clearDropState = useCallback((): void => {
    setDraggedSession(undefined);
    setDropTarget(undefined);
  }, []);

  const updateDropTarget = useCallback((next: SessionDropTarget | undefined): void => {
    setDropTarget((current) =>
      current?.paneId === next?.paneId && current?.placement === next?.placement ? current : next,
    );
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "F6" && layout.kind === "split") {
        event.preventDefault();
        actions.focus(activePane(layout).id === "primary" ? "secondary" : "primary");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions, layout]);

  useEffect(
    () =>
      subscribeSessionDragEvents((event) => {
        const container = containerRef.current;
        switch (event.kind) {
          case "move": {
            setDraggedSession(event.sessionId);
            updateDropTarget(
              container === null
                ? undefined
                : sessionDropTargetAt(container, layout, event.sessionId, event),
            );
            return;
          }
          case "drop": {
            const target =
              container === null
                ? undefined
                : sessionDropTargetAt(container, layout, event.sessionId, event);
            clearDropState();
            if (target !== undefined)
              actions.drop(event.sessionId, target.paneId, target.placement);
            return;
          }
          case "cancel":
            clearDropState();
            return;
          default: {
            const _exhaustive: never = event;
            return _exhaustive;
          }
        }
      }),
    [actions, clearDropState, layout, updateDropTarget],
  );

  return (
    <div {...stylex.props(styles.stage)}>
      <div
        ref={containerRef}
        {...stylex.props(
          styles.panes,
          layout.kind === "split" &&
            (layout.direction === "right" ? styles.splitRight : styles.splitDown),
        )}
      >
        <PaneHost
          key={leading.id}
          pane={leading}
          active={activePane(layout).id === leading.id}
          position={layout.kind === "single" ? "single" : "leading"}
        />
        {layout.kind === "split" && trailing !== undefined && (
          <SplitSash
            key="pane-sash"
            direction={layout.direction}
            ratio={layout.ratio}
            containerRef={containerRef}
          />
        )}
        {layout.kind === "split" && trailing !== undefined && (
          <PaneHost
            key={trailing.id}
            pane={trailing}
            active={activePane(layout).id === trailing.id}
            position="trailing"
          />
        )}
        {draggedSession !== undefined && dropTarget !== undefined && (
          <DropPreview layout={layout} target={dropTarget} />
        )}
      </div>
      {workbenchTarget !== undefined && (
        <Workbench target={workbenchTarget} paneKey={WORKBENCH_STAGE_PANE_KEY} />
      )}
    </div>
  );
}
