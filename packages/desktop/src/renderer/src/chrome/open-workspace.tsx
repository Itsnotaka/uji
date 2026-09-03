/**
 * One home for every way a folder opens. `pickWorkspace` and `openWorkspace`
 * end in an outcome union, and each caller — the blank stage, the rail's
 * recents and open-folder rows — funnels it through `handleOpenOutcome` so no `needs_trust`
 * or `failed` outcome is dropped on the floor. The host renders a native
 * `<dialog>` via `showModal`: real focus trap, Escape cancels, `::backdrop`
 * scrims. Both prompts answer the action the user just took, so a modal does
 * not interrupt anything — it *is* the next step of the task. Trust is the
 * product's one permission gate (invariant 21); the copy matches the TUI so
 * both clients ask the same question.
 */
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ReactElement, ReactNode } from "react";
import { Button } from "../components/ui";
import { keys, queryClient } from "../queries.ts";
import { t } from "../theme/vars.stylex.ts";
import { uji } from "../uji.ts";
import type { OpenWorkspaceOutcome } from "../uji.ts";

const styles = stylex.create({
  // No `display` here: the user-agent's `dialog:not([open])` rule must keep
  // winning, and any layered author display would override it.
  dialog: {
    width: "min(460px, calc(100vw - 48px))",
    padding: 20,
    borderStyle: "none",
    borderRadius: t.radiusXl,
    backgroundColor: t.bgElevated,
    color: t.textPrimary,
    boxShadow: t.shadowModal,
  },
  inner: { display: "flex", flexDirection: "column", gap: 14 },
  title: { fontSize: t.fontLg, fontWeight: 600, color: t.textPrimary },
  path: {
    padding: "6px 10px",
    borderRadius: t.radiusBase,
    backgroundColor: t.bgFaint,
    color: t.textSecondary,
    fontFamily: t.fontMono,
    fontSize: t.fontCode,
    overflowWrap: "anywhere",
    userSelect: "text",
  },
  body: { color: t.textSecondary, fontSize: t.fontBase },
  actions: { display: "flex", justifyContent: "flex-end", gap: 8 },
});

type OpenPrompt = { kind: "trust"; path: string } | { kind: "failed"; message: string };

let prompt: OpenPrompt | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): OpenPrompt | undefined {
  return prompt;
}

function setPrompt(next: OpenPrompt | undefined): void {
  prompt = next;
  for (const listener of listeners) listener();
}

/** Route a folder-open outcome to the shared dialog host. */
export function handleOpenOutcome(outcome: OpenWorkspaceOutcome): void {
  switch (outcome.kind) {
    case "needs_trust":
      setPrompt({ kind: "trust", path: outcome.path });
      return;
    case "failed":
      setPrompt({ kind: "failed", message: outcome.message });
      return;
    case "opened":
    case "cancelled":
      setPrompt(undefined);
      return;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function grantTrust(path: string): void {
  setPrompt(undefined);
  void uji.host.trustWorkspace({ path }).then((outcome) => {
    handleOpenOutcome(outcome);
    void queryClient.invalidateQueries({ queryKey: keys.workspaces });
  });
}

function Modal({
  label,
  onDismiss,
  children,
}: {
  label: string;
  onDismiss: () => void;
  children: ReactNode;
}): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog ref={ref} aria-label={label} {...stylex.props(styles.dialog)} onClose={onDismiss}>
      <div {...stylex.props(styles.inner)}>{children}</div>
    </dialog>
  );
}

/** Mounted once in the shell; renders whichever prompt is live. */
export function WorkspaceDialogHost(): ReactElement | null {
  const current = useSyncExternalStore(subscribe, snapshot);
  if (current === undefined) return null;

  if (current.kind === "trust") {
    return (
      <Modal
        key={`trust:${current.path}`}
        label="Do you trust this folder?"
        onDismiss={() => setPrompt(undefined)}
      >
        <div {...stylex.props(styles.title)}>Do you trust this folder?</div>
        <div {...stylex.props(styles.path)}>{current.path}</div>
        <div {...stylex.props(styles.body)}>
          Uji can execute code and access files in this directory. Project plugins and skills load
          only after you trust it.
        </div>
        <div {...stylex.props(styles.actions)}>
          <Button variant="ghost" autoFocus onClick={() => setPrompt(undefined)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => grantTrust(current.path)}>
            Trust and continue
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal key="failed" label="Couldn't open folder" onDismiss={() => setPrompt(undefined)}>
      <div {...stylex.props(styles.title)}>Couldn&rsquo;t open folder</div>
      <div {...stylex.props(styles.body)}>{current.message}</div>
      <div {...stylex.props(styles.actions)}>
        <Button variant="primary" autoFocus onClick={() => setPrompt(undefined)}>
          OK
        </Button>
      </div>
    </Modal>
  );
}
