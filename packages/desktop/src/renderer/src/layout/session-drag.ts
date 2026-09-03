import { useSyncExternalStore } from "react";
import type { SessionId } from "@uji-ai/core";

export const SESSION_DRAG_ACTIVATION_DISTANCE = 8;

export type SessionDragSnapshot =
  | { readonly kind: "idle" }
  | { readonly kind: "active"; readonly sessionId: SessionId };

export interface SessionDragPoint {
  readonly clientX: number;
  readonly clientY: number;
}

export type SessionDragEvent =
  | ({ readonly kind: "move"; readonly sessionId: SessionId } & SessionDragPoint)
  | ({ readonly kind: "drop"; readonly sessionId: SessionId } & SessionDragPoint)
  | { readonly kind: "cancel"; readonly sessionId: SessionId };

interface SessionDragPointerEvent extends SessionDragPoint {
  readonly button: number;
  readonly pointerId: number;
  readonly isPrimary: boolean;
  readonly currentTarget: HTMLElement;
  readonly target: EventTarget;
}

interface SessionDragClickEvent {
  readonly currentTarget: HTMLElement;
  preventDefault(): void;
  stopPropagation(): void;
}

interface SessionDragNativeEvent {
  preventDefault(): void;
}

export interface SessionDragSourceProps {
  readonly draggable: false;
  readonly onDragStart: (event: SessionDragNativeEvent) => void;
  readonly onPointerDown: (event: SessionDragPointerEvent) => void;
  readonly onClickCapture: (event: SessionDragClickEvent) => void;
}

interface PendingSessionDrag extends SessionDragPoint {
  readonly kind: "pending";
  readonly sessionId: SessionId;
  readonly pointerId: number;
  readonly source: HTMLElement;
  readonly originX: number;
  readonly originY: number;
  readonly hostWindow: Window;
}

interface ActiveSessionDrag extends SessionDragPoint {
  readonly kind: "active";
  readonly sessionId: SessionId;
  readonly pointerId: number;
  readonly source: HTMLElement;
  readonly originX: number;
  readonly originY: number;
  readonly hostWindow: Window;
  readonly preview: HTMLElement | null;
  readonly previewOffsetX: number;
  readonly previewOffsetY: number;
}

type InternalSessionDrag = { readonly kind: "idle" } | PendingSessionDrag | ActiveSessionDrag;

const IDLE_SESSION_DRAG = Object.freeze({ kind: "idle" }) satisfies SessionDragSnapshot;

let internalDrag: InternalSessionDrag = IDLE_SESSION_DRAG;
let publicSnapshot: SessionDragSnapshot = IDLE_SESSION_DRAG;
let removeWindowListeners: (() => void) | undefined;
let suppressClickSource: HTMLElement | undefined;
const snapshotListeners = new Set<() => void>();
const eventListeners = new Set<(event: SessionDragEvent) => void>();

export function hasReachedSessionDragActivation(
  origin: SessionDragPoint,
  point: SessionDragPoint,
): boolean {
  return (
    Math.hypot(point.clientX - origin.clientX, point.clientY - origin.clientY) >=
    SESSION_DRAG_ACTIVATION_DISTANCE
  );
}

function publishSnapshot(snapshot: SessionDragSnapshot): void {
  publicSnapshot = snapshot;
  for (const listener of snapshotListeners) listener();
}

function publishEvent(event: SessionDragEvent): void {
  for (const listener of eventListeners) listener(event);
}

function dragPreviewBackground(source: HTMLElement): string {
  const view = source.ownerDocument.defaultView;
  if (view === null) return "Canvas";

  let element: HTMLElement | null = source;
  while (element !== null) {
    const color = view.getComputedStyle(element).backgroundColor;
    if (color !== "" && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
    element = element.parentElement;
  }
  return "Canvas";
}

function createDragPreview(
  source: HTMLElement,
  point: SessionDragPoint,
): {
  readonly element: HTMLElement | null;
  readonly offsetX: number;
  readonly offsetY: number;
} {
  const view = source.ownerDocument.defaultView;
  const bounds = source.getBoundingClientRect();
  const scrollport = source.closest<HTMLElement>("[data-uji-scrollport]");
  const previewWidth = Math.max(
    120,
    scrollport === null ? source.offsetWidth : scrollport.clientWidth - 16,
  );
  const offsetX = Math.min(Math.max(point.clientX - bounds.left, 0), bounds.width);
  const offsetY = Math.min(Math.max(point.clientY - bounds.top, 0), bounds.height);
  if (view === null || source.offsetWidth <= 0 || source.offsetHeight <= 0) {
    return { element: null, offsetX, offsetY };
  }

  const clone = source.cloneNode(true);
  if (!(clone instanceof view.HTMLElement)) return { element: null, offsetX, offsetY };

  clone.setAttribute("aria-hidden", "true");
  clone.setAttribute("inert", "");
  clone.setAttribute("data-uji-session-drag-preview", "");
  clone.removeAttribute("id");
  clone.removeAttribute("draggable");
  for (const element of clone.querySelectorAll("[id]")) element.removeAttribute("id");
  for (const element of clone.querySelectorAll("[draggable]")) element.removeAttribute("draggable");
  for (const element of clone.querySelectorAll<HTMLElement>("[data-uji-session-row-actions]")) {
    element.style.display = "none";
  }
  Object.assign(clone.style, {
    position: "fixed",
    top: "0",
    left: "0",
    zIndex: "10000",
    width: `${String(previewWidth)}px`,
    height: `${String(source.offsetHeight)}px`,
    borderRadius: "8px",
    backgroundColor: dragPreviewBackground(source),
    boxShadow: "0 8px 24px rgb(0 0 0 / 24%)",
    cursor: "grabbing",
    opacity: "1",
    overflow: "hidden",
    pointerEvents: "none",
    userSelect: "none",
    willChange: "transform",
  });
  source.ownerDocument.body.append(clone);
  return { element: clone, offsetX, offsetY };
}

function positionDragPreview(drag: ActiveSessionDrag, point: SessionDragPoint): void {
  drag.preview?.style.setProperty(
    "transform",
    `translate3d(${String(point.clientX - drag.previewOffsetX)}px, ${String(point.clientY - drag.previewOffsetY)}px, 0)`,
  );
}

function clearInternalDrag(): InternalSessionDrag {
  const previous = internalDrag;
  internalDrag = IDLE_SESSION_DRAG;
  removeWindowListeners?.();
  removeWindowListeners = undefined;
  if (previous.kind === "active") {
    previous.preview?.remove();
    previous.source.ownerDocument.documentElement.removeAttribute("data-uji-session-drag-active");
  }
  if (publicSnapshot.kind !== "idle") publishSnapshot(IDLE_SESSION_DRAG);
  return previous;
}

export function endSessionDrag(): void {
  const previous = clearInternalDrag();
  if (previous.kind === "active") {
    publishEvent({ kind: "cancel", sessionId: previous.sessionId });
  }
}

function activateSessionDrag(pending: PendingSessionDrag, point: SessionDragPoint): void {
  const preview = createDragPreview(pending.source, point);
  const active: ActiveSessionDrag = {
    ...pending,
    ...point,
    kind: "active",
    preview: preview.element,
    previewOffsetX: preview.offsetX,
    previewOffsetY: preview.offsetY,
  };
  internalDrag = active;
  pending.source.ownerDocument.documentElement.setAttribute("data-uji-session-drag-active", "");
  publishSnapshot({ kind: "active", sessionId: pending.sessionId });
  positionDragPreview(active, point);
  publishEvent({ kind: "move", sessionId: pending.sessionId, ...point });
}

function moveSessionDrag(event: PointerEvent): void {
  const drag = internalDrag;
  if (drag.kind === "idle" || drag.pointerId !== event.pointerId) return;
  if ((event.buttons & 1) === 0) {
    endSessionDrag();
    return;
  }
  const point = { clientX: event.clientX, clientY: event.clientY } satisfies SessionDragPoint;
  if (drag.kind === "pending") {
    if (!hasReachedSessionDragActivation({ clientX: drag.originX, clientY: drag.originY }, point)) {
      return;
    }
    event.preventDefault();
    activateSessionDrag(drag, point);
    return;
  }
  event.preventDefault();
  const active = { ...drag, ...point } satisfies ActiveSessionDrag;
  internalDrag = active;
  positionDragPreview(active, point);
  publishEvent({ kind: "move", sessionId: active.sessionId, ...point });
}

function dropSessionDrag(event: PointerEvent): void {
  const drag = internalDrag;
  if (drag.kind === "idle" || drag.pointerId !== event.pointerId) return;
  if (drag.kind === "pending") {
    clearInternalDrag();
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  const dropped = {
    kind: "drop",
    sessionId: drag.sessionId,
    clientX: event.clientX,
    clientY: event.clientY,
  } satisfies SessionDragEvent;
  suppressClickSource = drag.source;
  drag.hostWindow.setTimeout(() => {
    if (suppressClickSource === drag.source) suppressClickSource = undefined;
  }, 0);
  clearInternalDrag();
  publishEvent(dropped);
}

function bindWindowListeners(hostWindow: Window): () => void {
  const cancel = (): void => endSessionDrag();
  const keydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") endSessionDrag();
  };
  hostWindow.addEventListener("pointermove", moveSessionDrag, true);
  hostWindow.addEventListener("pointerup", dropSessionDrag, true);
  hostWindow.addEventListener("pointercancel", cancel, true);
  hostWindow.addEventListener("blur", cancel);
  hostWindow.addEventListener("keydown", keydown, true);
  return () => {
    hostWindow.removeEventListener("pointermove", moveSessionDrag, true);
    hostWindow.removeEventListener("pointerup", dropSessionDrag, true);
    hostWindow.removeEventListener("pointercancel", cancel, true);
    hostWindow.removeEventListener("blur", cancel);
    hostWindow.removeEventListener("keydown", keydown, true);
  };
}

function isInteractiveTarget(source: HTMLElement, target: EventTarget): boolean {
  const view = source.ownerDocument.defaultView;
  if (view === null || !(target instanceof view.Element)) return false;
  return target.closest("button, input, textarea, select, a, [contenteditable='true']") !== null;
}

function beginPendingSessionDrag(event: SessionDragPointerEvent, sessionId: SessionId): void {
  if (
    event.button !== 0 ||
    !event.isPrimary ||
    isInteractiveTarget(event.currentTarget, event.target)
  ) {
    return;
  }
  const hostWindow = event.currentTarget.ownerDocument.defaultView;
  if (hostWindow === null) return;

  endSessionDrag();
  suppressClickSource = undefined;
  internalDrag = {
    kind: "pending",
    sessionId,
    pointerId: event.pointerId,
    source: event.currentTarget,
    originX: event.clientX,
    originY: event.clientY,
    clientX: event.clientX,
    clientY: event.clientY,
    hostWindow,
  };
  removeWindowListeners = bindWindowListeners(hostWindow);
}

export function createSessionDragSource(sessionId: SessionId): SessionDragSourceProps {
  return {
    draggable: false,
    onDragStart(event) {
      event.preventDefault();
    },
    onPointerDown(event) {
      beginPendingSessionDrag(event, sessionId);
    },
    onClickCapture(event) {
      if (suppressClickSource !== event.currentTarget) return;
      suppressClickSource = undefined;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

export function subscribeSessionDragEvents(
  listener: (event: SessionDragEvent) => void,
): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

export function useSessionDragSnapshot(): SessionDragSnapshot {
  return useSyncExternalStore(
    (listener) => {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    () => publicSnapshot,
    () => IDLE_SESSION_DRAG,
  );
}
