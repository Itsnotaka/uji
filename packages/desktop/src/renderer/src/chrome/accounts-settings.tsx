/**
 * Settings › Accounts: the GitHub connection for this project and the model
 * providers the catalog knows. Each row says one thing first, whether it is
 * connected, and offers the single action that changes that.
 */
import * as stylex from "@stylexjs/stylex";
import { useMutation } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { Icon } from "../components/icons.tsx";
import { Button } from "../components/ui.tsx";
import { useProviders } from "../queries.ts";
import { settingsPatterns } from "../theme/settings-patterns.stylex.ts";
import { t } from "../theme/vars.stylex.ts";
import { uji } from "../uji.ts";
import type { ProviderStatus } from "../uji.ts";
import { useGitHubAccount, type GitHubAccountViewModel } from "./github-account.ts";

const styles = stylex.create({
  section: { paddingBlock: 18 },
  list: { display: "flex", flexDirection: "column", gap: 6 },
  row: {
    display: "grid",
    gridTemplateColumns: "28px minmax(0, 1fr) auto auto",
    alignItems: "center",
    columnGap: 12,
    minHeight: 48,
    paddingInline: 12,
    paddingBlock: 8,
    borderRadius: t.radiusLg,
    backgroundColor: t.bgFaint,
  },
  glyph: {
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    borderRadius: t.radiusBase,
    backgroundColor: t.fillSecondary,
    color: t.iconSecondary,
    overflow: "hidden",
  },
  avatar: { display: "block", width: "100%", height: "100%", objectFit: "cover" },
  body: { display: "flex", flexDirection: "column", minWidth: 0, gap: 1 },
  title: {
    color: t.textPrimary,
    fontSize: t.fontBase,
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  detail: {
    color: t.textTertiary,
    fontSize: t.fontSm,
    lineHeight: t.leadingSm,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  status: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    color: t.textTertiary,
    fontSize: t.fontSm,
    whiteSpace: "nowrap",
  },
  statusOn: { color: t.textSuccess },
  statusWarn: { color: t.textWarning },
  statusErr: { color: t.textDanger },
  dot: { width: 6, height: 6, borderRadius: t.radiusFull, backgroundColor: "currentColor" },
  actionSlot: { display: "inline-flex", justifyContent: "flex-end", minWidth: 0 },
});

type Tone = "on" | "off" | "warn" | "err";

function Status({ tone, children }: { tone: Tone; children: ReactNode }): ReactElement {
  return (
    <span
      {...stylex.props(
        styles.status,
        tone === "on" && styles.statusOn,
        tone === "warn" && styles.statusWarn,
        tone === "err" && styles.statusErr,
      )}
    >
      <span aria-hidden="true" {...stylex.props(styles.dot)} />
      {children}
    </span>
  );
}

function Row({
  glyph,
  title,
  detail,
  status,
  action,
}: {
  glyph: ReactNode;
  title: string;
  detail: string | undefined;
  status: ReactElement;
  action?: ReactElement;
}): ReactElement {
  return (
    <div {...stylex.props(styles.row)}>
      <span {...stylex.props(styles.glyph)}>{glyph}</span>
      <span {...stylex.props(styles.body)}>
        <span {...stylex.props(styles.title)}>{title}</span>
        {detail !== undefined && <span {...stylex.props(styles.detail)}>{detail}</span>}
      </span>
      {status}
      <span {...stylex.props(styles.actionSlot)}>{action}</span>
    </div>
  );
}

function GitHubRow({ account }: { account: GitHubAccountViewModel }): ReactElement {
  const glyph = <Icon name="github" size={15} />;
  switch (account.kind) {
    case "loading":
      return (
        <Row
          glyph={glyph}
          title="GitHub"
          detail={undefined}
          status={<Status tone="off">…</Status>}
        />
      );
    case "no_remote":
      return (
        <Row
          glyph={glyph}
          title="GitHub"
          detail="This project has no GitHub remote"
          status={<Status tone="off">Not connected</Status>}
        />
      );
    case "cli_missing":
      return (
        <Row
          glyph={glyph}
          title="GitHub"
          detail="Install the GitHub CLI (gh) to connect"
          status={<Status tone="off">Not connected</Status>}
        />
      );
    case "signed_out":
      return (
        <Row
          glyph={glyph}
          title="GitHub"
          detail={`${account.repository.owner}/${account.repository.name}`}
          status={<Status tone="off">Not connected</Status>}
          action={<Button onClick={account.signIn}>Sign in</Button>}
        />
      );
    case "connecting":
      return (
        <Row
          glyph={glyph}
          title="GitHub"
          detail="Finish signing in with the browser window that opened"
          status={<Status tone="warn">Waiting for browser</Status>}
        />
      );
    case "signed_in":
      return (
        <Row
          glyph={
            account.account.avatarUrl === undefined ? (
              glyph
            ) : (
              <img alt="" src={account.account.avatarUrl} {...stylex.props(styles.avatar)} />
            )
          }
          title={account.account.login}
          detail={[account.account.name, `${account.repository.owner}/${account.repository.name}`]
            .filter((part) => part !== undefined)
            .join(" · ")}
          status={<Status tone="on">Connected</Status>}
          action={
            <Button variant="ghost" disabled={account.signingOut} onClick={account.signOut}>
              Sign out
            </Button>
          }
        />
      );
    case "error":
      return (
        <Row
          glyph={glyph}
          title="GitHub"
          detail={account.message}
          status={<Status tone="err">Unavailable</Status>}
        />
      );
    default: {
      const _exhaustive: never = account;
      return _exhaustive;
    }
  }
}

function ProviderRow({ provider }: { provider: ProviderStatus }): ReactElement {
  const login = useMutation({ mutationFn: () => uji.host.login({ provider: provider.id }) });
  const logout = useMutation({ mutationFn: () => uji.host.logout({ provider: provider.id }) });
  const busy = login.isPending || logout.isPending;
  return (
    <Row
      glyph={<Icon name="globe" size={15} />}
      title={provider.name}
      detail={provider.detail}
      status={
        login.isPending ? (
          <Status tone="warn">Waiting for browser</Status>
        ) : provider.authenticated ? (
          <Status tone="on">Connected</Status>
        ) : (
          <Status tone="off">Not connected</Status>
        )
      }
      action={
        provider.authenticated ? (
          <Button variant="ghost" disabled={busy} onClick={() => logout.mutate()}>
            Sign out
          </Button>
        ) : provider.loginLabel === undefined ? undefined : (
          <Button disabled={busy} onClick={() => login.mutate()}>
            {provider.loginLabel}
          </Button>
        )
      }
    />
  );
}

export function AccountsSettings(): ReactElement {
  const account = useGitHubAccount();
  const providers = useProviders();

  return (
    <>
      <section {...stylex.props(styles.section)}>
        <h2 {...stylex.props(settingsPatterns.sectionTitle)}>GitHub</h2>
        <p {...stylex.props(settingsPatterns.sectionDescription)}>
          Signs in through the GitHub CLI. Uji never sees the token. Optional; local Git works
          without it.
        </p>
        <div {...stylex.props(styles.list)}>
          <GitHubRow account={account} />
        </div>
      </section>

      <section {...stylex.props(styles.section)}>
        <h2 {...stylex.props(settingsPatterns.sectionTitle)}>Model providers</h2>
        <p {...stylex.props(settingsPatterns.sectionDescription)}>
          Providers with a connected account appear in the model picker.
        </p>
        <div {...stylex.props(styles.list)}>
          {(providers.data ?? []).map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
        </div>
      </section>
    </>
  );
}
