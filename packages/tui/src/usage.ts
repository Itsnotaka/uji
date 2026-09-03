/**
 * The read model behind `/usage`: three facts that stay separate.
 *
 * - Durable workspace totals fold every session's entries.
 * - An in-progress operation is a live or interrupted run in this store; its
 *   usage is the sum of the `usage` records the run has committed, which the
 *   workspace total already contains. Nothing here estimates the open request.
 * - Subscription headroom is host memory. It joins the card and never enters
 *   the store.
 *
 * `usageCard` turns the three into strings, fills, and tones, so the panel
 * only paints.
 */
import {
  emptyUsageSummary,
  MAIN,
  mergeUsageSummaries,
  projectRunUsage,
  projectUsage,
  type UsageSummary,
} from "@uji-ai/core";
import type { AccountLimits } from "@uji-ai/ai";
import type { Usage } from "@uji-ai/schema";
import { GLYPHS } from "./constants.ts";
import { formatDuration, formatTokens } from "./format.ts";
import { truncateDisplay } from "./width.ts";
import type { SessionRepo } from "@uji-ai/core/store";

// ---------------------------------------------------------------------------
// Durable: runs and totals
// ---------------------------------------------------------------------------

type OperationKind = "run" | "compaction" | "navigation";

interface LiveRun {
  readonly sessionId: string;
  /** The session's name, else its id. */
  readonly label: string;
  /** The chat `/usage` was typed in. */
  readonly current: boolean;
  readonly operation: OperationKind;
  /** `interrupted`: the operation is open but no runner holds its claim. */
  readonly state: "live" | "interrupted";
  readonly startedAt: number;
  /** Sum of the run's committed `usage` records. Never the open request. */
  readonly usage: Usage;
}

export interface WorkspaceUsage {
  /** Current chat first, then oldest first. */
  readonly runs: readonly LiveRun[];
  /** Chats that recorded any usage. */
  readonly chats: number;
  readonly workspace: UsageSummary;
  /** The active chat's share, zero when it has no usage yet. */
  readonly current: UsageSummary;
}

/**
 * One read-only pass over the store. Reads the repo handle directly: SDK verbs
 * would pool every session and, under `attach()`, hand orphans a runner as a
 * side effect of looking.
 */
export async function collectWorkspaceUsage(
  repo: SessionRepo,
  currentSessionId: string,
): Promise<WorkspaceUsage> {
  let workspace = emptyUsageSummary();
  let current = emptyUsageSummary();
  const runs: LiveRun[] = [];
  let chats = 0;
  for (const { id } of await repo.list()) {
    const session = await repo.open(id);
    let summary: UsageSummary;
    try {
      const [entries, claim, open, name] = await Promise.all([
        session.findEntries(),
        session.getLiveClaim(MAIN),
        session.findOpenOperations(MAIN),
        session.getName(),
      ]);
      summary = projectUsage(entries);
      const started = open[0];
      if (started !== undefined) {
        runs.push({
          sessionId: id,
          label: name ?? id,
          current: id === currentSessionId,
          operation: started.intent.kind,
          state: claim?.runId === started.id ? "live" : "interrupted",
          startedAt: started.timestamp,
          usage: projectRunUsage(await session.findRecords({ type: "usage", runId: started.id })),
        });
      }
    } finally {
      await session.close().catch(() => undefined);
    }
    if (!hasUsage(summary.total)) continue;
    chats += 1;
    workspace = mergeUsageSummaries(workspace, summary);
    if (id === currentSessionId) current = summary;
  }
  runs.sort(
    (left, right) =>
      Number(right.current) - Number(left.current) || left.startedAt - right.startedAt,
  );
  return { runs, chats, workspace, current };
}

function hasUsage(usage: Usage): boolean {
  return usage.totalTokens > 0 || usage.cost.total > 0;
}

// ---------------------------------------------------------------------------
// Ephemeral: subscription headroom
// ---------------------------------------------------------------------------

/** Where a provider's limits come from; decides the copy for a missing value. */
type HeadroomSource = "fetched" | "observed";

interface HeadroomWindow {
  readonly label: string;
  readonly remainingPercent: number;
  readonly resetsAt?: number;
}

type Headroom =
  | {
      readonly kind: "known";
      readonly provider: string;
      readonly name: string;
      readonly source: HeadroomSource;
      readonly plan?: string;
      readonly observedAt: number;
      readonly windows: readonly [HeadroomWindow, ...HeadroomWindow[]];
    }
  | {
      readonly kind: "unknown";
      readonly provider: string;
      readonly name: string;
      readonly source: HeadroomSource;
    };

/** Providers with subscription windows. API-key providers have none. */
const HEADROOM_PROVIDERS: ReadonlyMap<string, { name: string; source: HeadroomSource }> = new Map([
  ["openai-codex", { name: "OpenAI Codex", source: "fetched" }],
  ["anthropic", { name: "Claude", source: "fetched" }],
]);

function windowLabel(window: AccountLimits["windows"][number]): string {
  if (window.id === "five_hour") return "5h";
  if (window.id === "seven_day") return "weekly";
  if (window.id === "seven_day_sonnet") return "weekly Sonnet";
  if (window.id === "seven_day_opus") return "weekly Opus";
  if (window.windowMinutes !== undefined && window.windowMinutes % 60 === 0) {
    return `${String(window.windowMinutes / 60)}h`;
  }
  return window.id.replaceAll("_", " ");
}

/**
 * One row per supported provider that is active or has cached limits, active
 * first. A provider without a value stays `unknown`; nothing here invents 0%.
 */
export function projectHeadroom(
  limits: readonly AccountLimits[],
  activeProvider: string,
): readonly Headroom[] {
  const byProvider = new Map(limits.map((value) => [value.providerId, value]));
  const providers = new Set([activeProvider, ...byProvider.keys()]);
  const rows: Headroom[] = [];
  for (const provider of providers) {
    const supported = HEADROOM_PROVIDERS.get(provider);
    if (supported === undefined) continue;
    const { name, source } = supported;
    const found = byProvider.get(provider);
    const [first, ...rest] = found?.windows ?? [];
    if (found === undefined || first === undefined) {
      rows.push({ kind: "unknown", provider, name, source });
      continue;
    }
    const toWindow = (window: AccountLimits["windows"][number]): HeadroomWindow => ({
      label: windowLabel(window),
      remainingPercent: Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent))),
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    });
    rows.push({
      kind: "known",
      provider,
      name,
      source,
      ...(found.plan === undefined ? {} : { plan: found.plan }),
      observedAt: found.observedAt,
      windows: [toWindow(first), ...rest.map(toWindow)],
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The card: strings, fills, tones
// ---------------------------------------------------------------------------

/** Cells in a bar. */
export const USAGE_BAR_CELLS = 20;

/** Limits older than this are shown with their age and a warning tone. */
const STALE_AFTER_MS = 15 * 60_000;

/** In-progress rows shown before the rest collapse into a count. */
const MAX_RUN_ROWS = 5;

/** Longest label before the model id is truncated to protect the columns. */
const LABEL_CELLS = 24;

export type Tone = "ok" | "warning" | "critical";

export interface RunCardRow {
  readonly state: LiveRun["state"];
  readonly label: string;
  /** Operation and elapsed time for a live run, else `interrupted`. */
  readonly detail: string;
  /** Committed tokens and cost. */
  readonly usage: string;
}

type RunsCard =
  | { readonly kind: "none" }
  | {
      readonly kind: "runs";
      readonly summary: string;
      readonly rows: readonly [RunCardRow, ...RunCardRow[]];
      readonly more?: string;
      readonly note: string;
    };

interface HeadroomWindowRow {
  readonly label: string;
  readonly share: number;
  readonly tone: Tone;
  readonly remaining: string;
  readonly reset: string;
}

type HeadroomCardRow =
  | {
      readonly kind: "known";
      readonly name: string;
      readonly meta: string;
      readonly stale: boolean;
      readonly windows: readonly [HeadroomWindowRow, ...HeadroomWindowRow[]];
    }
  | {
      readonly kind: "unknown";
      readonly name: string;
      readonly meta: string;
    };

type HeadroomCard =
  | { readonly kind: "none" }
  | {
      readonly kind: "providers";
      readonly summary: string;
      readonly rows: readonly [HeadroomCardRow, ...HeadroomCardRow[]];
    };

export interface UsageCardRow {
  readonly label: string;
  /** Compaction and tool buckets, rendered dim: spend without a model id. */
  readonly system: boolean;
  /** This row's share of the costliest row, or busiest when every cost is zero. */
  readonly share: number;
  /** Padded to the card's cost column. */
  readonly cost: string;
  /** Padded to the card's token column. */
  readonly tokens: string;
}

type WorkspaceUsageCard =
  | { readonly kind: "empty"; readonly title: string; readonly message: string }
  | {
      readonly kind: "usage";
      readonly title: string;
      readonly total: string;
      readonly rows: readonly [UsageCardRow, ...UsageCardRow[]];
      readonly breakdown: readonly [string, ...string[]];
      readonly thisChat?: string;
    };

export interface UsageCard {
  readonly runs: RunsCard;
  readonly headroom: HeadroomCard;
  readonly workspace: WorkspaceUsageCard;
}

interface UsageCardOptions {
  readonly activeProvider: string;
  /** A limits fetch is in flight; fetched-source rows say so. */
  readonly refreshing: boolean;
  readonly now?: number;
}

function formatCost(cost: number): string {
  if (cost === 0 || cost >= 0.01) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
}

function elapsedLabel(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes === 0) return "now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  return `${String(Math.floor(minutes / 60))}h ago`;
}

function ageLabel(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 60) return `${String(minutes)}m`;
  return `${String(Math.floor(minutes / 60))}h`;
}

function resetLabel(timestamp: number | undefined, now: number): string {
  if (timestamp === undefined) return "reset unknown";
  const minutes = Math.max(0, Math.ceil((timestamp - now) / 60_000));
  if (minutes < 60) return `resets in ${String(minutes)}m`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0
      ? `resets in ${String(hours)}h`
      : `resets in ${String(hours)}h ${String(rest)}m`;
  }
  return `resets ${new Date(timestamp).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function count(value: number, noun: string): string {
  return `${String(value)} ${noun}${value === 1 ? "" : "s"}`;
}

function runsCard(runs: readonly LiveRun[], now: number): RunsCard {
  const [first, ...rest] = runs.slice(0, MAX_RUN_ROWS).map((run): RunCardRow => ({
    state: run.state,
    label: run.current ? "this chat" : run.label,
    detail:
      run.state === "live"
        ? `${run.operation} · ${formatDuration(Math.max(0, now - run.startedAt))}`
        : "interrupted",
    usage: `${formatTokens(run.usage.totalTokens)} · ${formatCost(run.usage.cost.total)}`,
  }));
  if (first === undefined) return { kind: "none" };
  const live = runs.filter((run) => run.state === "live").length;
  const interrupted = runs.length - live;
  const summary = [
    ...(live > 0 ? [`${String(live)} running`] : []),
    ...(interrupted > 0 ? [`${String(interrupted)} interrupted`] : []),
  ].join(" · ");
  const hidden = runs.length - MAX_RUN_ROWS;
  return {
    kind: "runs",
    summary,
    rows: [first, ...rest],
    ...(hidden > 0 ? { more: `+${String(hidden)} more` } : {}),
    note: "committed below · open requests excluded",
  };
}

function headroomRow(
  headroom: Headroom,
  options: { refreshing: boolean; now: number },
): HeadroomCardRow {
  const { refreshing, now } = options;
  if (headroom.kind === "unknown") {
    return {
      kind: "unknown",
      name: headroom.name,
      meta:
        headroom.source === "fetched"
          ? refreshing
            ? "checking…"
            : "not available"
          : "available after a Claude turn",
    };
  }
  const stale = now - headroom.observedAt > STALE_AFTER_MS;
  const plan =
    headroom.plan === undefined
      ? undefined
      : headroom.plan.charAt(0).toUpperCase() + headroom.plan.slice(1);
  const observation =
    refreshing && headroom.source === "fetched" && stale
      ? `checking · ${ageLabel(headroom.observedAt, now)} old`
      : `${headroom.source} ${elapsedLabel(headroom.observedAt, now)}`;
  return {
    kind: "known",
    name: headroom.name,
    meta: plan === undefined ? observation : `${plan} · ${observation}`,
    stale,
    windows: [
      headroomWindowRow(headroom.windows[0], now),
      ...headroom.windows.slice(1).map((window) => headroomWindowRow(window, now)),
    ],
  };
}

function headroomWindowRow(window: HeadroomWindow, now: number): HeadroomWindowRow {
  const { remainingPercent } = window;
  return {
    label: window.label.padEnd(7),
    share: remainingPercent / 100,
    tone: remainingPercent <= 5 ? "critical" : remainingPercent <= 15 ? "warning" : "ok",
    remaining: `${String(remainingPercent)}%`.padStart(4),
    reset: resetLabel(window.resetsAt, now),
  };
}

function headroomCard(
  rows: readonly Headroom[],
  options: { refreshing: boolean; now: number },
): HeadroomCard {
  const [first, ...rest] = rows.map((row) => headroomRow(row, options));
  if (first === undefined) return { kind: "none" };
  const all = [first, ...rest];
  const known = all.filter((row) => row.kind === "known");
  const stale = known.filter((row) => row.stale).length;
  const summary = [
    known.length === all.length
      ? count(all.length, "provider")
      : `${String(known.length)} of ${String(all.length)} known`,
    ...(stale > 0 ? [`${String(stale)} stale`] : []),
  ].join(" · ");
  return { kind: "providers", summary, rows: [first, ...rest] };
}

interface RawRow {
  readonly label: string;
  readonly system: boolean;
  readonly usage: Usage;
}

/**
 * Bars answer "where did the money go"; when nothing cost anything (free or
 * subscription-priced models) they fall back to "where did the tokens go".
 */
function shares(rows: readonly RawRow[]): number[] {
  const measure: (row: RawRow) => number = rows.some((row) => row.usage.cost.total > 0)
    ? (row) => row.usage.cost.total
    : (row) => row.usage.totalTokens;
  const top = Math.max(...rows.map(measure));
  if (top <= 0) return rows.map(() => 0);
  return rows.map((row) => measure(row) / top);
}

function breakdownLines(total: Usage): readonly [string, ...string[]] {
  const primary = `input ${formatTokens(total.input)} · output ${formatTokens(total.output)}`;
  const cache: string[] = [];
  if (total.cacheRead > 0) cache.push(`cache read ${formatTokens(total.cacheRead)}`);
  if (total.cacheWrite > 0) cache.push(`cache write ${formatTokens(total.cacheWrite)}`);
  return cache.length === 0 ? [primary] : [primary, cache.join(" · ")];
}

function workspaceCard(report: WorkspaceUsage): WorkspaceUsageCard {
  const { chats, workspace, current } = report;
  if (chats === 0) return { kind: "empty", title: "workspace", message: "No usage recorded" };

  const raw: RawRow[] = workspace.models.map((row) => ({
    label: truncateDisplay(row.model, LABEL_CELLS, GLYPHS.ellipsis),
    system: false,
    usage: row.usage,
  }));
  if (hasUsage(workspace.compaction)) {
    raw.push({ label: "compaction", system: true, usage: workspace.compaction });
  }
  if (hasUsage(workspace.tools)) raw.push({ label: "tools", system: true, usage: workspace.tools });
  const [first, ...rest] = raw;
  if (first === undefined)
    return { kind: "empty", title: "workspace", message: "No usage recorded" };

  const costs = raw.map((row) => formatCost(row.usage.cost.total));
  const tokens = raw.map((row) => formatTokens(row.usage.totalTokens));
  const costWidth = Math.max(...costs.map((cost) => cost.length));
  const tokenWidth = Math.max(...tokens.map((value) => value.length));
  const rowShares = shares(raw);

  const toRow = (row: RawRow, index: number): UsageCardRow => ({
    label: row.label,
    system: row.system,
    share: rowShares[index] ?? 0,
    cost: (costs[index] ?? "").padStart(costWidth),
    tokens: (tokens[index] ?? "").padStart(tokenWidth),
  });

  return {
    kind: "usage",
    title: `workspace · ${count(chats, "chat")}`,
    total: formatCost(workspace.total.cost.total),
    rows: [toRow(first, 0), ...rest.map((row, index) => toRow(row, index + 1))],
    breakdown: breakdownLines(workspace.total),
    ...(chats > 1 && hasUsage(current.total)
      ? {
          thisChat: `this chat · ${formatTokens(current.total.totalTokens)} tokens · ${formatCost(current.total.cost.total)}`,
        }
      : {}),
  };
}

/** Join in-progress runs, account headroom, and workspace totals into one card. */
export function usageCard(
  report: WorkspaceUsage,
  limits: readonly AccountLimits[],
  options: UsageCardOptions,
): UsageCard {
  const now = options.now ?? Date.now();
  const { refreshing } = options;
  return {
    runs: runsCard(report.runs, now),
    headroom: headroomCard(projectHeadroom(limits, options.activeProvider), { refreshing, now }),
    workspace: workspaceCard(report),
  };
}
