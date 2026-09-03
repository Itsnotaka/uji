/** Quiet GitHub enrichment. The Changes panel has no dependency on this module. */
import * as stylex from "@stylexjs/stylex";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { GitHubProviderState } from "../../../shared/ipc.ts";
import { Icon } from "../components/icons";
import { focus, IconButton } from "../components/ui";
import { refreshGitHub, signInGitHub, useGitHubState } from "../queries.ts";
import { workbench } from "../theme/schema.stylex.ts";
import { t } from "../theme/vars.stylex.ts";
import { uji } from "../uji.ts";

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
  spacer: { flex: 1 },
  scroll: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: 14,
  },
  stack: { display: "flex", flexDirection: "column", gap: 12 },
  repository: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    color: t.textSecondary,
    fontFamily: t.fontMono,
    fontSize: t.fontCode,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 12,
    borderRadius: t.radiusLg,
    backgroundColor: t.bgFaint,
  },
  title: { color: t.textPrimary, fontSize: t.fontBase, fontWeight: 600, lineHeight: t.leadingSm },
  detail: { color: t.textTertiary, fontSize: t.fontSm, lineHeight: t.leadingSm },
  refs: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    color: t.textTertiary,
    fontFamily: t.fontMono,
    fontSize: t.fontCode,
  },
  action: {
    alignSelf: "flex-start",
    minHeight: 28,
    paddingInline: 10,
    borderRadius: t.radiusBase,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: t.borderWeak,
    backgroundColor: { default: t.bgElevated, ":hover": t.fillGhostHover },
    color: t.textSecondary,
    fontSize: t.fontSm,
    cursor: "pointer",
  },
});

function StateBody({
  state,
  busy,
  onSignIn,
}: {
  readonly state: GitHubProviderState;
  readonly busy: boolean;
  readonly onSignIn: () => void;
}): ReactElement {
  switch (state.kind) {
    case "not_github":
      return (
        <div {...stylex.props(styles.card)}>
          <span {...stylex.props(styles.title)}>No GitHub remote</span>
          <span {...stylex.props(styles.detail)}>
            Local Git remains available in Changes. Add a GitHub remote to enable pull request
            context.
          </span>
        </div>
      );
    case "cli_missing":
      return (
        <div {...stylex.props(styles.stack)}>
          <Repository state={state} />
          <div {...stylex.props(styles.card)}>
            <span {...stylex.props(styles.title)}>GitHub CLI not found</span>
            <span {...stylex.props(styles.detail)}>
              Install `gh` to add account and pull request details. Local Git does not require it.
            </span>
          </div>
        </div>
      );
    case "signed_out":
      return (
        <div {...stylex.props(styles.stack)}>
          <Repository state={state} />
          <div {...stylex.props(styles.card)}>
            <span {...stylex.props(styles.title)}>GitHub is signed out</span>
            <span {...stylex.props(styles.detail)}>
              Sign-in uses GitHub CLI. Uji never receives or stores the token.
            </span>
            <button
              type="button"
              disabled={busy}
              {...stylex.props(styles.action, focus.ring)}
              onClick={onSignIn}
            >
              {busy ? "Waiting for GitHub…" : "Sign in with GitHub CLI"}
            </button>
          </div>
        </div>
      );
    case "ready":
      return (
        <div {...stylex.props(styles.stack)}>
          <Repository state={state} />
          <div {...stylex.props(styles.card)}>
            <span {...stylex.props(styles.title)}>Signed in as {state.account.login}</span>
            {state.account.name !== undefined && (
              <span {...stylex.props(styles.detail)}>{state.account.name}</span>
            )}
          </div>
          <PullRequest state={state} />
        </div>
      );
    case "error":
      return (
        <div {...stylex.props(styles.stack)}>
          {state.repository !== undefined && <Repository state={state} />}
          <div {...stylex.props(styles.card)}>
            <span {...stylex.props(styles.title)}>GitHub details are unavailable</span>
            <span {...stylex.props(styles.detail)}>{state.message}</span>
            <span {...stylex.props(styles.detail)}>Local Git remains available in Changes.</span>
          </div>
        </div>
      );
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function Repository({
  state,
}: {
  readonly state: Exclude<GitHubProviderState, { readonly kind: "not_github" }>;
}): ReactElement | null {
  if (state.repository === undefined) return null;
  return (
    <div {...stylex.props(styles.repository)}>
      <Icon name="git-branch" size={13} />
      <span>
        {state.repository.owner}/{state.repository.name}
      </span>
    </div>
  );
}

function PullRequest({
  state,
}: {
  readonly state: Extract<GitHubProviderState, { readonly kind: "ready" }>;
}): ReactElement {
  switch (state.pullRequest.kind) {
    case "none":
      return (
        <div {...stylex.props(styles.card)}>
          <span {...stylex.props(styles.title)}>No pull request for this branch</span>
          <button
            type="button"
            {...stylex.props(styles.action, focus.ring)}
            onClick={() => void uji.host.openExternal({ url: state.repository.url })}
          >
            Open repository
          </button>
        </div>
      );
    case "error":
      return (
        <div {...stylex.props(styles.card)}>
          <span {...stylex.props(styles.title)}>Pull request context is unavailable</span>
          <span {...stylex.props(styles.detail)}>{state.pullRequest.message}</span>
        </div>
      );
    case "ready": {
      const pull = state.pullRequest.pullRequest;
      return (
        <div {...stylex.props(styles.card)}>
          <span {...stylex.props(styles.title)}>
            #{String(pull.number)} {pull.title}
          </span>
          <span {...stylex.props(styles.detail)}>
            {pull.draft ? "Draft" : pull.state.toLocaleLowerCase()}
          </span>
          <span {...stylex.props(styles.refs)}>
            {pull.headRefName}
            <Icon name="arrow-left" size={11} />
            {pull.baseRefName}
          </span>
          <button
            type="button"
            {...stylex.props(styles.action, focus.ring)}
            onClick={() => void uji.host.openExternal({ url: pull.url })}
          >
            Open pull request
          </button>
        </div>
      );
    }
    default: {
      const _exhaustive: never = state.pullRequest;
      return _exhaustive;
    }
  }
}

export interface GitHubPanelProps {
  readonly scrollTop: number;
  readonly onScrollTop: (scrollTop: number) => void;
  readonly onHome: () => void;
  readonly onClose: () => void;
}

export function GitHubPanel({
  scrollTop,
  onScrollTop,
  onHome,
  onClose,
}: GitHubPanelProps): ReactElement {
  const github = useGitHubState(true);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoredScrollTop = useRef(scrollTop);
  useLayoutEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = restoredScrollTop.current;
  }, []);

  const signIn = (): void => {
    if (busy) return;
    setBusy(true);
    void signInGitHub().finally(() => setBusy(false));
  };

  return (
    <section {...stylex.props(styles.panel)} aria-label="GitHub pull request">
      <header {...stylex.props(styles.header)}>
        <IconButton icon="plus" label="Open workbench launcher" size={13} onClick={onHome} />
        <span {...stylex.props(styles.heading)}>Pull request</span>
        <span {...stylex.props(styles.spacer)} />
        <IconButton
          icon="refresh"
          label="Refresh GitHub"
          size={13}
          onClick={() => void refreshGitHub()}
        />
        <IconButton icon="panel-right" label="Close workbench" size={13} onClick={onClose} />
      </header>
      <div
        ref={scrollRef}
        data-uji-scrollport="balanced"
        {...stylex.props(styles.scroll)}
        onScroll={(event) => onScrollTop(event.currentTarget.scrollTop)}
      >
        {github.data === undefined ? (
          <div {...stylex.props(styles.card)}>
            <span {...stylex.props(styles.detail)}>
              {github.isError ? "GitHub details could not be read." : "Checking GitHub…"}
            </span>
          </div>
        ) : (
          <StateBody state={github.data} busy={busy} onSignIn={signIn} />
        )}
      </div>
    </section>
  );
}
