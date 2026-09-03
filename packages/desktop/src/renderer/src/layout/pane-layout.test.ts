import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionId } from "@uji-ai/core";
import { asSessionId } from "../../../shared/ipc.ts";
import {
  DEFAULT_SPLIT_RATIO,
  activePane,
  createSinglePane,
  orderedPanes,
  reducePaneLayout,
} from "./pane-layout.ts";
import type {
  DropPlacement,
  PaneId,
  PaneLayout,
  PaneSelection,
  SplitDirection,
} from "./pane-layout.ts";

type SplitPaneLayout = Extract<PaneLayout, { kind: "split" }>;
type EdgePlacement = Exclude<DropPlacement, "center">;

const ALPHA = asSessionId("alpha");
const BETA = asSessionId("beta");
const GAMMA = asSessionId("gamma");
const TARGET_PANE_IDS = ["primary", "secondary"] satisfies readonly PaneId[];

const EDGE_CASES = [
  { placement: "left", direction: "right", draggedFirst: true },
  { placement: "right", direction: "right", draggedFirst: false },
  { placement: "top", direction: "down", draggedFirst: true },
  { placement: "bottom", direction: "down", draggedFirst: false },
] satisfies readonly {
  readonly placement: EdgePlacement;
  readonly direction: SplitDirection;
  readonly draggedFirst: boolean;
}[];

function session(sessionId: SessionId): PaneSelection {
  return { kind: "session", sessionId };
}

function splitLayout({
  direction,
  order,
  primary,
  secondary,
  activePaneId,
  ratio = 0.37,
}: {
  readonly direction: SplitDirection;
  readonly order: readonly [PaneId, PaneId];
  readonly primary: SessionId;
  readonly secondary: SessionId;
  readonly activePaneId: PaneId;
  readonly ratio?: number;
}): SplitPaneLayout {
  return {
    kind: "split",
    direction,
    ratio,
    order,
    primary: { id: "primary", selection: session(primary) },
    secondary: { id: "secondary", selection: session(secondary) },
    activePaneId,
  };
}

function drop({
  layout,
  sessionId,
  targetPaneId,
  placement,
}: {
  readonly layout: PaneLayout;
  readonly sessionId: SessionId;
  readonly targetPaneId: PaneId;
  readonly placement: DropPlacement;
}): PaneLayout {
  return reducePaneLayout(layout, {
    kind: "drop-session",
    sessionId,
    targetPaneId,
    placement,
  });
}

function expectSplit(layout: PaneLayout): SplitPaneLayout {
  if (layout.kind === "single") assert.fail("Expected a split pane layout");
  return layout;
}

describe("pane drop semantics", () => {
  test("a center drop replaces a single pane's selection", () => {
    const result = drop({
      layout: createSinglePane("primary", session(ALPHA)),
      sessionId: BETA,
      targetPaneId: "primary",
      placement: "center",
    });

    assert.deepEqual(result, createSinglePane("primary", session(BETA)));
  });

  test("a center drop of a third session replaces only the target and activates it", () => {
    const initial = splitLayout({
      direction: "right",
      order: ["primary", "secondary"],
      primary: ALPHA,
      secondary: BETA,
      activePaneId: "secondary",
    });
    const result = expectSplit(
      drop({
        layout: initial,
        sessionId: GAMMA,
        targetPaneId: "primary",
        placement: "center",
      }),
    );

    assert.deepEqual(result, {
      ...initial,
      primary: { id: "primary", selection: session(GAMMA) },
      activePaneId: "primary",
    });
  });

  test("a center drop of an already-visible session swaps panes and activates the destination", () => {
    const initial = splitLayout({
      direction: "right",
      order: ["primary", "secondary"],
      primary: ALPHA,
      secondary: BETA,
      activePaneId: "secondary",
    });
    const result = expectSplit(
      drop({
        layout: initial,
        sessionId: BETA,
        targetPaneId: "primary",
        placement: "center",
      }),
    );

    assert.deepEqual(result, {
      ...initial,
      primary: { id: "primary", selection: session(BETA) },
      secondary: { id: "secondary", selection: session(ALPHA) },
      activePaneId: "primary",
    });
  });

  test("each edge splits a single pane with the dragged session on the requested side", () => {
    for (const { placement, direction, draggedFirst } of EDGE_CASES) {
      const result = expectSplit(
        drop({
          layout: createSinglePane("primary", session(ALPHA)),
          sessionId: BETA,
          targetPaneId: "primary",
          placement,
        }),
      );
      const expectedOrder: readonly [PaneId, PaneId] = draggedFirst
        ? ["secondary", "primary"]
        : ["primary", "secondary"];

      assert.equal(result.direction, direction, placement);
      assert.equal(result.ratio, DEFAULT_SPLIT_RATIO, placement);
      assert.deepEqual(result.order, expectedOrder, placement);
      assert.deepEqual(result.primary.selection, session(ALPHA), placement);
      assert.deepEqual(result.secondary.selection, session(BETA), placement);
      assert.equal(activePane(result).id, "secondary", placement);
    }
  });

  test("an edge drop moves an already-visible session without replacing either selection", () => {
    const initial = splitLayout({
      direction: "right",
      order: ["primary", "secondary"],
      primary: ALPHA,
      secondary: BETA,
      activePaneId: "secondary",
    });
    const result = expectSplit(
      drop({
        layout: initial,
        sessionId: ALPHA,
        targetPaneId: "secondary",
        placement: "bottom",
      }),
    );

    assert.equal(result.direction, "down");
    assert.deepEqual(result.order, ["secondary", "primary"]);
    assert.deepEqual(result.primary.selection, session(ALPHA));
    assert.deepEqual(result.secondary.selection, session(BETA));
    assert.equal(result.ratio, initial.ratio);
    assert.equal(activePane(result).id, "primary");
  });

  test("an already-positioned edge drop still activates the dragged session", () => {
    const initial = splitLayout({
      direction: "right",
      order: ["primary", "secondary"],
      primary: ALPHA,
      secondary: BETA,
      activePaneId: "secondary",
    });
    const result = expectSplit(
      drop({
        layout: initial,
        sessionId: ALPHA,
        targetPaneId: "secondary",
        placement: "left",
      }),
    );

    assert.deepEqual(
      orderedPanes(result).map((pane) => pane.id),
      ["primary", "secondary"],
    );
    assert.equal(activePane(result).id, "primary");
  });

  test("dropping a session onto itself is a no-op for center and every edge", () => {
    const initial = splitLayout({
      direction: "right",
      order: ["primary", "secondary"],
      primary: ALPHA,
      secondary: BETA,
      activePaneId: "secondary",
    });
    const placements: readonly DropPlacement[] = ["center", "top", "bottom", "left", "right"];

    for (const placement of placements) {
      const result = drop({
        layout: initial,
        sessionId: ALPHA,
        targetPaneId: "primary",
        placement,
      });
      assert.strictEqual(result, initial, placement);
    }
  });

  test("edge-dropping a third session into a split replaces the non-target pane", () => {
    for (const targetPaneId of TARGET_PANE_IDS) {
      for (const { placement, direction, draggedFirst } of EDGE_CASES) {
        const initial = splitLayout({
          direction: "right",
          order: ["primary", "secondary"],
          primary: ALPHA,
          secondary: BETA,
          activePaneId: targetPaneId,
        });
        const draggedPaneId: PaneId = targetPaneId === "primary" ? "secondary" : "primary";
        const expectedOrder: readonly [PaneId, PaneId] = draggedFirst
          ? [draggedPaneId, targetPaneId]
          : [targetPaneId, draggedPaneId];
        const result = expectSplit(
          drop({
            layout: initial,
            sessionId: GAMMA,
            targetPaneId,
            placement,
          }),
        );

        assert.equal(result.direction, direction, `${targetPaneId}:${placement}`);
        assert.deepEqual(result.order, expectedOrder, `${targetPaneId}:${placement}`);
        assert.deepEqual(
          result.primary.selection,
          session(targetPaneId === "primary" ? ALPHA : GAMMA),
          `${targetPaneId}:${placement}`,
        );
        assert.deepEqual(
          result.secondary.selection,
          session(targetPaneId === "secondary" ? BETA : GAMMA),
          `${targetPaneId}:${placement}`,
        );
        assert.equal(activePane(result).id, draggedPaneId, `${targetPaneId}:${placement}`);
        assert.equal(result.ratio, initial.ratio, `${targetPaneId}:${placement}`);
      }
    }
  });
});
