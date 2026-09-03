import type { SessionId } from "@uji-ai/core";
import { asSessionId } from "../../../shared/ipc.ts";
import { z } from "../schemas/zod.ts";

export type PaneId = "primary" | "secondary";
export type SplitDirection = "right" | "down";
export type DropPlacement = "center" | "top" | "bottom" | "left" | "right";
type EdgeDropPlacement = Exclude<DropPlacement, "center">;

export type PaneSelection =
  | { readonly kind: "blank" }
  | { readonly kind: "session"; readonly sessionId: SessionId };

export interface PaneState {
  readonly id: PaneId;
  readonly selection: PaneSelection;
}

export type PaneLayout =
  | { readonly kind: "single"; readonly pane: PaneState }
  | {
      readonly kind: "split";
      readonly direction: SplitDirection;
      readonly ratio: number;
      readonly order: readonly [PaneId, PaneId];
      readonly primary: PaneState;
      readonly secondary: PaneState;
      readonly activePaneId: PaneId;
    };

export type PaneLayoutAction =
  | { readonly kind: "select"; readonly selection: PaneSelection }
  | { readonly kind: "select-in-pane"; readonly paneId: PaneId; readonly selection: PaneSelection }
  | { readonly kind: "split"; readonly direction: SplitDirection }
  | { readonly kind: "close"; readonly paneId: PaneId }
  | { readonly kind: "focus"; readonly paneId: PaneId }
  | { readonly kind: "resize"; readonly ratio: number }
  | {
      readonly kind: "drop-session";
      readonly sessionId: SessionId;
      readonly targetPaneId: PaneId;
      readonly placement: DropPlacement;
    }
  | { readonly kind: "remove-session"; readonly sessionId: SessionId };

export const BLANK_SELECTION: PaneSelection = { kind: "blank" };
export const DEFAULT_SPLIT_RATIO = 0.5;
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;

export function createSinglePane(
  paneId: PaneId = "primary",
  selection: PaneSelection = BLANK_SELECTION,
): PaneLayout {
  return { kind: "single", pane: { id: paneId, selection } };
}

export function activePane(layout: PaneLayout): PaneState {
  if (layout.kind === "single") return layout.pane;
  return layout.activePaneId === "primary" ? layout.primary : layout.secondary;
}

export function paneById(layout: PaneLayout, paneId: PaneId): PaneState | undefined {
  if (layout.kind === "single") return layout.pane.id === paneId ? layout.pane : undefined;
  return paneId === "primary" ? layout.primary : layout.secondary;
}

export function orderedPanes(layout: PaneLayout): readonly PaneState[] {
  if (layout.kind === "single") return [layout.pane];
  return layout.order.map((paneId) => (paneId === "primary" ? layout.primary : layout.secondary));
}

export function visibleSessionIds(layout: PaneLayout): ReadonlySet<SessionId> {
  const sessionIds = new Set<SessionId>();
  for (const pane of orderedPanes(layout)) {
    if (pane.selection.kind === "session") sessionIds.add(pane.selection.sessionId);
  }
  return sessionIds;
}

export function paneForSession(layout: PaneLayout, sessionId: SessionId): PaneState | undefined {
  return orderedPanes(layout).find(
    (pane) => pane.selection.kind === "session" && pane.selection.sessionId === sessionId,
  );
}

export function activeSelection(layout: PaneLayout): PaneSelection {
  return activePane(layout).selection;
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

function otherPaneId(paneId: PaneId): PaneId {
  return paneId === "primary" ? "secondary" : "primary";
}

function sameSelection(left: PaneSelection, right: PaneSelection): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "blank" || right.kind === "blank") return true;
  return left.sessionId === right.sessionId;
}

function withPaneSelection(
  layout: Extract<PaneLayout, { kind: "split" }>,
  paneId: PaneId,
  selection: PaneSelection,
): Extract<PaneLayout, { kind: "split" }> {
  const current = paneId === "primary" ? layout.primary : layout.secondary;
  if (sameSelection(current.selection, selection)) return layout;
  const nextPane = { ...current, selection };
  return paneId === "primary"
    ? { ...layout, primary: nextPane }
    : { ...layout, secondary: nextPane };
}

function withActivePane(
  layout: Extract<PaneLayout, { kind: "split" }>,
  paneId: PaneId,
): Extract<PaneLayout, { kind: "split" }> {
  return layout.activePaneId === paneId ? layout : { ...layout, activePaneId: paneId };
}

function selectInActivePane(layout: PaneLayout, selection: PaneSelection): PaneLayout {
  if (selection.kind === "session") {
    const visible = paneForSession(layout, selection.sessionId);
    if (visible !== undefined) return focusPane(layout, visible.id);
  }
  return selectInPane(layout, activePane(layout).id, selection);
}

function selectInPane(layout: PaneLayout, paneId: PaneId, selection: PaneSelection): PaneLayout {
  const target = paneById(layout, paneId);
  if (target === undefined) return layout;
  if (selection.kind === "session") {
    const visible = paneForSession(layout, selection.sessionId);
    if (visible !== undefined && visible.id !== paneId) return focusPane(layout, visible.id);
  }
  if (layout.kind === "single") {
    return sameSelection(layout.pane.selection, selection)
      ? layout
      : { kind: "single", pane: { ...layout.pane, selection } };
  }
  return withActivePane(withPaneSelection(layout, paneId, selection), paneId);
}

function splitPane(layout: PaneLayout, direction: SplitDirection): PaneLayout {
  if (layout.kind === "split") return layout;
  const secondId = otherPaneId(layout.pane.id);
  const primary: PaneState =
    layout.pane.id === "primary" ? layout.pane : { id: "primary", selection: BLANK_SELECTION };
  const secondary: PaneState =
    layout.pane.id === "secondary" ? layout.pane : { id: "secondary", selection: BLANK_SELECTION };
  return {
    kind: "split",
    direction,
    ratio: DEFAULT_SPLIT_RATIO,
    order: [layout.pane.id, secondId],
    primary,
    secondary,
    activePaneId: secondId,
  };
}

function closePane(layout: PaneLayout, paneId: PaneId): PaneLayout {
  const target = paneById(layout, paneId);
  if (target === undefined) return layout;
  if (layout.kind === "single") {
    return target.selection.kind === "blank"
      ? layout
      : { kind: "single", pane: { ...target, selection: BLANK_SELECTION } };
  }
  const survivorId = otherPaneId(paneId);
  const survivor = survivorId === "primary" ? layout.primary : layout.secondary;
  return { kind: "single", pane: survivor };
}

function focusPane(layout: PaneLayout, paneId: PaneId): PaneLayout {
  if (paneById(layout, paneId) === undefined || layout.kind === "single") return layout;
  return withActivePane(layout, paneId);
}

function resizePane(layout: PaneLayout, ratio: number): PaneLayout {
  if (layout.kind === "single") return layout;
  const nextRatio = clampSplitRatio(ratio);
  return layout.ratio === nextRatio ? layout : { ...layout, ratio: nextRatio };
}

function swapSelections(
  layout: Extract<PaneLayout, { kind: "split" }>,
  firstId: PaneId,
  secondId: PaneId,
): Extract<PaneLayout, { kind: "split" }> {
  const first = firstId === "primary" ? layout.primary : layout.secondary;
  const second = secondId === "primary" ? layout.primary : layout.secondary;
  const firstReplacement = { ...first, selection: second.selection };
  const secondReplacement = { ...second, selection: first.selection };
  return firstId === "primary"
    ? { ...layout, primary: firstReplacement, secondary: secondReplacement }
    : { ...layout, primary: secondReplacement, secondary: firstReplacement };
}

function dropInCenter(layout: PaneLayout, sessionId: SessionId, targetPaneId: PaneId): PaneLayout {
  const target = paneById(layout, targetPaneId);
  if (target === undefined) return layout;
  if (target.selection.kind === "session" && target.selection.sessionId === sessionId)
    return layout;
  const source = paneForSession(layout, sessionId);
  if (layout.kind === "split" && source !== undefined) {
    return withActivePane(swapSelections(layout, source.id, targetPaneId), targetPaneId);
  }
  return selectInPane(layout, targetPaneId, { kind: "session", sessionId });
}

function edgeGeometry(placement: EdgeDropPlacement): {
  readonly direction: SplitDirection;
  readonly draggedFirst: boolean;
} {
  switch (placement) {
    case "left":
      return { direction: "right", draggedFirst: true };
    case "right":
      return { direction: "right", draggedFirst: false };
    case "top":
      return { direction: "down", draggedFirst: true };
    case "bottom":
      return { direction: "down", draggedFirst: false };
    default: {
      const _exhaustive: never = placement;
      return _exhaustive;
    }
  }
}

function sameOrder(current: readonly [PaneId, PaneId], next: readonly [PaneId, PaneId]): boolean {
  return current[0] === next[0] && current[1] === next[1];
}

function dropOnEdge(
  layout: PaneLayout,
  sessionId: SessionId,
  targetPaneId: PaneId,
  placement: EdgeDropPlacement,
): PaneLayout {
  const target = paneById(layout, targetPaneId);
  if (target === undefined) return layout;
  if (target.selection.kind === "session" && target.selection.sessionId === sessionId)
    return layout;
  const geometry = edgeGeometry(placement);
  if (layout.kind === "single") {
    const split = splitPane(layout, geometry.direction);
    if (split.kind === "single") return split;
    const draggedPaneId = otherPaneId(targetPaneId);
    const order: readonly [PaneId, PaneId] = geometry.draggedFirst
      ? [draggedPaneId, targetPaneId]
      : [targetPaneId, draggedPaneId];
    return {
      ...withPaneSelection(split, draggedPaneId, { kind: "session", sessionId }),
      order,
      activePaneId: draggedPaneId,
    };
  }

  const source = paneForSession(layout, sessionId);
  const draggedPaneId = source?.id ?? otherPaneId(targetPaneId);
  const order: readonly [PaneId, PaneId] = geometry.draggedFirst
    ? [draggedPaneId, targetPaneId]
    : [targetPaneId, draggedPaneId];
  if (
    source !== undefined &&
    layout.direction === geometry.direction &&
    sameOrder(layout.order, order)
  ) {
    return withActivePane(layout, draggedPaneId);
  }
  const next =
    source === undefined
      ? withPaneSelection(layout, draggedPaneId, { kind: "session", sessionId })
      : layout;
  return {
    ...next,
    direction: geometry.direction,
    order,
    activePaneId: draggedPaneId,
  };
}

function dropSession(
  layout: PaneLayout,
  sessionId: SessionId,
  targetPaneId: PaneId,
  placement: DropPlacement,
): PaneLayout {
  return placement === "center"
    ? dropInCenter(layout, sessionId, targetPaneId)
    : dropOnEdge(layout, sessionId, targetPaneId, placement);
}

function removeSession(layout: PaneLayout, sessionId: SessionId): PaneLayout {
  const pane = paneForSession(layout, sessionId);
  if (pane === undefined) return layout;
  return selectInPane(layout, pane.id, BLANK_SELECTION);
}

export function reducePaneLayout(layout: PaneLayout, action: PaneLayoutAction): PaneLayout {
  switch (action.kind) {
    case "select":
      return selectInActivePane(layout, action.selection);
    case "select-in-pane":
      return selectInPane(layout, action.paneId, action.selection);
    case "split":
      return splitPane(layout, action.direction);
    case "close":
      return closePane(layout, action.paneId);
    case "focus":
      return focusPane(layout, action.paneId);
    case "resize":
      return resizePane(layout, action.ratio);
    case "drop-session":
      return dropSession(layout, action.sessionId, action.targetPaneId, action.placement);
    case "remove-session":
      return removeSession(layout, action.sessionId);
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

const paneIdSchema = z.enum(["primary", "secondary"]);
const paneSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("blank") }),
  z.strictObject({
    kind: z.literal("session"),
    sessionId: z.string().min(1).transform(asSessionId),
  }),
]);
const paneStateSchema = z.strictObject({ id: paneIdSchema, selection: paneSelectionSchema });
const paneOrderSchema = z.tuple([paneIdSchema, paneIdSchema]);
const persistedPaneLayoutSchema = z.discriminatedUnion("kind", [
  z.strictObject({ version: z.literal(1), kind: z.literal("single"), pane: paneStateSchema }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("split"),
    direction: z.enum(["right", "down"]),
    ratio: z.number().finite().min(MIN_SPLIT_RATIO).max(MAX_SPLIT_RATIO),
    order: paneOrderSchema,
    primary: paneStateSchema,
    secondary: paneStateSchema,
    activePaneId: paneIdSchema,
  }),
]);

export function parsePersistedPaneLayout(value: string | null): PaneLayout {
  if (value === null) return createSinglePane();
  try {
    const parsedJson: unknown = JSON.parse(value);
    const decoded = persistedPaneLayoutSchema.safeParse(parsedJson);
    if (!decoded.success) return createSinglePane();
    const persisted = decoded.data;
    if (persisted.kind === "single") return { kind: "single", pane: persisted.pane };
    const { primary, secondary, order, activePaneId, direction, ratio } = persisted;
    if (primary?.id !== "primary" || secondary?.id !== "secondary" || order[0] === order[1]) {
      return createSinglePane();
    }
    if (
      primary.selection.kind === "session" &&
      secondary.selection.kind === "session" &&
      primary.selection.sessionId === secondary.selection.sessionId
    ) {
      return createSinglePane();
    }
    return {
      kind: "split",
      direction,
      ratio,
      order,
      primary,
      secondary,
      activePaneId,
    };
  } catch {
    return createSinglePane();
  }
}

export function serializePaneLayout(layout: PaneLayout): string {
  return JSON.stringify({ version: 1, ...layout });
}
