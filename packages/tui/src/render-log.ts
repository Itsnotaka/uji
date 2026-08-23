import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { CliRenderEvents } from "@opentui/core";
import type {
  CliRenderer,
  CliRendererErrorEvent,
  CliRendererFrameEvent,
  CliRendererHandlerErrorEvent,
  Renderable,
} from "@opentui/core";
import type { WorkspaceTrustDecision, WorkspaceTrustDeclineAction } from "./workspace-trust.ts";

const RENDER_LOG_ENV = "UJI_TUI_RENDER_LOG";

export interface SerializedRenderLogError {
  name: string;
  message: string;
  stack: string | null;
}

interface RenderableDescription {
  id: string;
  type: string;
}

type RendererDescription = {
  width: number;
  height: number;
  frameId: number;
} & (
  | { isDestroyed: true }
  | {
      isDestroyed: false;
      controlState: CliRenderer["currentControlState"];
      rootChildren: number;
      focusedRenderable: string | null;
      scheduler: ReturnType<CliRenderer["getSchedulerState"]>;
    }
);

export type TuiRenderLogEvent =
  | { kind: "run_started" }
  | { kind: "workspace_trust_opened"; declineAction: WorkspaceTrustDeclineAction }
  | {
      kind: "workspace_trust_resolved";
      decision: WorkspaceTrustDecision;
      declineAction: WorkspaceTrustDeclineAction;
    }
  | { kind: "shutdown_started"; activeResources: string[] }
  | { kind: "shutdown_completed"; activeResources: string[] }
  | { kind: "startup_quit"; activeResources: string[] }
  | { kind: "renderer_destroyed"; activeResources: string[] }
  | { kind: "run_failed"; error: SerializedRenderLogError; activeResources: string[] };

type RenderLogEvent =
  | TuiRenderLogEvent
  | { kind: "render_log_opened"; path: string }
  | { kind: "renderer_attached" }
  | { kind: "frame"; frameId: number }
  | {
      kind: "render_error";
      error: SerializedRenderLogError;
      renderable: RenderableDescription | null;
    }
  | {
      kind: "handler_error";
      error: SerializedRenderLogError;
      mouse: { type: string; target: string | null };
    }
  | { kind: "renderer_destroy_started"; activeResources: string[] }
  | { kind: "render_log_closed" };

export function renderLogError(error: unknown): SerializedRenderLogError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    };
  }
  return { name: "NonError", message: String(error), stack: null };
}

function describeRenderable(renderable: Renderable | undefined): RenderableDescription | null {
  if (renderable === undefined) return null;
  return { id: renderable.id, type: renderable.constructor.name };
}

function describeRenderer(renderer: CliRenderer): RendererDescription {
  const size = { width: renderer.width, height: renderer.height, frameId: renderer.frameId };
  if (renderer.isDestroyed) return { ...size, isDestroyed: true };
  return {
    ...size,
    isDestroyed: false,
    controlState: renderer.currentControlState,
    rootChildren: renderer.root.getChildrenCount(),
    focusedRenderable: renderer.currentFocusedRenderable?.id ?? null,
    scheduler: renderer.getSchedulerState(),
  };
}

function defaultRenderLogPath(): string {
  const ujiHome = resolve(process.env["UJI_HOME"] ?? join(homedir(), ".uji"));
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return join(ujiHome, "logs", `tui-render-${timestamp}-${String(process.pid)}.jsonl`);
}

function resolveRenderLogPath(target: string | undefined): string | undefined {
  if (target === undefined || target === "" || target === "0" || target.toLowerCase() === "false") {
    return undefined;
  }
  if (target === "1" || target.toLowerCase() === "true") return defaultRenderLogPath();
  return resolve(target);
}

/**
 * Opt-in, synchronous JSONL diagnostics for renderer failures and teardown races.
 * Sync writes are intentional: the final event must reach disk before a native crash.
 */
export class TuiRenderLog {
  readonly path: string;

  private readonly descriptor: number;
  private readonly startedAt = performance.now();
  private renderer: CliRenderer | undefined;
  private closed = false;
  private writeFailed = false;
  private sequence = 0;
  private detachRenderer: (() => void) | undefined;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.descriptor = openSync(path, "a", 0o600);
    this.write({ kind: "render_log_opened", path });
  }

  attach(renderer: CliRenderer): void {
    this.detachRenderer?.();
    this.renderer = renderer;

    const onFrame = (event: CliRendererFrameEvent): void => {
      this.write({ kind: "frame", frameId: event.frameId });
    };
    const onRenderError = (event: CliRendererErrorEvent): void => {
      this.write({
        kind: "render_error",
        error: renderLogError(event.error),
        renderable: describeRenderable(event.renderable),
      });
      // A render:error listener marks the event handled in OpenTUI. Preserve its
      // default error behavior after writing the durable diagnostic.
      console.error(event.error);
      renderer.console.show();
    };
    const onHandlerError = (event: CliRendererHandlerErrorEvent): void => {
      this.write({
        kind: "handler_error",
        error: renderLogError(event.error),
        mouse: {
          type: event.event.type,
          target: event.event.target?.id ?? null,
        },
      });
      console.error("Error in mouse handler:", event.error);
    };
    const onDestroy = (): void => {
      this.write({
        kind: "renderer_destroy_started",
        activeResources: process.getActiveResourcesInfo(),
      });
    };

    renderer.on(CliRenderEvents.FRAME, onFrame);
    renderer.on(CliRenderEvents.RENDER_ERROR, onRenderError);
    renderer.on(CliRenderEvents.HANDLER_ERROR, onHandlerError);
    renderer.on(CliRenderEvents.DESTROY, onDestroy);
    this.detachRenderer = () => {
      renderer.off(CliRenderEvents.FRAME, onFrame);
      renderer.off(CliRenderEvents.RENDER_ERROR, onRenderError);
      renderer.off(CliRenderEvents.HANDLER_ERROR, onHandlerError);
      renderer.off(CliRenderEvents.DESTROY, onDestroy);
    };
    this.write({ kind: "renderer_attached" });
  }

  record(event: TuiRenderLogEvent): void {
    this.write(event);
  }

  close(): void {
    if (this.closed) return;
    this.write({ kind: "render_log_closed" });
    this.closed = true;
    this.detachRenderer?.();
    closeSync(this.descriptor);
  }

  private write(event: RenderLogEvent): void {
    if (this.closed || this.writeFailed) return;
    const renderer = this.renderer;
    const line = {
      sequence: this.sequence++,
      timestamp: new Date().toISOString(),
      elapsedMs: Math.round((performance.now() - this.startedAt) * 1_000) / 1_000,
      pid: process.pid,
      ...event,
      ...(renderer === undefined ? {} : { renderer: describeRenderer(renderer) }),
    };
    try {
      writeSync(this.descriptor, `${JSON.stringify(line)}\n`);
    } catch {
      this.writeFailed = true;
    }
  }
}

export function createTuiRenderLog(
  target: string | undefined = process.env[RENDER_LOG_ENV],
): TuiRenderLog | undefined {
  const path = resolveRenderLogPath(target);
  return path === undefined ? undefined : new TuiRenderLog(path);
}
