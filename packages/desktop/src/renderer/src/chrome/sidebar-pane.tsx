/**
 * The rail's seat in the stage: it owns the show/hide animation and the
 * resize handle, so the rail itself only ever renders at its full width.
 *
 * Hiding animates the seat's width to zero while the rail fades; the rail
 * stays mounted so its scroll position, search text, and in-progress rename
 * survive a toggle. Resizing writes the width straight to the root variable
 * on every pointer move and commits to the store on release, so the drag
 * never waits for React.
 *
 * Geometry follows Cursor's practical sidebar bounds: 260 default, 210 to
 * 400, an 8px pointer target on the trailing edge, and 8px keyboard steps.
 */
import * as stylex from "@stylexjs/stylex";
import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactElement, ReactNode } from "react";
import { sidebar } from "../theme/schema.stylex.ts";
import { t } from "../theme/vars.stylex.ts";
import {
  clampSidebarWidth,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STEP,
  shellActions,
  useShellState,
} from "./shell-state.ts";

const styles = stylex.create({
  seat: {
    position: "relative",
    display: "flex",
    width: sidebar.width,
    minWidth: 0,
    minHeight: 0,
    flexShrink: 0,
    overflow: "hidden",
    transitionProperty: "width",
    transitionDuration: t.durationSlow,
    transitionTimingFunction: t.easeOutQuint,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0s" },
  },
  seatHidden: {
    width: 0,
    pointerEvents: "none",
  },
  seatResizing: { transitionDuration: "0s" },
  rail: {
    display: "flex",
    width: sidebar.width,
    minWidth: sidebar.width,
    minHeight: 0,
    flexShrink: 0,
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: t.durationNormal,
    transitionTimingFunction: t.easeOut,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0s" },
  },
  railHidden: { opacity: 0 },
  handle: {
    position: "absolute",
    zIndex: 5,
    insetBlock: 0,
    insetInlineEnd: 0,
    width: sidebar.handleWidth,
    cursor: "col-resize",
    touchAction: "none",
    outlineStyle: "none",
    "::after": {
      content: '""',
      position: "absolute",
      insetBlock: 0,
      insetInlineEnd: 0,
      width: 1,
      borderRadius: t.radiusFull,
      backgroundColor: {
        default: t.borderSubtle,
        ":hover": t.strokeSecondary,
        ":focus-visible": t.strokeFocused,
      },
      transitionProperty: "background-color",
      transitionDuration: t.durationFast,
    },
  },
  handleActive: { "::after": { backgroundColor: t.strokeFocused } },
});

interface ResizeState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  nextWidth: number;
}

export function SidebarPane({ children }: { readonly children: ReactNode }): ReactElement {
  const { sidebarVisible, sidebarWidth } = useShellState();
  const [resizing, setResizing] = useState(false);
  const resizeRef = useRef<ResizeState | undefined>(undefined);

  const applyWidth = (width: number): void => {
    document.documentElement.style.setProperty("--uji-sidebar-width", `${String(width)}px`);
  };

  const beginResize = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidth,
      nextWidth: sidebarWidth,
    };
    setResizing(true);
  };

  const moveResize = (event: PointerEvent<HTMLDivElement>): void => {
    const resize = resizeRef.current;
    if (resize === undefined || resize.pointerId !== event.pointerId) return;
    resize.nextWidth = clampSidebarWidth(resize.startWidth + event.clientX - resize.startX);
    applyWidth(resize.nextWidth);
  };

  const endResize = (event: PointerEvent<HTMLDivElement>): void => {
    const resize = resizeRef.current;
    if (resize === undefined || resize.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeRef.current = undefined;
    shellActions.setSidebarWidth(resize.nextWidth);
    setResizing(false);
  };

  const cancelResize = (event: PointerEvent<HTMLDivElement>): void => {
    const resize = resizeRef.current;
    if (resize === undefined || resize.pointerId !== event.pointerId) return;
    resizeRef.current = undefined;
    applyWidth(resize.startWidth);
    setResizing(false);
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    let width: number | undefined;
    const step = event.shiftKey ? SIDEBAR_WIDTH_STEP * 4 : SIDEBAR_WIDTH_STEP;
    if (event.key === "ArrowLeft") width = sidebarWidth - step;
    else if (event.key === "ArrowRight") width = sidebarWidth + step;
    else if (event.key === "Home") width = SIDEBAR_WIDTH_MIN;
    else if (event.key === "End") width = SIDEBAR_WIDTH_MAX;
    if (width === undefined) return;
    event.preventDefault();
    shellActions.setSidebarWidth(width);
  };

  return (
    <div
      {...stylex.props(
        styles.seat,
        !sidebarVisible && styles.seatHidden,
        resizing && styles.seatResizing,
      )}
    >
      <div
        aria-hidden={!sidebarVisible}
        inert={sidebarVisible ? undefined : true}
        {...stylex.props(styles.rail, !sidebarVisible && styles.railHidden)}
      >
        {children}
      </div>
      {sidebarVisible && (
        <div
          role="separator"
          tabIndex={0}
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_WIDTH_MIN}
          aria-valuemax={SIDEBAR_WIDTH_MAX}
          aria-valuenow={sidebarWidth}
          {...stylex.props(styles.handle, resizing && styles.handleActive)}
          onKeyDown={resizeWithKeyboard}
          onPointerDown={beginResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={cancelResize}
        />
      )}
    </div>
  );
}
