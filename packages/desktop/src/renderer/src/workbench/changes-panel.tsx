/** Local Git changes. GitHub state never participates in this query path. */
import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import type { FileChange, SessionId, VcsStatus } from "@uji-ai/core";
import { FileTypeIcon, FileTypeIconSprite } from "../components/file-type-icon";
import { Icon } from "../components/icons";
import { focus, IconButton } from "../components/ui";
import { DiffCard } from "../conversation/diff-view";
import { refreshVcs, useRunChanges, useVcsDiff, useVcsSnapshot } from "../queries.ts";
import type { VcsDiffIdentity } from "../queries.ts";
import { workbench } from "../theme/schema.stylex.ts";
import { t } from "../theme/vars.stylex.ts";
import { parseCachedDiff } from "./diff-cache.ts";

type StatusFile = VcsStatus["files"][number];

interface ChangeRow {
  readonly path: string;
  readonly kind: StatusFile["kind"];
  readonly inWorkingTree: boolean;
  readonly declared: FileChange | undefined;
}

const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    backgroundColor: t.bgBase,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    height: workbench.headerHeight,
    paddingInline: 10,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: t.borderSubtle,
    flexShrink: 0,
  },
  heading: { color: t.textPrimary, fontSize: t.fontBase, fontWeight: 600 },
  branch: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    minWidth: 0,
    color: t.textTertiary,
    fontFamily: t.fontMono,
    fontSize: t.fontCode,
  },
  branchText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  spacer: { flex: 1 },
  body: { display: "flex", flex: 1, minHeight: 0, minWidth: 0 },
  files: {
    width: workbench.fileListWidth,
    flexShrink: 0,
    minHeight: 0,
    overflowY: "auto",
    padding: 5,
    borderInlineEndWidth: 1,
    borderInlineEndStyle: "solid",
    borderInlineEndColor: t.borderSubtle,
    backgroundColor: t.bgSubtle,
  },
  file: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    minHeight: 26,
    paddingInline: 6,
    borderRadius: t.radiusBase,
    borderStyle: "none",
    backgroundColor: { default: "transparent", ":hover": t.fillGhostHover },
    color: t.textSecondary,
    fontSize: t.fontSm,
    textAlign: "left",
    cursor: "pointer",
  },
  fileSelected: { backgroundColor: t.fillGhostSelected, color: t.textPrimary },
  status: {
    width: 10,
    flexShrink: 0,
    color: t.textTertiary,
    fontFamily: t.fontMono,
    fontSize: t.fontCode,
    textAlign: "center",
  },
  addedStatus: { color: t.added },
  modifiedStatus: { color: t.warn },
  removedStatus: { color: t.removed },
  filePath: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fileStat: {
    display: "inline-flex",
    gap: 3,
    flexShrink: 0,
    fontSize: t.fontXs,
    fontVariantNumeric: "tabular-nums",
  },
  added: { color: t.added },
  removed: { color: t.removed },
  preview: { flex: 1, minWidth: 0, minHeight: 0, overflow: "auto", padding: 8 },
  empty: {
    display: "flex",
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 0,
    padding: 20,
    color: t.textTertiary,
    fontSize: t.fontSm,
    textAlign: "center",
  },
  notice: {
    padding: 10,
    borderRadius: t.radiusLg,
    backgroundColor: t.bgFaint,
    color: t.textTertiary,
    fontSize: t.fontSm,
    lineHeight: t.leadingSm,
  },
  raw: {
    margin: 0,
    padding: 10,
    borderRadius: t.radiusLg,
    backgroundColor: t.bgEditor,
    color: t.textSecondary,
    fontFamily: t.fontMono,
    fontSize: t.fontCode,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    userSelect: "text",
  },
});

function statusLetter(kind: StatusFile["kind"]): string {
  switch (kind) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "untracked":
      return "?";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function queryError(...errors: readonly (Error | null)[]): string | undefined {
  const error = errors.find((candidate) => candidate !== null);
  if (error === undefined) return undefined;
  const message = error.message;
  return message.length > 160 ? `${message.slice(0, 159)}…` : message;
}

export function changeRows(
  status: VcsStatus | undefined,
  declared: readonly FileChange[],
): readonly ChangeRow[] {
  const declaredByPath = new Map(declared.map((change) => [change.path, change]));
  const rows = (status?.files ?? []).map((file): ChangeRow => ({
    ...file,
    inWorkingTree: true,
    declared: declaredByPath.get(file.path),
  }));
  const workingPaths = new Set(rows.map((row) => row.path));
  for (const change of declared) {
    if (!workingPaths.has(change.path)) {
      rows.push({ path: change.path, kind: "modified", inWorkingTree: false, declared: change });
    }
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

export interface ChangesPanelProps {
  readonly sessionId: SessionId | undefined;
  readonly selectedPath: string | undefined;
  readonly scrollTop: number;
  readonly onSelectPath: (path: string | undefined) => void;
  readonly onScrollTop: (scrollTop: number) => void;
  readonly onHome: () => void;
  readonly onClose: () => void;
}

export function ChangesPanel({
  sessionId,
  selectedPath,
  scrollTop,
  onSelectPath,
  onScrollTop,
  onHome,
  onClose,
}: ChangesPanelProps): ReactElement {
  const declared = useRunChanges(sessionId);
  const snapshot = useVcsSnapshot(true);
  const status = snapshot.data?.status;
  const rows = useMemo(() => changeRows(status, declared.data ?? []), [declared.data, status]);
  const activePath = rows.some((row) => row.path === selectedPath) ? selectedPath : rows[0]?.path;
  const active = rows.find((row) => row.path === activePath);
  const identity: VcsDiffIdentity | undefined =
    snapshot.data?.kind === "repository" && active?.inWorkingTree === true
      ? {
          repositoryId: snapshot.data.repositoryId,
          revision: snapshot.data.revision,
          path: active.path,
        }
      : undefined;
  const diff = useVcsDiff(identity, true);
  const parsed =
    diff.data === undefined || identity === undefined
      ? undefined
      : parseCachedDiff(identity, diff.data.patch);
  const unavailable = queryError(snapshot.error, declared.error);
  const previewRef = useRef<HTMLDivElement>(null);
  const previousPath = useRef<string | undefined>(activePath);
  const restoredScrollTop = useRef(scrollTop);

  useEffect(() => {
    if (activePath !== undefined && activePath !== selectedPath) onSelectPath(activePath);
  }, [activePath, onSelectPath, selectedPath]);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (preview === null) return;
    if (previousPath.current === activePath) preview.scrollTop = restoredScrollTop.current;
    else {
      previousPath.current = activePath;
      preview.scrollTop = 0;
      onScrollTop(0);
    }
  }, [activePath, onScrollTop]);

  return (
    <section {...stylex.props(styles.panel)} aria-label="Workspace changes">
      <FileTypeIconSprite />
      <header {...stylex.props(styles.header)}>
        <IconButton icon="plus" label="Open workbench launcher" size={13} onClick={onHome} />
        <span {...stylex.props(styles.heading)}>Changes</span>
        {status?.branch !== undefined && (
          <span {...stylex.props(styles.branch)} title={status.branch}>
            <Icon name="git-branch" size={12} />
            <span {...stylex.props(styles.branchText)}>{status.branch}</span>
          </span>
        )}
        <span {...stylex.props(styles.spacer)} />
        <IconButton icon="refresh" label="Refresh changes" size={13} onClick={refreshVcs} />
        <IconButton icon="panel-right" label="Close workbench" size={13} onClick={onClose} />
      </header>
      {rows.length === 0 ? (
        <div {...stylex.props(styles.empty)}>
          {unavailable !== undefined
            ? `Changes unavailable: ${unavailable}`
            : snapshot.isLoading || declared.isLoading
              ? "Reading changes…"
              : "Working tree is clean"}
        </div>
      ) : (
        <div {...stylex.props(styles.body)}>
          <div data-uji-scrollport {...stylex.props(styles.files)}>
            {rows.map((row) => (
              <button
                key={row.path}
                type="button"
                title={row.path}
                {...stylex.props(
                  styles.file,
                  focus.ringInset,
                  row.path === activePath && styles.fileSelected,
                )}
                onClick={() => onSelectPath(row.path)}
              >
                <FileTypeIcon path={row.path} />
                <span {...stylex.props(styles.filePath)}>{row.path.split("/").at(-1)}</span>
                {row.declared !== undefined && (
                  <span {...stylex.props(styles.fileStat)}>
                    {row.declared.added > 0 && (
                      <span {...stylex.props(styles.added)}>+{row.declared.added}</span>
                    )}
                    {row.declared.removed > 0 && (
                      <span {...stylex.props(styles.removed)}>-{row.declared.removed}</span>
                    )}
                  </span>
                )}
                <span
                  aria-label={row.kind}
                  {...stylex.props(
                    styles.status,
                    (row.kind === "added" || row.kind === "untracked") && styles.addedStatus,
                    row.kind === "modified" && styles.modifiedStatus,
                    row.kind === "deleted" && styles.removedStatus,
                  )}
                >
                  {statusLetter(row.kind)}
                </span>
              </button>
            ))}
          </div>
          <div
            ref={previewRef}
            data-uji-scrollport="balanced"
            {...stylex.props(styles.preview)}
            onScroll={(event) => onScrollTop(event.currentTarget.scrollTop)}
          >
            {active?.inWorkingTree === false ? (
              <div {...stylex.props(styles.notice)}>
                This file changed during the conversation but is no longer different in the working
                tree.
              </div>
            ) : diff.isLoading ? (
              <div {...stylex.props(styles.notice)}>Loading patch…</div>
            ) : diff.isError ? (
              <div {...stylex.props(styles.notice)}>The patch could not be read.</div>
            ) : parsed !== undefined && activePath !== undefined ? (
              <DiffCard path={activePath} diff={parsed} fill />
            ) : diff.data !== undefined && diff.data.patch.trim() !== "" ? (
              <pre {...stylex.props(styles.raw)}>{diff.data.patch}</pre>
            ) : (
              <div {...stylex.props(styles.notice)}>No text diff is available for this file.</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
