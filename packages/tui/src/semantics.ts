/**
 * Test-readable meaning attached to renderables without teaching OpenTUI about
 * Uji. Definitions may be live so selected, expanded, and renamed controls do
 * not need a second state mirror.
 *
 * Based on OpenCode's simulation semantics:
 * https://github.com/anomalyco/opencode/blob/v2/packages/tui/src/simulation/semantics.ts
 */
import type { Renderable } from "@opentui/core";

type RenderableSemantics =
  | { readonly role: "dialog"; readonly label: string }
  | { readonly role: "group"; readonly label: string; readonly expanded: boolean }
  | { readonly role: "message"; readonly id: string }
  | { readonly role: "textbox"; readonly label: string };

const definitions = new WeakMap<Renderable, () => RenderableSemantics>();

export function bindSemantics(renderable: Renderable, definition: () => RenderableSemantics): void {
  definitions.set(renderable, definition);
}

export function readSemantics(renderable: Renderable): RenderableSemantics | undefined {
  return definitions.get(renderable)?.();
}
