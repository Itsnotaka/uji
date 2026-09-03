import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { focus, IconButton } from "../components/ui";
import { workbench } from "../theme/schema.stylex";
import { t } from "../theme/vars.stylex";
import { uji } from "../uji";

type BrowserStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "opening" }
  | { readonly kind: "error"; readonly message: string };

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
    paddingInline: 8,
    flexShrink: 0,
  },
  heading: {
    color: t.textPrimary,
    fontSize: t.fontBase,
    fontWeight: 600,
  },
  spacer: { flex: 1 },
  body: {
    display: "flex",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    paddingBottom: 76,
  },
  form: {
    display: "flex",
    width: "min(440px, 100%)",
    flexDirection: "column",
    gap: 10,
  },
  title: {
    color: t.textPrimary,
    fontSize: t.fontBase,
    fontWeight: 600,
  },
  detail: {
    color: t.textTertiary,
    fontSize: t.fontSm,
    lineHeight: t.leadingSm,
  },
  label: {
    color: t.textSecondary,
    fontSize: t.fontSm,
  },
  input: {
    width: "100%",
    minHeight: 34,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: t.borderWeak,
    borderRadius: t.radiusLg,
    backgroundColor: t.bgElevated,
    color: t.textPrimary,
    fontSize: t.fontBase,
  },
  action: {
    alignSelf: "flex-start",
    minHeight: 30,
    paddingInline: 12,
    borderStyle: "none",
    borderRadius: t.radiusLg,
    backgroundColor: {
      default: t.fillSecondary,
      ":hover:not(:disabled)": t.fillSecondaryHover,
    },
    color: t.textPrimary,
    fontSize: t.fontSm,
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { ":disabled": 0.5 },
  },
  error: {
    color: t.textDanger,
    fontSize: t.fontSm,
  },
});

function externalWebUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function BrowserPanel({
  onHome,
  onClose,
}: {
  readonly onHome: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState<BrowserStatus>({ kind: "idle" });

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (status.kind === "opening") return;
    const url = externalWebUrl(address);
    if (url === undefined) {
      setStatus({ kind: "error", message: "Enter a complete http or https address." });
      return;
    }
    setStatus({ kind: "opening" });
    void uji.host.openExternal({ url }).then(
      () => setStatus({ kind: "idle" }),
      () => setStatus({ kind: "error", message: "The system browser could not be opened." }),
    );
  };

  return (
    <section aria-label="Browser" {...stylex.props(styles.panel)}>
      <header {...stylex.props(styles.header)}>
        <IconButton icon="plus" label="Open workbench launcher" onClick={onHome} />
        <span {...stylex.props(styles.heading)}>Browser</span>
        <span {...stylex.props(styles.spacer)} />
        <IconButton icon="panel-right" label="Close workbench" size={13} onClick={onClose} />
      </header>
      <div {...stylex.props(styles.body)}>
        <form {...stylex.props(styles.form)} onSubmit={submit}>
          <span {...stylex.props(styles.title)}>Open in the system browser</span>
          <span {...stylex.props(styles.detail)}>
            This desktop build has no embedded browser panel. Web addresses open outside Uji.
          </span>
          <label htmlFor="workbench-browser-address" {...stylex.props(styles.label)}>
            Web address
          </label>
          <input
            id="workbench-browser-address"
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://example.com"
            value={address}
            {...stylex.props(styles.input, focus.ring)}
            onChange={(event) => {
              setAddress(event.currentTarget.value);
              if (status.kind === "error") setStatus({ kind: "idle" });
            }}
          />
          <button
            type="submit"
            disabled={status.kind === "opening"}
            {...stylex.props(styles.action, focus.ring)}
          >
            {status.kind === "opening" ? "Opening…" : "Open browser"}
          </button>
          {status.kind === "error" && (
            <span role="alert" {...stylex.props(styles.error)}>
              {status.message}
            </span>
          )}
        </form>
      </div>
    </section>
  );
}
