import { isJsonObject, type Entry, type JsonValue } from "../harness/session/types.ts";
import { diffStat, patchedPath, patchOf } from "./changes.ts";
import type { ToolTurnPart } from "./transcript.ts";

type CustomEntry = Extract<Entry, { type: "custom" }>;

export type ToolStatus = "running" | "done" | "failed";

export type ToolBody =
  | { readonly kind: "none" }
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "diff";
      readonly patch: string;
      readonly path?: string;
      readonly added: number;
      readonly removed: number;
    };

export interface ToolPresentation {
  readonly name: string;
  readonly title?: string;
  readonly detail?: string;
  readonly summary?: string;
  readonly status: ToolStatus;
  readonly body: ToolBody;
}

export interface ToolLive {
  readonly text?: string;
  readonly title?: string;
}

export interface ToolResultView {
  readonly output: string;
  readonly details?: JsonValue;
  readonly title?: string;
  readonly isError: boolean;
}

export interface ToolView {
  readonly toolName: string;
  readonly args?: JsonValue;
  readonly live?: ToolLive;
  readonly result?: ToolResultView;
}

export type CustomEntryView = Pick<CustomEntry, "customType" | "data">;

export interface CustomNote {
  readonly text: string;
}

export type ToolRefiner = (view: ToolView, base: ToolPresentation) => ToolPresentation;

export type CustomRefiner = (entry: CustomEntryView, base: CustomNote) => CustomNote | null;

export interface PresenterOptions {
  readonly tools?: Readonly<Record<string, ToolRefiner>>;
  readonly custom?: Readonly<Record<string, CustomRefiner>>;
}

export interface Presenter {
  tool(view: ToolView): ToolPresentation;
  custom(entry: CustomEntryView): CustomNote | null;
}

const DETAIL_ARGS: Readonly<Record<string, string>> = {
  read: "path",
  write: "path",
  edit: "path",
  ls: "path",
  bash: "command",
};

const DETAIL_LIMIT = 80;

function stringArg(args: JsonValue | undefined, key: string): string | undefined {
  if (!isJsonObject(args)) return undefined;
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function primitiveSummary(value: JsonValue | undefined): string | undefined {
  if (!isJsonObject(value)) return undefined;
  const pairs: string[] = [];
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string" || typeof field === "number" || typeof field === "boolean") {
      pairs.push(`${key}=${String(field)}`);
    }
  }
  if (pairs.length === 0) return undefined;
  const joined = pairs.join(" ");
  return joined.length <= DETAIL_LIMIT ? joined : `${joined.slice(0, DETAIL_LIMIT - 1)}…`;
}

function toolDetail(view: ToolView): string | undefined {
  const key = DETAIL_ARGS[view.toolName];
  if (key !== undefined) {
    const named = stringArg(view.args, key);
    if (named !== undefined) return named;
  }
  return primitiveSummary(view.args);
}

function textBody(text: string): ToolBody {
  return text.trim() === "" ? { kind: "none" } : { kind: "text", text };
}

export function toolViewOf(part: ToolTurnPart, live?: ToolLive): ToolView {
  return {
    toolName: part.toolName,
    args: part.args,
    ...(live === undefined ? {} : { live }),
    ...(part.result === undefined
      ? {}
      : {
          result: {
            output: part.result.output,
            isError: part.result.isError,
            ...(part.result.details === undefined ? {} : { details: part.result.details }),
            ...(part.result.title === undefined ? {} : { title: part.result.title }),
          },
        }),
  };
}

export function presentTool(view: ToolView): ToolPresentation {
  const { result } = view;
  const title = result?.title ?? view.live?.title;
  const detail = toolDetail(view);
  const base = {
    name: view.toolName,
    ...(title === undefined ? {} : { title }),
    ...(detail === undefined ? {} : { detail }),
  };
  if (result === undefined) {
    return { ...base, status: "running", body: textBody(view.live?.text ?? "") };
  }
  if (result.isError) {
    return { ...base, status: "failed", body: textBody(result.output) };
  }
  const patch = patchOf(result.details);
  if (patch !== undefined) {
    const path = patchedPath(patch);
    return {
      ...base,
      status: "done",
      body: { kind: "diff", patch, ...(path === undefined ? {} : { path }), ...diffStat(patch) },
    };
  }
  return { ...base, status: "done", body: textBody(result.output) };
}

export function presentCustomEntry(entry: CustomEntryView): CustomNote {
  const summary = primitiveSummary(entry.data);
  return {
    text: summary === undefined ? `[${entry.customType}]` : `[${entry.customType}] ${summary}`,
  };
}

export function createPresenter(options: PresenterOptions = {}): Presenter {
  const tools = options.tools ?? {};
  const custom = options.custom ?? {};
  return {
    tool(view) {
      const base = presentTool(view);
      const refine = tools[view.toolName];
      if (refine === undefined) return base;
      try {
        return refine(view, base);
      } catch {
        return base;
      }
    },
    custom(entry) {
      const base = presentCustomEntry(entry);
      const refine = custom[entry.customType];
      if (refine === undefined) return base;
      try {
        return refine(entry, base);
      } catch {
        return base;
      }
    },
  };
}
