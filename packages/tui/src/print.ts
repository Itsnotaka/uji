import process from "node:process";
import { WorkspaceTrustRequired, sessionId } from "@uji-ai/core";
import type { RunEnd, SessionId, SessionInfo, ThinkingLevel, Uji } from "@uji-ai/core";
import { shortId, toolHeading } from "./format.ts";
import type { RunFlags, ResumeTarget } from "./flags.ts";
import { hostFallbacks, openUji, resolveRuntime } from "./run.ts";
import { FileSettingsStore } from "./settings.ts";
import { createWorkspaceTrustStore } from "./workspace-trust.ts";

type PrintJsonEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; title: string }
  | { type: "result"; session: string; provider: string; kind: string }
  | { type: "error"; message: string };

export function encodePrintJson(event: PrintJsonEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function writeJson(event: PrintJsonEvent): void {
  process.stdout.write(encodePrintJson(event));
}

function writeHumanError(message: string, json: boolean): void {
  if (json) writeJson({ type: "error", message });
  else console.error(`error: ${message}`);
}

/** What print mode needs from the SDK; the full `Uji` satisfies it. */
export type PrintSdk = Pick<Uji, "watch" | "sessions" | "messages" | "runs">;

/** Everything one print run touches, composed once and handed around whole. */
interface PrintHost {
  readonly sdk: PrintSdk;
  readonly sessionId: SessionId;
  readonly provider: string;
}

/** A signal landed. Its conventional exit code rides as the abort reason. */
class PrintCancelled extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super("print run cancelled");
    this.name = "PrintCancelled";
    this.exitCode = exitCode;
  }
}

/**
 * One print run's cancellation. SIGINT and SIGTERM abort `signal` with a
 * `PrintCancelled` reason; `checkpoint()` throws it. Called before a mutation
 * starts, never mid-await, it keeps a cancelled run from starting anything
 * new while whatever was already in flight runs to its end.
 */
interface PrintLifetime {
  readonly signal: AbortSignal;
  checkpoint(): void;
  exitCode(): number | undefined;
  dispose(): void;
}

/** Runs before the first await of a print run, so no startup step outruns the handlers. */
export function printLifetime(): PrintLifetime {
  const controller = new AbortController();
  let code: number | undefined;
  const cancel = (next: number): void => {
    if (code !== undefined) return;
    code = next;
    controller.abort(new PrintCancelled(next));
  };
  const onSigint = (): void => cancel(130);
  const onSigterm = (): void => cancel(143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    signal: controller.signal,
    checkpoint: () => controller.signal.throwIfAborted(),
    exitCode: () => code,
    dispose: () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}

/** Human output: a streamed delta leaves the cursor mid-line until something ends it. */
interface OutputLine {
  mark(): void;
  finish(): void;
}

export function outputLine(): OutputLine {
  let pending = false;
  return {
    mark: () => {
      pending = true;
    },
    finish: () => {
      if (!pending) return;
      pending = false;
      process.stdout.write("\n");
    },
  };
}

/** The session a print run targets, chosen entirely through SDK verbs. */
async function targetSession(
  sdk: PrintSdk,
  target: ResumeTarget,
  lifetime: PrintLifetime,
): Promise<SessionInfo> {
  switch (target.kind) {
    case "new":
      lifetime.checkpoint();
      return sdk.sessions.create();
    case "latest": {
      // Skip sessions that were created by a launch and never written to.
      const { items } = await sdk.sessions.list();
      const used = [...items].reverse().find((info) => info.heads[0]?.entryId !== null);
      if (used !== undefined) return used;
      lifetime.checkpoint();
      return sdk.sessions.create();
    }
    case "session": {
      const info = await sdk.sessions.get({ sessionId: sessionId(target.id) });
      if (info === undefined) throw new Error(`Session not found: ${target.id}`);
      return info;
    }
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

/**
 * Stream the live half of a print run: text deltas as they arrive, one line
 * per tool call as its assistant entry commits.
 */
function streamOutput(
  host: PrintHost,
  signal: AbortSignal,
  flags: RunFlags,
  line: OutputLine,
): Promise<void> {
  return (async () => {
    for await (const event of host.sdk.watch({ sessionId: host.sessionId, live: true, signal })) {
      if (event.kind === "text_delta") {
        if (flags.json) writeJson({ type: "text", text: event.delta });
        else {
          process.stdout.write(event.delta);
          line.mark();
        }
        continue;
      }
      if (event.kind !== "message" || event.turn.kind !== "turn" || flags.quiet) continue;
      // A tool call announces on its assistant entry, before its result exists.
      for (const part of event.turn.parts) {
        if (part.kind !== "tool" || part.result !== undefined) continue;
        const title = toolHeading(part.toolName, undefined);
        if (flags.json) {
          writeJson({ type: "tool", name: part.toolName, title });
          continue;
        }
        line.finish();
        console.log(title);
      }
    }
  })();
}

/** The most recent run's terminal outcome, from a durable replay. */
async function lastRunEnd(host: PrintHost): Promise<RunEnd | undefined> {
  let end: RunEnd | undefined;
  for await (const event of host.sdk.watch({ sessionId: host.sessionId })) {
    if (event.kind === "synced") break;
    if (event.kind === "run_finished") end = event.outcome;
  }
  return end;
}

/** One run's inputs: what to declare on the branch, what to send, and what follows placement. */
interface RunPlan {
  readonly model?: { readonly provider: string; readonly id: string };
  readonly thinkingLevel?: ThinkingLevel;
  readonly content: string;
  /** Runs once the prompt is durable and the run is not cancelled. */
  readonly onPlaced?: () => void;
}

/**
 * Declare the run inputs, place the prompt, and follow the run to its end.
 * A checkpoint precedes every mutation, so a signal during one leaves the
 * next unstarted. The watcher, once started, is stopped before anything
 * awaits it, whether the run ended, a step failed, or a signal cancelled it.
 */
export async function followRun(
  host: PrintHost,
  plan: RunPlan,
  flags: RunFlags,
  lifetime: PrintLifetime,
  line: OutputLine,
): Promise<void> {
  const stop = new AbortController();
  let watcher: Promise<void> | undefined;
  try {
    if (plan.model !== undefined) {
      lifetime.checkpoint();
      await host.sdk.sessions.configure({ sessionId: host.sessionId, model: plan.model });
    }
    if (plan.thinkingLevel !== undefined) {
      lifetime.checkpoint();
      await host.sdk.sessions.configure({
        sessionId: host.sessionId,
        thinkingLevel: plan.thinkingLevel,
      });
    }
    lifetime.checkpoint();
    watcher = streamOutput(host, AbortSignal.any([lifetime.signal, stop.signal]), flags, line);
    await host.sdk.messages.send({ sessionId: host.sessionId, content: plan.content });
    // A signal during the send let it land, and the run was already asked to
    // stop; nothing else starts. A placed message cannot be un-placed, so
    // another attached host may still run it: the one residual.
    lifetime.checkpoint();
    plan.onPlaced?.();
    await host.sdk.runs.wait({ sessionId: host.sessionId, signal: lifetime.signal });
  } finally {
    stop.abort();
    await watcher?.catch(() => undefined);
    line.finish();
  }
}

/**
 * Report the run's durable outcome: the result or error event in JSON, the
 * summary or error line otherwise. A signal during the replay reports
 * nothing; the exit code alone says the run was interrupted.
 */
export async function reportRun(
  host: PrintHost,
  flags: RunFlags,
  lifetime: PrintLifetime,
): Promise<void> {
  const end = await lastRunEnd(host);
  lifetime.checkpoint();
  if (end === undefined || end.kind === "failed") {
    writeHumanError(
      end?.kind === "failed" ? end.error.message : "run did not complete",
      flags.json,
    );
    process.exitCode = 1;
    return;
  }
  if (flags.json) {
    writeJson({
      type: "result",
      session: host.sessionId,
      provider: host.provider,
      kind: end.kind,
    });
    return;
  }
  console.error(`session ${shortId(host.sessionId)} · ${host.provider} · ${end.kind}`);
  console.error("resume with: uji -p --resume");
}

/** Non-interactive run: stream deltas and tool lines, then exit. */
export async function runPrint(flags: RunFlags): Promise<void> {
  const lifetime = printLifetime();
  try {
    await printRun(flags, lifetime);
  } catch (error) {
    if (!(error instanceof PrintCancelled)) throw error;
  } finally {
    lifetime.dispose();
    const code = lifetime.exitCode();
    if (code !== undefined) process.exitCode = code;
  }
}

async function printRun(flags: RunFlags, lifetime: PrintLifetime): Promise<void> {
  const trustStore = createWorkspaceTrustStore();
  const workspace = await trustStore.require(process.cwd()).catch((error: unknown) => {
    if (error instanceof WorkspaceTrustRequired) {
      throw new Error(
        `Workspace is not trusted: ${error.cwd}. Run \`uji\` interactively to trust it first.`,
      );
    }
    throw error;
  });
  const settingsStore = new FileSettingsStore();
  const settings = await settingsStore.read(workspace.cwd);
  const runtime = await resolveRuntime(flags, settings);
  if (runtime === undefined) {
    throw new Error("Couldn't find a stored credential. Run `uji login`.");
  }
  // Everything above only read. Nothing below starts once a signal has landed.
  lifetime.checkpoint();
  const { model, thinkingLevel } = hostFallbacks(runtime, settings, flags);
  const { sdk, store } = await openUji({
    workspace,
    settings,
    runtime: () => runtime,
    model,
    thinkingLevel,
    report: (message) => process.stderr.write(`${message}\n`),
  });
  let detach: (() => void) | undefined;
  try {
    // A signal during openUji: no runner volunteers and nothing is written.
    lifetime.checkpoint();
    detach = sdk.attach();
    const target = await targetSession(sdk, flags.resume, lifetime);
    const host: PrintHost = { sdk, sessionId: target.sessionId, provider: runtime.provider.id };
    // From here a signal must also stop the run this host is about to start.
    // The checkpoint keeps the listener off a signal that has already fired.
    lifetime.checkpoint();
    lifetime.signal.addEventListener(
      "abort",
      () => {
        void host.sdk.runs.abort({ sessionId: host.sessionId }).catch(() => undefined);
      },
      { once: true },
    );
    // A model or effort named on the command line is an explicit choice worth
    // recording in the tree; settings-derived defaults stay fallbacks.
    const declaredModel: Pick<RunPlan, "model"> =
      flags.model !== undefined || process.env["UJI_MODEL"] !== undefined
        ? { model: { provider: host.provider, id: model.id } }
        : {};
    const declaredEffort: Pick<RunPlan, "thinkingLevel"> =
      flags.effort !== undefined ? { thinkingLevel } : {};
    await followRun(
      host,
      {
        ...declaredModel,
        ...declaredEffort,
        content: flags.rest.join(" "),
        onPlaced: () => {
          void settingsStore.updateGlobal({
            defaultProvider: host.provider,
            defaultModel: model.id,
            defaultThinkingLevel: thinkingLevel,
          });
        },
      },
      flags,
      lifetime,
      outputLine(),
    );

    // A signal during the run: the exit code says so, and nothing is reported.
    lifetime.checkpoint();
    await reportRun(host, flags, lifetime);
  } finally {
    detach?.();
    await sdk.close().catch(() => undefined);
    await store.close().catch(() => undefined);
  }
}
