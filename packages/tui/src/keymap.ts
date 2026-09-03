/**
 * Every app-level shortcut is a named command in one global keymap layer.
 *
 * `@opentui/keymap`'s OpenTUI host prepends its listener to the renderer's key
 * input, so these bindings resolve before any focused renderable sees the key.
 * That is the whole point: stopping a run, opening the palette, or switching
 * panes cannot depend on which pane the cursor happens to be in, and none of
 * them should need a mouse click first.
 *
 * Based on OpenCode's keymap wiring:
 * https://github.com/anomalyco/opencode/blob/main/packages/tui/src/keymap.tsx
 */
import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import type { Command, Keymap } from "@opentui/keymap";
import { registerCommaBindings } from "@opentui/keymap/addons";
import { registerBaseLayoutFallback } from "@opentui/keymap/addons/opentui";
import { commandBindings } from "@opentui/keymap/extras";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { CHAT_KEYBINDS } from "./constants.ts";
import type { ChatCommand } from "./constants.ts";

/**
 * A drag selection answers escape and copy itself, so its layer sits above the
 * chat layer. Both keys mean something else the moment the selection is gone,
 * and the layer's `enabled` is what says so.
 */
const SELECTION_KEYBINDS = {
  // Terminals rarely hand cmd+c to the app, so ctrl+c copies too. The chat
  // layer never binds it, and quitting runs from a later listener, so a live
  // selection takes the key first either way.
  "selection.copy": "ctrl+c,super+c,meta+c",
  "selection.clear": "escape",
} as const satisfies Readonly<Record<string, string>>;

const SELECTION_PRIORITY = 10;

export interface ChatCommandSpec {
  title: string;
  /** Omitted means available whenever the layer is. */
  enabled?: () => boolean;
  /**
   * `false` declines the key: the binding's `preventDefault` never runs, so it
   * still reaches the composer or the scrollback. That is how `up` browses
   * history from the start of the draft and moves the cursor everywhere else.
   */
  run: () => boolean | void;
}

/** The renderer-bound keymap the chat layer registers into. */
export function createChatKeymap(renderer: CliRenderer): Keymap<Renderable, KeyEvent> {
  // Default key parsing, `enabled`, and the `title`/`category` metadata fields.
  const keymap = createDefaultOpenTuiKeymap(renderer);
  // `a,b` in one binding string, for the three keycaps that queue a message.
  registerCommaBindings(keymap);
  // Fall back to the key's base layout code, so Dvorak and AZERTY keep the
  // same physical shortcuts.
  registerBaseLayoutFallback(keymap);
  return keymap;
}

/**
 * `commands` is keyed by the whole `CHAT_KEYBINDS` set, so a bound command with
 * no handler and a handler with no binding are both compile errors.
 */
export function registerChatLayer(
  keymap: Keymap<Renderable, KeyEvent>,
  options: {
    /**
     * False while another surface owns the keyboard — a menu, a login prompt, a
     * drag selection, an open completion. The layer stands down rather than
     * racing them, since going first means it would otherwise win every key.
     */
    enabled: () => boolean;
    commands: { readonly [K in ChatCommand]: ChatCommandSpec };
    keybinds?: Readonly<Record<ChatCommand, string>>;
  },
): () => void {
  const commands: Command<Renderable, KeyEvent>[] = Object.entries(options.commands).map(
    ([name, spec]) => ({
      name,
      category: "Chat",
      title: spec.title,
      run: spec.run,
      ...(spec.enabled === undefined ? {} : { enabled: spec.enabled }),
    }),
  );
  return keymap.registerLayer({
    enabled: options.enabled,
    commands,
    bindings: commandBindings(options.keybinds ?? CHAT_KEYBINDS),
  });
}

export function registerSelectionLayer(
  keymap: Keymap<Renderable, KeyEvent>,
  renderer: Pick<
    CliRenderer,
    "hasSelection" | "getSelection" | "copyToClipboardOSC52" | "clearSelection"
  >,
): () => void {
  return keymap.registerLayer({
    priority: SELECTION_PRIORITY,
    enabled: () => renderer.hasSelection,
    commands: [
      {
        name: "selection.copy",
        category: "Selection",
        title: "Copy the selected text",
        run: () => {
          const selected = renderer.getSelection()?.getSelectedText();
          if (selected !== undefined && selected !== "") renderer.copyToClipboardOSC52(selected);
          renderer.clearSelection();
        },
      },
      {
        name: "selection.clear",
        category: "Selection",
        title: "Dismiss the selection",
        run: () => {
          renderer.clearSelection();
        },
      },
    ],
    bindings: commandBindings(SELECTION_KEYBINDS),
  });
}
