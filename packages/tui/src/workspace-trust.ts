import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { bold, BoxRenderable, fg, StyledText, TextRenderable } from "@opentui/core";
import type { CliRenderer, KeyEvent, TextChunk } from "@opentui/core";
import { WorkspaceTrustStore } from "@uji-ai/core";
import {
  WORKSPACE_TRUST_MESSAGE,
  WORKSPACE_TRUST_QUESTION,
  WORKSPACE_TRUST_TITLE,
} from "./constants.ts";
import type { CliTheme } from "./theme.ts";

export type WorkspaceTrustDecision = "trust" | "decline";
export type WorkspaceTrustDeclineAction = "quit" | "cancel";

export function createWorkspaceTrustStore(): WorkspaceTrustStore {
  const ujiHome = resolve(process.env["UJI_HOME"] ?? join(homedir(), ".uji"));
  return new WorkspaceTrustStore(join(ujiHome, "trust.json"));
}

function consume(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}

interface WorkspaceTrustDialogOptions {
  renderer: CliRenderer;
  theme: CliTheme;
  cwd: string;
  declineAction: WorkspaceTrustDeclineAction;
  signal?: AbortSignal;
  nextId?: (prefix?: string) => string;
}

/** The single pre-workspace gate. It deliberately has no "allow once" path. */
class WorkspaceTrustDialog {
  readonly result: Promise<WorkspaceTrustDecision>;

  private readonly renderer: CliRenderer;
  private readonly overlay: BoxRenderable;
  private readonly trustRow: TextRenderable;
  private readonly declineRow: TextRenderable;
  private readonly theme: CliTheme;
  private readonly declineAction: WorkspaceTrustDeclineAction;
  private readonly signal: AbortSignal | undefined;
  private resolveResult: ((decision: WorkspaceTrustDecision) => void) | undefined;
  private selected: WorkspaceTrustDecision = "decline";
  private settled = false;

  constructor(options: WorkspaceTrustDialogOptions) {
    this.renderer = options.renderer;
    this.theme = options.theme;
    this.declineAction = options.declineAction;
    this.signal = options.signal;
    const nextId = options.nextId ?? ((prefix = "trust") => `${prefix}-${crypto.randomUUID()}`);

    this.overlay = new BoxRenderable(options.renderer, {
      id: nextId("trust-overlay"),
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 100,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: options.theme.terminal,
    });
    const window = new BoxRenderable(options.renderer, {
      id: nextId("trust-window"),
      width: "90%",
      maxWidth: 120,
      maxHeight: "100%",
      flexDirection: "column",
      overflow: "hidden",
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      border: true,
      borderStyle: "rounded",
      borderColor: options.theme.path,
      backgroundColor: options.theme.background,
    });
    const details = new BoxRenderable(options.renderer, {
      id: nextId("trust-details"),
      width: "100%",
      flexDirection: "column",
      flexShrink: 1,
      minHeight: 1,
      overflow: "hidden",
    });
    details.add(
      new TextRenderable(options.renderer, {
        id: nextId("trust-title"),
        content: new StyledText([
          fg(options.theme.warning)("⚠ "),
          bold(fg(options.theme.foreground)(WORKSPACE_TRUST_TITLE)),
        ]),
      }),
    );
    details.add(
      new TextRenderable(options.renderer, {
        id: nextId("trust-path"),
        marginTop: 1,
        content: `  ${options.cwd}`,
        fg: options.theme.path,
      }),
    );
    details.add(
      new TextRenderable(options.renderer, {
        id: nextId("trust-message"),
        marginTop: 1,
        content: WORKSPACE_TRUST_MESSAGE,
        fg: options.theme.foreground,
      }),
    );
    details.add(
      new TextRenderable(options.renderer, {
        id: nextId("trust-question"),
        marginTop: 1,
        marginBottom: 2,
        content: WORKSPACE_TRUST_QUESTION,
        fg: options.theme.foreground,
      }),
    );
    window.add(details);

    this.trustRow = new TextRenderable(options.renderer, {
      id: nextId("trust-accept"),
      content: "",
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
    });
    this.declineRow = new TextRenderable(options.renderer, {
      id: nextId("trust-decline"),
      content: "",
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
    });
    window.add(this.trustRow);
    window.add(this.declineRow);
    window.add(
      new TextRenderable(options.renderer, {
        id: nextId("trust-footer"),
        marginTop: 1,
        content: "↑↓ move · enter · a/q choose",
        fg: options.theme.dim,
        flexShrink: 0,
        wrapMode: "none",
      }),
    );
    this.overlay.add(window);
    options.renderer.root.add(this.overlay);
    this.paintRows();

    this.result = new Promise<WorkspaceTrustDecision>((resolveResult) => {
      this.resolveResult = resolveResult;
    });
    options.renderer.keyInput.on("keypress", this.onKeyPress);
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal?.aborted === true) this.select("decline");
  }

  private row(decision: WorkspaceTrustDecision, key: string, label: string): StyledText {
    const selected = decision === this.selected;
    const emphasis = selected ? bold : (chunk: TextChunk) => chunk;
    return new StyledText([
      fg(selected ? this.theme.ok : this.theme.dim)(selected ? "▸ " : "  "),
      fg(selected ? this.theme.foreground : this.theme.dim)(`[${key}] `),
      emphasis(fg(selected ? this.theme.foreground : this.theme.dim)(label)),
    ]);
  }

  private paintRows(): void {
    this.trustRow.content = this.row("trust", "a", "Trust this workspace");
    this.declineRow.content = this.row(
      "decline",
      "q",
      this.declineAction === "quit" ? "Quit" : "Cancel",
    );
  }

  private readonly onAbort = (): void => this.select("decline");

  private readonly onKeyPress = (key: KeyEvent): void => {
    if (this.settled) return;
    if (key.name === "a") {
      consume(key);
      this.select("trust");
      return;
    }
    if (key.name === "q" || key.name === "escape") {
      consume(key);
      this.select("decline");
      return;
    }
    if (key.name === "return") {
      consume(key);
      this.select(this.selected);
      return;
    }
    if (key.name === "up" || key.name === "down" || key.name === "tab") {
      consume(key);
      this.selected = this.selected === "trust" ? "decline" : "trust";
      this.paintRows();
    }
  };

  private select(decision: WorkspaceTrustDecision): void {
    if (this.settled) return;
    this.settled = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.renderer.keyInput.off("keypress", this.onKeyPress);
    if (decision === "decline" && this.declineAction === "quit") {
      // The renderer owns the overlay from here. Removing it would queue a
      // frame immediately before runTui destroys the renderer.
      this.resolveResult?.(decision);
      return;
    }
    this.renderer.root.remove(this.overlay);
    this.overlay.destroyRecursively();
    this.resolveResult?.(decision);
  }
}

export function requestWorkspaceTrust(
  options: WorkspaceTrustDialogOptions,
): Promise<WorkspaceTrustDecision> {
  return new WorkspaceTrustDialog(options).result;
}
