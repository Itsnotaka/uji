/**
 * `createUji` composes the durable store, the provider stream, and the plugin
 * set into the namespaces a client calls. It owns no conversation logic of its
 * own: every verb here delegates to the store or to the session's harness and
 * reshapes the result into the flat, wire-shaped types in `./types.ts`.
 *
 * One `Uji` covers every session in its store. Sessions open lazily and stay
 * pooled until `close`; a harness is built only when a verb needs the plugin
 * set or a run, so listing a transcript never activates a plugin.
 *
 * Argued in the design record: `packages/docs/content/docs/design.mdx`, "The SDK".
 */
import { AgentHarness } from "../harness/agent-harness.ts";
import { readSessionConfig } from "../harness/session/context.ts";
import { hasWakeInput } from "../harness/session/run-state.ts";
import { isJsonObject, newId, SessionError } from "../harness/session/types.ts";
import type { Entry, JsonValue, LogItem, SessionStorage } from "../harness/session/types.ts";
import { changesFromTurns } from "../views/changes.ts";
import { projectContextStatus } from "../views/context.ts";
import { transcriptFromEntries, type Turn } from "../views/transcript.ts";
import {
  deriveTaskId,
  subagentsPlugin,
  TASK_SETTLED_CUSTOM_TYPE,
  type SubagentHost,
} from "../plugins/builtin/subagents.ts";
import {
  inlinePlugin,
  type LoadedPlugin,
  type PluginInfo,
  type SettingInfo,
} from "../plugins/types.ts";
import { durableEvent } from "./events.ts";
import { headLeaves, PARENT_FACT, pendingItemsFromLog, sessionInfoFromLog } from "./snapshot.ts";
import {
  MAIN,
  sessionId,
  UjiClosed,
  UnknownSession,
  type ApplyOutcome,
  type AttachOptions,
  type CommandInfo,
  type CommandOutcome,
  type Disposer,
  type HeadInfo,
  type HeadName,
  type ModelInfo,
  type MoveOutcome,
  type PendingItem,
  type RunInfo,
  type SendInput,
  type SendReceipt,
  type SessionEvent,
  type SessionId,
  type SessionInfo,
  type SessionParent,
  type Uji,
  type UjiOptions,
  type WaitOutcome,
} from "./types.ts";

interface Pooled {
  readonly id: SessionId;
  readonly storage: SessionStorage;
  harness?: AgentHarness;
  /** The creation in flight, so concurrent openers share one harness. */
  opening?: Promise<AgentHarness>;
  /** This process's runner loop for the session; present exactly while an attachment covers it. */
  runner?: Disposer;
  /** Runner reconciliations run one at a time per session; each chains onto the last. */
  reconciling: Promise<void>;
  /** Set by `delete`: no attachment may hand this session a runner again. */
  retired: boolean;
}

/** One `attach()` call. Its disposer withdraws exactly this and nothing else. */
interface Attachment {
  readonly sessions?: ReadonlySet<SessionId>;
}

export async function createUji(options: UjiOptions): Promise<Uji> {
  const pool = new Map<SessionId, Pooled>();
  const attachments = new Set<Attachment>();
  /** Failures of background work that had no caller to reject; `close` reports them. */
  const background: unknown[] = [];
  let plugins = options.plugins;
  let closed = false;

  const alive = (): void => {
    if (closed) throw new UjiClosed();
  };

  /** Whether some live attachment covers the session right now. */
  const wantsRunner = (id: SessionId, pooled: Pooled): boolean =>
    !closed &&
    !pooled.retired &&
    [...attachments].some(
      (attachment) => attachment.sessions === undefined || attachment.sessions.has(id),
    );

  /**
   * Make the session's runner match the attachment set. Serialized per
   * session so two callers cannot both see no runner and volunteer two loops;
   * the desired state is re-read after every await, since an attachment may
   * have been withdrawn while the harness opened.
   */
  const reconcileRunner = (id: SessionId, pooled: Pooled): Promise<void> => {
    const run = pooled.reconciling.then(async () => {
      if (wantsRunner(id, pooled) === (pooled.runner !== undefined)) return;
      if (pooled.runner !== undefined) {
        pooled.runner();
        pooled.runner = undefined;
        return;
      }
      const harness = await harnessFor(pooled);
      if (!wantsRunner(id, pooled)) return;
      pooled.runner = harness.attach();
    });
    pooled.reconciling = run.catch(() => undefined);
    return run;
  };

  /**
   * Pool a storage handle this Uji just opened and give it a runner if one is
   * wanted. The caller passed `alive()` before `store.open` awaited, so close
   * or a concurrent open of the same id may have landed since; a handle that
   * loses either race is closed here rather than leaked or pooled twice.
   */
  const adopt = async (id: SessionId, storage: SessionStorage): Promise<Pooled> => {
    const existing = pool.get(id);
    if (closed || existing !== undefined) {
      await storage.close().catch(() => undefined);
      if (closed || existing === undefined) throw new UjiClosed();
      if (existing.retired) throw new UnknownSession(id);
      return existing;
    }
    const pooled: Pooled = { id, storage, reconciling: Promise.resolve(), retired: false };
    pool.set(id, pooled);
    await reconcileRunner(id, pooled);
    return pooled;
  };

  const openStorage = async (id: SessionId): Promise<Pooled> => {
    alive();
    const pooled = pool.get(id);
    if (pooled !== undefined) {
      // Retired means a delete is in progress: the id is gone for every other verb.
      if (pooled.retired) throw new UnknownSession(id);
      return pooled;
    }
    let storage: SessionStorage;
    try {
      storage = await options.store.open(id);
    } catch {
      throw new UnknownSession(id);
    }
    return adopt(id, storage);
  };

  /** Resolve a branch-config ref against the catalog; no provider matches by id alone. */
  const resolveModelRef = (ref: { provider?: string; id: string }) =>
    ref.provider !== undefined
      ? options.models.getModel(ref.provider, ref.id)
      : options.models.getModels().find((candidate) => candidate.id === ref.id);

  /**
   * The session's harness, built on first need. Concurrent callers share the
   * build in flight; a build that fails is forgotten so the next caller
   * retries; a build that finishes after `close` or `delete` is closed here
   * and reported as `UjiClosed` or `UnknownSession`, so nothing owns a harness
   * the pool will never close.
   *
   * The caller checked `alive()` and `retired` before an await; either may
   * have flipped since. A closed Uji refuses outright. A retired session
   * refuses only a new build: `delete` closes an existing harness after the
   * run it drives has settled, so a verb that already found one may still
   * observe that settlement, and starting a build for a session being deleted
   * is the waste this guard exists to stop.
   */
  const harnessFor = (pooled: Pooled): Promise<AgentHarness> => {
    if (closed) return Promise.reject(new UjiClosed());
    if (pooled.harness !== undefined) return Promise.resolve(pooled.harness);
    if (pooled.opening !== undefined) return pooled.opening;
    if (pooled.retired) return Promise.reject(new UnknownSession(pooled.id));
    const opening = projectSession(pooled.storage)
      .then(({ parent }) => {
        // A child session's terminal record wakes its parent. Wired on the
        // harness because whichever process drives the child holds one.
        const notify = (): void => {
          if (parent === undefined) return;
          void notifyParentOfChild(pooled, parent).catch((error: unknown) =>
            background.push(error),
          );
        };
        return AgentHarness.create({
          session: pooled.storage,
          streamFn: options.streamFn,
          plugins: composePlugins(pooled, parent),
          env: options.env,
          model: options.model,
          resolveModel: resolveModelRef,
          thinkingLevel: options.thinkingLevel,
          compaction: options.compaction,
          streamOptions: options.streamOptions,
          onRunEnd: notify,
        }).then((harness) => ({ harness, notify }));
      })
      .then(async ({ harness, notify }) => {
        if (closed || pooled.retired) {
          await harness.close().catch((error: unknown) => background.push(error));
          throw closed ? new UjiClosed() : new UnknownSession(pooled.id);
        }
        pooled.harness = harness;
        // Run once cold for a crash between the child's finish and the nudge.
        notify();
        return harness;
      })
      .finally(() => {
        // Only this build clears its own slot; a newer one is left alone.
        if (pooled.opening === opening) pooled.opening = undefined;
      });
    pooled.opening = opening;
    return opening;
  };

  const openHarness = async (id: SessionId): Promise<AgentHarness> =>
    harnessFor(await openStorage(id));

  const headsFor = async (storage: SessionStorage, log: readonly LogItem[]): Promise<HeadInfo[]> =>
    Promise.all(
      [...headLeaves(log)]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(async ([name, entryId]) => ({ name, entryId, run: await currentRun(storage, name) })),
    );

  const projectSession = async (storage: SessionStorage): Promise<SessionInfo> => {
    const [metadata, log, mainBranch] = await Promise.all([
      storage.getMetadata(),
      storage.getLog(),
      storage.getBranch(MAIN),
    ]);
    return sessionInfoFromLog({ metadata, log, heads: await headsFor(storage, log), mainBranch });
  };

  /**
   * Resolves when the head is idle (no live claim, no open operation, no
   * placed input awaiting a runner) or when its open run has parked on
   * waiting calls with no wake input pending: waiting further would hang on
   * a run that deliberately waits for the caller. A send that landed a moment
   * ago must not read as "already done" merely because no runner has claimed
   * it yet. With no attached host, idle may never arrive, which is honest:
   * ensuring a run exists is host territory, not this helper's.
   */
  const awaitHeadIdle = async (
    storage: SessionStorage,
    head: HeadName,
    signal?: AbortSignal,
  ): Promise<WaitOutcome> => {
    // Folded once from the log, then advanced by each watched item.
    let lastOperation = -1;
    let lastPlacement = -1;
    const observe = (item: LogItem): void => {
      if (
        item.kind === "record" &&
        (item.record.type === "operation_started" || item.record.type === "operation_finished")
      ) {
        lastOperation = item.seq;
      }
      if (
        item.kind === "entry" &&
        item.head === head &&
        item.entry.type === "message" &&
        item.entry.message.role === "user"
      ) {
        lastPlacement = item.seq;
      }
    };
    const status = async (): Promise<WaitOutcome | undefined> => {
      if ((await storage.getLiveClaim(head)) !== undefined) return undefined;
      const open = (await storage.findOpenOperations(head))[0];
      if (open !== undefined) {
        const state = await storage.runState(open.id);
        if (state.kind === "running" && state.waitingCalls.length > 0 && !hasWakeInput(state)) {
          return { kind: "waiting", runId: open.id };
        }
        return undefined;
      }
      return lastPlacement <= lastOperation ? { kind: "idle" } : undefined;
    };
    const log = await storage.getLog();
    for (const item of log) observe(item);
    const initial = await status();
    if (initial !== undefined) return initial;
    for await (const item of storage.watch({ afterSeq: log.at(-1)?.seq ?? -1, signal })) {
      observe(item);
      const outcome = await status();
      if (outcome !== undefined) return outcome;
    }
    return { kind: "idle" };
  };

  const lastAssistantText = (turns: readonly Turn[]): string | undefined => {
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index];
      if (turn?.kind !== "turn") continue;
      const text = turn.parts
        .flatMap((part) => (part.kind === "assistant" ? [part.text] : []))
        .join("\n")
        .trim();
      if (text !== "") return text;
    }
    return undefined;
  };

  /**
   * A child session's terminal run outcome, or undefined while it still runs
   * (or parked waiting, which reads as running: a deeper wait is the
   * child's own business until it settles).
   */
  const childRunOutcome = async (
    storage: SessionStorage,
  ): Promise<"completed" | "aborted" | "failed" | undefined> => {
    let outcome: "completed" | "aborted" | "failed" | undefined;
    const startedRuns = new Set<string>();
    for (const item of await storage.getLog()) {
      if (item.kind !== "record") continue;
      if (item.record.type === "operation_started" && item.record.intent.kind === "run") {
        startedRuns.add(item.record.id);
      }
      if (item.record.type === "operation_finished" && startedRuns.has(item.record.runId)) {
        outcome = item.record.outcome;
      }
    }
    return outcome;
  };

  /** Pool-scoped volunteer runners for spawned children, one per child. */
  const childAttachments = new Map<SessionId, Attachment>();

  const ensureChildRunner = async (childId: SessionId, pooled: Pooled): Promise<void> => {
    if (!childAttachments.has(childId)) {
      const attachment: Attachment = { sessions: new Set([childId]) };
      childAttachments.set(childId, attachment);
      attachments.add(attachment);
    }
    await reconcileRunner(childId, pooled);
  };

  const releaseChildRunner = async (childId: SessionId): Promise<void> => {
    const attachment = childAttachments.get(childId);
    if (attachment === undefined) return;
    childAttachments.delete(childId);
    attachments.delete(attachment);
    const pooled = pool.get(childId);
    if (pooled !== undefined) await reconcileRunner(childId, pooled).catch(() => undefined);
  };

  /**
   * The completion nudge, decided by the durable state of the parent's own
   * call, which is what makes retries idempotent. A still-waiting call gets
   * a model-invisible custom entry: deferred admission is exactly the wake
   * input the attach predicate watches for, and the wake reads the child's
   * log, so the nudge needs no content. A call the parent settled as
   * `running` was a deliberate background task, so the completion is real
   * delivery: a message carrying the child's answer, idempotent under its
   * derived send key. A call already settled terminally needs nothing, which
   * is what keeps aborted and re-notified tasks out of the transcript.
   */
  const notifyParentOfChild = async (pooled: Pooled, link: SessionParent): Promise<void> => {
    const outcome = await childRunOutcome(pooled.storage);
    if (outcome === undefined) return;
    let parent: Pooled;
    try {
      parent = await openStorage(link.sessionId);
    } catch (error) {
      if (!(error instanceof UnknownSession)) throw error;
      // The parent is gone; the child is its own session now.
      await releaseChildRunner(pooled.id);
      return;
    }
    const intents = await parent.storage.findRecords({
      type: "tool_started",
      runId: link.runId,
    });
    const intent = intents.find((candidate) => candidate.toolCallId === link.callId);
    const settlement =
      intent === undefined ? undefined : await parent.storage.getEntry(intent.resultEntryId);
    if (intent !== undefined && settlement === undefined) {
      // Foreground, still parked: nudge by admission alone.
      try {
        await parent.storage.admitEntry(
          {
            type: "custom",
            id: deriveTaskId("e", pooled.id, "wake"),
            customType: TASK_SETTLED_CUSTOM_TYPE,
            data: { childSessionId: pooled.id, state: outcome },
          },
          MAIN,
        );
      } catch (error) {
        // Already nudged (the id is derived), including by another process.
        if (!(error instanceof SessionError) || error.code !== "invalid_entry") throw error;
      }
    } else if (settlement !== undefined && backgroundTaskSettled(settlement)) {
      const text = lastAssistantText(transcriptFromEntries(await pooled.storage.getBranch(MAIN)));
      await parent.storage.send(
        {
          role: "user",
          content:
            `Task ${link.agent} ${outcome} in session ${pooled.id}.` +
            (text === undefined ? "" : `\n\n${text}`),
          timestamp: Date.now(),
        },
        {
          head: MAIN,
          idempotencyKey: deriveTaskId("e", pooled.id, "wake"),
          origin: { clientId: "subagents" },
        },
      );
    }
    await releaseChildRunner(pooled.id);
  };

  /**
   * Whether the parent settled this call as a deliberate background task:
   * `execute` settles those immediately with `state: "running"`, so the
   * settlement itself says the completion should arrive as a message.
   */
  const backgroundTaskSettled = (settlement: Entry): boolean => {
    if (settlement.type !== "message" || settlement.message.role !== "toolResult") return false;
    // SAFETY: entry payloads cross toJsonValue at write; only pi's ported schema type is looser.
    const details = settlement.message.details as JsonValue | undefined;
    return isJsonObject(details) && details["state"] === "running";
  };

  /**
   * The `task` tool's host wiring (design.mdx, "Subagents are child
   * sessions"). Every id derives from the (parent session, parent run, tool
   * call) triple, so a retried spawn converges on the same child and a wake
   * on any host finds it again from durable state alone. Foreground is
   * background plus a wait: `spawn` only admits, `poll` reads the
   * child's outcome, and the completion nudge above carries the wake.
   */
  const subagentHostFor = (parentId: SessionId): SubagentHost => {
    const childFor = (call: { runId: string; toolCallId: string }): SessionId =>
      sessionId(deriveTaskId("s", parentId, call.runId, call.toolCallId));
    return {
      async spawn(request) {
        const parent = await openStorage(parentId);
        // The tool executes under the live claim; v1 assumes the run is on main.
        const claim = await parent.storage.getLiveClaim(MAIN);
        const runId = claim?.runId ?? "unclaimed";
        const childId = childFor({ runId, toolCallId: request.toolCallId });
        const link = {
          sessionId: parentId,
          runId,
          callId: request.toolCallId,
          agent: request.agent,
          depth: ((await projectSession(parent.storage)).parent?.depth ?? 0) + 1,
        };
        // The spawn refuses depth beyond 1 no matter what catalog the caller
        // held: composition omits `task` for children, and this guard makes the
        // ceiling hold even against a stale or mid-crash composition, because
        // the alternative is unbounded recursion (design.mdx, "Agents").
        if (link.depth > 1) {
          return {
            details: { agent: request.agent, childSessionId: childId, state: "failed" },
            text: "Delegation depth is 1: a subagent cannot delegate further.",
          };
        }
        const child = await openStorage(childId).catch(async (error: unknown) => {
          if (!(error instanceof UnknownSession)) throw error;
          let created: SessionStorage;
          try {
            created = await options.store.create({ id: childId });
          } catch {
            // Lost the create race to a twin retry; the twin's child is ours.
            return openStorage(childId);
          }
          // The link lands before `adopt`, because adopting builds the harness
          // and composition reads the link to withhold `task` from children. A
          // child composed before its link would be a root with a spawn of its
          // own, which is the recursion the depth guard above refuses.
          await created.setFact(PARENT_FACT, link);
          return adopt(sessionId((await created.getMetadata()).id), created);
        });
        // Repair for a crash that split create from link on a retried spawn.
        if ((await projectSession(child.storage)).parent === undefined) {
          await child.storage.setFact(PARENT_FACT, link);
        }
        const agentEntryId = deriveTaskId("e", childId, "agent");
        const log = await child.storage.getLog();
        if (!log.some((item) => item.kind === "entry" && item.entry.id === agentEntryId)) {
          await child.storage.admitEntry({
            type: "agent_change",
            id: agentEntryId,
            agentId: request.agent,
          });
        }
        await child.storage.send(request.prompt, {
          head: MAIN,
          idempotencyKey: deriveTaskId("e", childId, "prompt"),
        });
        // The child runs on its own: a pool-scoped attachment volunteers this
        // process until the completion nudge releases it. Another host that
        // attaches can win the child's claim instead; both are fine.
        await ensureChildRunner(childId, child);
        return {
          details: { agent: request.agent, childSessionId: childId, state: "running" },
        };
      },
      async poll(call) {
        const childId = childFor(call);
        let child: Pooled;
        try {
          child = await openStorage(childId);
        } catch (error) {
          if (!(error instanceof UnknownSession)) throw error;
          return {
            details: { agent: "unknown", childSessionId: childId, state: "failed" },
            text: "The child session no longer exists.",
          };
        }
        const agent = (await projectSession(child.storage)).parent?.agent ?? "unknown";
        const outcome = await childRunOutcome(child.storage);
        if (outcome === undefined) {
          return { details: { agent, childSessionId: childId, state: "running" } };
        }
        const text = lastAssistantText(transcriptFromEntries(await child.storage.getBranch(MAIN)));
        return {
          details: { agent, childSessionId: childId, state: outcome },
          ...(text === undefined ? {} : { text }),
        };
      },
      async abort(call) {
        try {
          await (await openStorage(childFor(call))).storage.requestAbort(MAIN);
        } catch (error) {
          if (!(error instanceof UnknownSession)) throw error;
        }
      },
    };
  };

  /**
   * The per-session plugin set: the host's list plus the SDK's subagents
   * builtin wired to this composition's spawn. A child session's set omits
   * it, which is the depth-1 default (design.mdx, "Agents"): a subagent
   * cannot delegate further.
   */
  const composePlugins = (
    pooled: Pooled,
    parent: SessionParent | undefined,
  ): readonly LoadedPlugin[] =>
    parent !== undefined
      ? plugins
      : [...plugins, inlinePlugin(subagentsPlugin({ host: subagentHostFor(pooled.id) }))];

  /** The one fold of live / waiting / orphaned; every verb and every `HeadInfo` reads it. */
  const currentRun = async (
    storage: SessionStorage,
    head: HeadName,
  ): Promise<RunInfo | undefined> => {
    const [claim, open] = await Promise.all([
      storage.getLiveClaim(head),
      storage.findOpenOperations(head),
    ]);
    const started = open[0];
    if (claim !== undefined) {
      return {
        kind: "live",
        runId: claim.runId,
        head,
        startedAt: started?.timestamp ?? 0,
        claim: { ownerId: claim.ownerId, expiresAt: claim.expiresAtMs },
      };
    }
    // An open operation with no claim is parked on purpose (waiting) or
    // outlived the process that started it (orphaned).
    if (started === undefined) return undefined;
    const state = await storage.runState(started.id);
    if (state.kind === "running" && state.waitingCalls.length > 0) {
      return { kind: "waiting", runId: started.id, head, startedAt: started.timestamp };
    }
    // An operation record is written under a claim, so one lapsed; the
    // start-time fallback only keeps the function total.
    return {
      kind: "orphaned",
      runId: started.id,
      head,
      startedAt: started.timestamp,
      expiredAt:
        (state.kind === "missing" ? undefined : state.lastClaimExpiresAt) ?? started.timestamp,
    };
  };

  // Composing a Uji over a workspace is opening it: record `env.cwd` so every
  // client's picker reads one registry instead of hand-rolling a recents file.
  await options.workspaces?.touch(options.env.cwd);

  return {
    sessions: {
      async create(input = {}) {
        alive();
        const storage = await options.store.create(
          input.sessionId === undefined ? {} : { id: input.sessionId },
        );
        if (input.name !== undefined) await storage.setName(input.name);
        const { parent } = input;
        if (parent !== undefined) {
          // Written before any admission, so the link exists before the child
          // can run and a crashed spawn retried finds it already durable.
          await storage.setFact(PARENT_FACT, {
            sessionId: parent.sessionId,
            runId: parent.runId,
            callId: parent.callId,
            agent: parent.agent,
            depth: parent.depth,
          });
        }
        await adopt(sessionId((await storage.getMetadata()).id), storage);
        return projectSession(storage);
      },
      async get(input) {
        alive();
        try {
          return await projectSession((await openStorage(input.sessionId)).storage);
        } catch (error) {
          if (error instanceof UnknownSession) return undefined;
          throw error;
        }
      },
      async snapshot(input) {
        alive();
        try {
          const { storage } = await openStorage(input.sessionId);
          const head = input.head ?? MAIN;
          const [metadata, log, branch, mainBranch] = await Promise.all([
            storage.getMetadata(),
            storage.getLog(),
            storage.getBranch(head),
            head === MAIN ? undefined : storage.getBranch(MAIN),
          ]);
          const declared = readSessionConfig(branch).model;
          const model =
            declared === undefined ? options.model : (resolveModelRef(declared) ?? options.model);
          return {
            seq: log.at(-1)?.seq ?? -1,
            session: sessionInfoFromLog({
              metadata,
              log,
              heads: await headsFor(storage, log),
              mainBranch: mainBranch ?? branch,
            }),
            transcript: transcriptFromEntries(branch),
            pending: pendingItemsFromLog(log),
            context: projectContextStatus(branch, model.contextWindow),
          };
        } catch (error) {
          if (error instanceof UnknownSession) return undefined;
          throw error;
        }
      },
      async list(input = {}) {
        alive();
        const all = await options.store.list();
        const start = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10);
        const limit = input.limit ?? all.length;
        const items: SessionInfo[] = [];
        let index = Number.isNaN(start) ? 0 : start;
        for (; index < all.length && items.length < limit; index += 1) {
          const id = all[index]?.id;
          if (id === undefined) continue;
          let pooled: Pooled;
          try {
            pooled = await openStorage(sessionId(id));
          } catch (error) {
            // Deleted since the listing, here or elsewhere: not this page's failure.
            if (error instanceof UnknownSession) continue;
            throw error;
          }
          const info = await projectSession(pooled.storage);
          if (input.search !== undefined && !matches(info, input.search)) continue;
          if (input.parent === null && info.parent !== undefined) continue;
          if (
            input.parent !== null &&
            input.parent !== undefined &&
            info.parent?.sessionId !== input.parent
          ) {
            continue;
          }
          items.push(info);
        }
        return index < all.length ? { items, next: String(index) } : { items };
      },
      async rename(input) {
        alive();
        await (await openStorage(input.sessionId)).storage.setName(input.name);
      },
      async delete(input) {
        alive();
        const pooled = await openStorage(input.sessionId);
        const { storage } = pooled;
        // 1. No runner from here on: retire the session (every other verb now
        //    answers UnknownSession, and no attachment may volunteer for it),
        //    stop this process's volunteer, and drain the reconciliation and
        //    the harness build still in flight. A build that failed is not
        //    this verb's failure: there is simply no harness to close.
        pooled.retired = true;
        pooled.runner?.();
        pooled.runner = undefined;
        try {
          await pooled.reconciling;
          await pooled.opening?.catch(() => undefined);
          const harness = pooled.harness;
          // 2. Stop whoever drives the head. `requestAbort` writes the durable
          //    request against the live claimant atomically, so it reaches a
          //    holder in another process; `close` aborts and awaits only the
          //    drives this process owns (claim-neutral). Each round waits for
          //    the claim to be released or to lapse; a wake that claims again
          //    is aborted by the next round.
          let closedHarness = false;
          for (;;) {
            if ((await storage.getLiveClaim(MAIN)) === undefined) break;
            await storage.requestAbort(MAIN);
            if (harness !== undefined && !closedHarness) {
              closedHarness = true;
              await harness.close();
            }
            await waitForClaimRelease(storage, MAIN);
          }
          if (harness !== undefined && !closedHarness) await harness.close();
          // 3. Rows go last. Another host may still claim the head between the
          //    idle check above and this delete; the store contract offers no
          //    delete-if-idle, so that writer is left to the fence (its next
          //    renewal matches no row and it dies as claim_lost). Closing that
          //    window atomically is a `SessionRepo` change, not this verb's.
          await storage.close();
          await options.store.delete(input.sessionId);
        } finally {
          // The retired entry held the id until the rows were gone, so no
          // concurrent open could re-adopt it. Releasing it on failure too
          // lets a retried delete open the session afresh.
          pool.delete(input.sessionId);
        }
      },
      async configure(input) {
        alive();
        const { storage } = await openStorage(input.sessionId);
        if (
          input.model !== undefined &&
          options.models.getModel(input.model.provider, input.model.id) === undefined
        ) {
          return { kind: "unknown_model" };
        }
        // Agent validation needs the registry, so this is the one configure
        // path that activates the session's plugins. The run start re-resolves
        // the name anyway (invariant 29); validating here catches the typo at
        // the verb instead of a silent fallback at the next run.
        if (input.agent !== undefined) {
          const harness = await openHarness(input.sessionId);
          const known = harness
            .getAgents()
            .some((agent) => agent.id === input.agent && agent.disabled !== true);
          if (!known) return { kind: "unknown_agent" };
        }
        let deferred: { runId: string } | undefined;
        if (input.model !== undefined) {
          const admitted = await storage.admitEntry({
            type: "model_change",
            id: newId("e"),
            modelId: input.model.id,
            provider: input.model.provider,
          });
          if (admitted.disposition === "deferred") deferred = admitted;
        }
        if (input.thinkingLevel !== undefined) {
          const admitted = await storage.admitEntry({
            type: "thinking_level_change",
            id: newId("e"),
            thinkingLevel: input.thinkingLevel,
          });
          if (admitted.disposition === "deferred") deferred = admitted;
        }
        if (input.agent !== undefined) {
          const admitted = await storage.admitEntry({
            type: "agent_change",
            id: newId("e"),
            agentId: input.agent,
          });
          if (admitted.disposition === "deferred") deferred = admitted;
        }
        return deferred === undefined
          ? { kind: "applied" }
          : { kind: "deferred", runId: deferred.runId };
      },
    },

    messages: {
      async send(input: SendInput): Promise<SendReceipt> {
        alive();
        const { storage } = await openStorage(input.sessionId);
        if (input.agent !== undefined) {
          // The declaration is admitted ahead of the message it steers, so the
          // run that drains the message folds it. Unvalidated on purpose: the
          // run start re-resolves the name and degrades honestly, and the hot
          // send path stays free of plugin activation.
          await storage.admitEntry({ type: "agent_change", id: newId("e"), agentId: input.agent });
        }
        const receipt = await storage.send(
          { role: "user", content: input.content, timestamp: Date.now() },
          {
            head: input.head ?? MAIN,
            delivery: input.delivery,
            idempotencyKey: input.entryId,
            ...(input.wake === false ? { wake: false } : {}),
          },
        );
        if (receipt.duplicate) return { kind: "duplicate", entryId: receipt.entryId };
        return receipt.disposition === "placed"
          ? { kind: "placed", entryId: receipt.entryId }
          : { kind: "queued", entryId: receipt.entryId, runId: receipt.runId };
      },
      async cancel(input) {
        alive();
        return (await openHarness(input.sessionId)).cancelQueued(input.entryId);
      },
      async redeliver(input) {
        alive();
        return (await openHarness(input.sessionId)).redeliverQueued(
          input.entryId,
          input.delivery,
        );
      },
      async list(input): Promise<readonly Turn[]> {
        alive();
        const { storage } = await openStorage(input.sessionId);
        return transcriptFromEntries(await storage.getBranch(input.head ?? MAIN));
      },
      async pending(input): Promise<readonly PendingItem[]> {
        alive();
        const { storage } = await openStorage(input.sessionId);
        return pendingItemsFromLog(await storage.getLog());
      },
    },

    runs: {
      async current(input) {
        alive();
        const { storage } = await openStorage(input.sessionId);
        return currentRun(storage, input.head ?? MAIN);
      },
      async abort(input) {
        alive();
        return (await openHarness(input.sessionId)).abort(
          input.continue === undefined ? {} : { continue: input.continue },
        );
      },
      async wait(input) {
        alive();
        const { storage } = await openStorage(input.sessionId);
        return awaitHeadIdle(storage, input.head ?? MAIN, input.signal);
      },
      async reply(input) {
        alive();
        const { storage } = await openStorage(input.sessionId);
        // The admission is the wake input; an attached host's watch does the rest.
        return storage.admitToolReply(
          {
            reply: input.reply,
            ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
            ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
          },
          input.head ?? MAIN,
        );
      },
      async compact(input) {
        alive();
        return (await openHarness(input.sessionId)).compact(
          input.customInstructions === undefined
            ? {}
            : { customInstructions: input.customInstructions },
        );
      },
      async context(input) {
        alive();
        const { storage } = await openStorage(input.sessionId);
        const branch = await storage.getBranch(input.head ?? MAIN);
        const declared = readSessionConfig(branch).model;
        const model =
          declared === undefined ? options.model : (resolveModelRef(declared) ?? options.model);
        return projectContextStatus(branch, model.contextWindow);
      },
      async changes(input) {
        alive();
        const { storage } = await openStorage(input.sessionId);
        if (input.runId === undefined) {
          const branch = await storage.getBranch(input.head ?? MAIN);
          return changesFromTurns(transcriptFromEntries(branch));
        }
        // A run's window is its operation bracket on its own head; an unknown
        // run reports nothing rather than guessing a scope.
        const log = await storage.getLog();
        let head: HeadName | undefined;
        let start: number | undefined;
        let end = Number.POSITIVE_INFINITY;
        for (const item of log) {
          if (item.kind !== "record") continue;
          if (item.record.type === "operation_started" && item.record.id === input.runId) {
            head = item.record.head;
            start = item.seq;
          } else if (
            item.record.type === "operation_finished" &&
            item.record.runId === input.runId
          ) {
            end = item.seq;
          }
        }
        if (start === undefined || head === undefined) return [];
        const within = { head, start, end };
        const entries = log.flatMap((item) =>
          item.kind === "entry" &&
          item.head === within.head &&
          item.seq > within.start &&
          item.seq < within.end
            ? [item.entry]
            : [],
        );
        return changesFromTurns(transcriptFromEntries(entries));
      },
    },

    heads: {
      async move(input): Promise<MoveOutcome> {
        alive();
        const { storage } = await openStorage(input.sessionId);
        const run = await currentRun(storage, input.head ?? MAIN);
        if (run?.kind === "live") return { kind: "busy", run };
        // Navigation is a structural run: it claims the head exactly as
        // compaction does, so the move leaves an operation record and nothing
        // re-points a head under a live run's feet. The harness drives `main`,
        // and no SDK verb can create another head yet.
        return (await openHarness(input.sessionId)).navigate({
          entryId: input.to,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
        });
      },
    },

    workspace: {
      async list() {
        alive();
        return (await options.workspaces?.list()) ?? [];
      },
      async forget(input) {
        alive();
        await options.workspaces?.forget(input.path);
      },
      vcs: {
        async status() {
          alive();
          return options.vcs?.status();
        },
        async diff(input) {
          alive();
          return (await options.vcs?.diff(input)) ?? [];
        },
      },
    },

    provider: {
      models: {
        async list(): Promise<readonly ModelInfo[]> {
          alive();
          return options.models.getModels().map(toModelInfo);
        },
        async default(): Promise<ModelInfo | undefined> {
          alive();
          return toModelInfo(options.model);
        },
      },
    },

    plugins: {
      async list(input): Promise<readonly PluginInfo[]> {
        alive();
        return (await openHarness(input.sessionId)).plugins.list();
      },
      commands: {
        async list(input): Promise<readonly CommandInfo[]> {
          alive();
          const harness = await openHarness(input.sessionId);
          return [...harness.getCommands()].map(([name, command]) => ({
            name,
            owner: harness.commandOwner(name) ?? "",
            description: command.description,
          }));
        },
        async run(input): Promise<CommandOutcome> {
          alive();
          const harness = await openHarness(input.sessionId);
          if (!harness.getCommands().has(input.name)) return { kind: "not_found" };
          try {
            const output = await harness.runCommand(input.name, input.argument ?? "");
            return output === undefined ? { kind: "ran" } : { kind: "ran", output };
          } catch (error) {
            return { kind: "failed", message: messageOf(error) };
          }
        },
      },
      settings: {
        async list(input): Promise<readonly SettingInfo[]> {
          alive();
          return (await openHarness(input.sessionId)).listSettings();
        },
        async apply(input): Promise<ApplyOutcome> {
          alive();
          return (await openHarness(input.sessionId)).applySetting(input.id, input.choiceId);
        },
      },
      resources: {
        async list(input) {
          alive();
          return [...(await openHarness(input.sessionId)).getResources().values()];
        },
      },
    },

    async *watch(input): AsyncIterable<SessionEvent> {
      const { storage } = await openStorage(input.sessionId);
      const overlays: SessionEvent[] = [];
      let notify: (() => void) | undefined;
      let iterator: AsyncIterator<LogItem> | undefined;
      // Opened here rather than looked up: `attach()` builds harnesses in the
      // background, and a watch that started first would never see a delta.
      const harness = await openHarness(input.sessionId);
      const unsubscribe = harness.subscribe((event) => {
        overlays.push(event);
        notify?.();
      });

      try {
        const live = "live" in input && input.live;
        const after = live
          ? await storage.lastSeq()
          : "afterSeq" in input
            ? (input.afterSeq ?? -1)
            : -1;
        const replay = live ? [] : await storage.getLog({ afterSeq: after });
        for (const item of replay) {
          const event = durableEvent(item);
          if (event !== undefined) yield event;
        }
        const synced = replay.at(-1)?.seq ?? after;
        yield { seq: synced, kind: "synced" };

        // Live durable items interleave with overlays as each arrives: a
        // streaming delta must not wait for the next commit to flush. The two
        // sources race; whichever wakes first is yielded first.
        iterator = storage
          .watch({ afterSeq: synced, signal: input.signal })
          [Symbol.asyncIterator]();
        let nextItem = iterator.next();
        while (true) {
          while (overlays.length > 0) {
            const overlay = overlays.shift();
            if (overlay !== undefined) yield overlay;
          }
          const overlayArrived = new Promise<"overlay">((resolve) => {
            notify = () => resolve("overlay");
          });
          const woken = await Promise.race([nextItem, overlayArrived]);
          notify = undefined;
          if (woken === "overlay") continue;
          if (woken.done === true) break;
          const event = durableEvent(woken.value);
          if (event !== undefined) yield event;
          nextItem = iterator.next();
        }
      } finally {
        unsubscribe();
        notify = undefined;
        await iterator?.return?.().catch(() => undefined);
      }
    },

    async setPlugins(next) {
      alive();
      plugins = next;
      for (const pooled of pool.values()) {
        if (pooled.harness === undefined) continue;
        const { parent } = await projectSession(pooled.storage);
        await pooled.harness.plugins.activate(composePlugins(pooled, parent));
      }
    },

    attach(input?: AttachOptions): Disposer {
      alive();
      const attachment: Attachment =
        input?.sessions === undefined ? {} : { sessions: new Set(input.sessions) };
      attachments.add(attachment);
      // Opening a session reconciles its runner against the attachment set,
      // so a disposer that runs before `list()` resolves leaves nothing
      // behind: every later step re-reads the set and finds this gone.
      const begin = async (): Promise<void> => {
        const ids = input?.sessions ?? (await options.store.list()).map(({ id }) => sessionId(id));
        for (const id of ids) {
          if (!attachments.has(attachment)) return;
          try {
            // Opening adopts a new session; one already pooled reconciles here.
            await reconcileRunner(id, await openStorage(id));
          } catch (error) {
            // Deleted between the listing and the open: nothing to run.
            if (error instanceof UnknownSession) continue;
            throw error;
          }
        }
      };
      void begin().catch((error: unknown) => {
        // A closed Uji or a withdrawn attachment is cancellation, not failure.
        // Anything else has no caller to reject, so `close` reports it.
        if (error instanceof UjiClosed || !attachments.has(attachment)) return;
        background.push(error);
      });
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        attachments.delete(attachment);
        // Synchronous on purpose: a runner is only ever set after the same
        // check, so nothing can volunteer one back in before this returns.
        for (const [id, pooled] of pool) {
          if (pooled.runner === undefined || wantsRunner(id, pooled)) continue;
          pooled.runner();
          pooled.runner = undefined;
        }
      };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Nothing may volunteer again: withdraw every attachment and stop every
      // runner before any wait, so work still in flight finds no reason to
      // attach when it lands.
      attachments.clear();
      for (const pooled of pool.values()) {
        pooled.runner?.();
        pooled.runner = undefined;
      }
      const errors: unknown[] = [];
      for (const pooled of pool.values()) {
        // A reconciliation or harness build that started before close settles
        // here. A build that lands now closes itself (`harnessFor`) and
        // rejects as UjiClosed for its callers, which is not a close failure.
        await pooled.reconciling;
        await pooled.opening?.catch(() => undefined);
        await pooled.harness?.close().catch((error: unknown) => errors.push(error));
        await pooled.storage.close().catch((error: unknown) => errors.push(error));
      }
      pool.clear();
      errors.push(...background.splice(0));
      if (errors.length > 0) throw new AggregateError(errors, "Failed to close uji");
    },
  };
}

/**
 * Resolve once the head holds no live claim: released by its holder, taken
 * over and finished, or lapsed. Release and takeover are log items, so the
 * store's watch wakes this; expiry is wall-clock and announces nothing, so a
 * timer set at the claim's own `expiresAtMs` covers it.
 */
async function waitForClaimRelease(storage: SessionStorage, head: HeadName): Promise<void> {
  const controller = new AbortController();
  const log = await storage.getLog();
  const iterator = storage
    .watch({ afterSeq: log.at(-1)?.seq ?? -1, signal: controller.signal })
    [Symbol.asyncIterator]();
  try {
    let next = iterator.next();
    for (;;) {
      const claim = await storage.getLiveClaim(head);
      if (claim === undefined) return;
      const expiry = timerAt(claim.expiresAtMs);
      const woken = await Promise.race([next, expiry.due]);
      expiry.cancel();
      if (woken === "expired") continue;
      if (woken.done === true) return;
      next = iterator.next();
    }
  } finally {
    controller.abort();
    await iterator.return?.().catch(() => undefined);
  }
}

/** A cancellable promise that settles just after the wall-clock instant `atMs`. */
function timerAt(atMs: number): { due: Promise<"expired">; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const due = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), Math.max(0, atMs - Date.now()) + 1);
  });
  return {
    due,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function matches(info: SessionInfo, search: string): boolean {
  const needle = search.toLowerCase();
  return (
    (info.name ?? "").toLowerCase().includes(needle) ||
    (info.preview ?? "").toLowerCase().includes(needle)
  );
}

function toModelInfo(model: { id: string; provider: string; name: string; contextWindow: number }) {
  return {
    id: model.id,
    provider: model.provider,
    name: model.name,
    contextWindow: model.contextWindow,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
