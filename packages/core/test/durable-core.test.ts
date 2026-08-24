/** Acceptance drills for the design record's session model, build-order slices 1-4. */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type Usage,
} from "@uji-ai/ai";
import { Type } from "typebox";
import {
  AgentHarness,
  type HarnessTool,
  HookRegistry,
  inlinePlugin,
  type LogItem,
  type MessageEntry,
  type ProvisionedEntry,
  type SessionStorage,
  SqliteSessionRepo,
  type SqliteSessionRepoOptions,
  systemPromptPlugin,
  step,
  toolsPlugin,
} from "../src/index.ts";
import type { ClaimRunOutcome, RunWriter } from "../src/harness/session/store.ts";
import type { StreamFn } from "../src/types.ts";

const directories: string[] = [];
const repositories: SqliteSessionRepo[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const repo of repositories.splice(0).reverse()) await repo.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface SharedSession {
  path: string;
  first: SessionStorage;
  second: SessionStorage;
}

async function sharedSession(options?: SqliteSessionRepoOptions): Promise<SharedSession> {
  const directory = mkdtempSync(join(tmpdir(), "uji-durable-core-"));
  directories.push(directory);
  const path = join(directory, "sessions.db");
  const firstRepo = new SqliteSessionRepo(path, options);
  const secondRepo = new SqliteSessionRepo(path, options);
  repositories.push(firstRepo, secondRepo);
  const first = await firstRepo.create({ id: "shared" });
  const second = await secondRepo.open("shared");
  return { path, first, second };
}

function claimed(outcome: ClaimRunOutcome): Extract<ClaimRunOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`claim held by ${outcome.holder.runId}`);
  return outcome;
}

function expireClaim(path: string, head = "main"): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare("UPDATE run_claims SET expires_at_ms = 0 WHERE session_id = ? AND head = ?").run(
      "shared",
      head,
    );
  } finally {
    db.close();
  }
}

function userMessage(content: string, timestamp = Date.now()): Message {
  return { role: "user", content, timestamp };
}

const usage: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model<"openai-responses"> = {
  id: "durable-core-test",
  name: "Durable core test",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};

function assistant(text = "done"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function finalStream(text = "done"): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant(text) }));
  return stream;
}

function streamingFinal(text = "done"): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const partial = assistant("");
  queueMicrotask(() => {
    stream.push({ type: "start", partial });
    partial.content = [{ type: "text", text }];
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
    stream.push({ type: "done", reason: "stop", message: assistant(text) });
  });
  return stream;
}

interface GatedStream {
  streamFn: StreamFn;
  entered: Promise<void>;
  release(): void;
  contexts: Message[][];
}

interface InterruptibleGate {
  streamFn: StreamFn;
  entered: Promise<void>;
  release(): void;
  contexts: Message[][];
  signalAborted: Promise<void>;
}

function gatedStream(): GatedStream {
  const contexts: Message[][] = [];
  let announce: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let release: (() => void) | undefined;
  let released = false;
  let call = 0;
  return {
    contexts,
    entered,
    streamFn: (_model, context) => {
      contexts.push(context.messages);
      call += 1;
      if (call > 1) return finalStream(`done-${call}`);
      const stream = createAssistantMessageEventStream();
      release = () => stream.push({ type: "done", reason: "stop", message: assistant("turn-1") });
      announce?.();
      if (released) queueMicrotask(() => release?.());
      return stream;
    },
    release() {
      released = true;
      release?.();
    },
  };
}

function interruptibleGate(settleOnAbort: boolean): InterruptibleGate {
  const contexts: Message[][] = [];
  let announce: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let announceAbort: (() => void) | undefined;
  const signalAborted = new Promise<void>((resolve) => {
    announceAbort = resolve;
  });
  let release: (() => void) | undefined;
  let released = false;
  let call = 0;
  return {
    contexts,
    entered,
    signalAborted,
    streamFn: (_model, context, options) => {
      contexts.push(context.messages);
      call += 1;
      if (call > 1) return finalStream(`done-${call}`);
      const stream = createAssistantMessageEventStream();
      let settled = false;
      release = () => {
        if (settled) return;
        settled = true;
        stream.push({ type: "done", reason: "stop", message: assistant("turn-1") });
      };
      const abort = () => {
        announceAbort?.();
        if (!settleOnAbort || settled) return;
        settled = true;
        stream.push({
          type: "error",
          reason: "aborted",
          error: { ...assistant(""), content: [], stopReason: "aborted" },
        });
      };
      if (options?.signal?.aborted === true) queueMicrotask(abort);
      else options?.signal?.addEventListener("abort", abort, { once: true });
      announce?.();
      if (released) queueMicrotask(() => release?.());
      return stream;
    },
    release() {
      released = true;
      release?.();
    },
  };
}

async function createHarness(
  session: SessionStorage,
  streamFn: StreamFn,
  tools: readonly HarnessTool[] = [],
): Promise<AgentHarness> {
  const plugins = [inlinePlugin(systemPromptPlugin("system"))];
  if (tools.length > 0) plugins.push(inlinePlugin(toolsPlugin(tools)));
  return (
    await AgentHarness.create({
      session,
      streamFn,
      plugins,
      env: { cwd: "/" },
      model,
    })
  ).harness;
}

function userTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.role === "user" && typeof message.content === "string" ? [message.content] : [],
  );
}

async function collect(iterable: AsyncIterable<LogItem>, count: number): Promise<LogItem[]> {
  const items: LogItem[] = [];
  for await (const item of iterable) {
    items.push(item);
    if (items.length === count) break;
  }
  return items;
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 2_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForFinishedRun(session: SessionStorage): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    for await (const item of session.watch({ signal: controller.signal })) {
      if (item.kind === "record" && item.record.type === "operation_finished") return;
    }
    throw new Error("no operation_finished before the session closed");
  } finally {
    clearTimeout(timer);
  }
}

async function seedUnsettledTool(
  session: SessionStorage,
  replay: "never" | "safe",
): Promise<{ writer: RunWriter; resultEntryId: string }> {
  const runId = `run-${replay}`;
  const input = userMessage(`recover ${replay}`, 10);
  const provisioned: ProvisionedEntry<MessageEntry> = {
    type: "message",
    id: `input-${replay}`,
    message: input,
  };
  const writer = claimed(await session.claimRun("main", runId)).writer;
  await writer.appendRecord({
    type: "operation_started",
    id: runId,
    head: "main",
    sourceLeafId: null,
    intent: {
      kind: "run",
      originalPrompt: [{ ...input }],
      initialMessages: [provisioned],
    },
  });
  await writer.appendEntry(provisioned);
  const resultEntryId = `result-${replay}`;
  await writer.appendRecord({
    type: "tool_started",
    id: `tool-${replay}`,
    head: "main",
    runId,
    toolCallId: `call-${replay}`,
    toolName: "replay_tool",
    effectiveArgs: { value: "persisted" },
    resultEntryId,
    replay,
  });
  return { writer, resultEntryId };
}

void describe("run claims (design record: claims, invariants 8-9)", () => {
  void it("claims a head, and a second claim on the same head loses with the holder's runId", async () => {
    const { first, second } = await sharedSession();
    const winner = claimed(await first.claimRun("main", "run-one"));
    const loser = await second.claimRun("main", "run-two");
    assert.equal(loser.ok, false);
    if (!loser.ok) assert.equal(loser.holder.runId, "run-one");
    await winner.writer.release();
    const claimEvents = (await first.getLog()).filter((item) => item.kind === "claim");
    assert.deepEqual(
      claimEvents.map((item) => item.event.kind),
      ["acquired", "released"],
    );
    assert.deepEqual(
      claimEvents.map((item) => item.seq),
      [1, 2],
    );
  });

  void it("two heads of one session hold independent claims concurrently", async () => {
    const { first, second } = await sharedSession();
    const main = claimed(await first.claimRun("main", "run-main"));
    const branch = claimed(await second.claimRun("branch", "run-branch"));
    assert.equal(main.claim.head, "main");
    assert.equal(branch.claim.head, "branch");
    await main.writer.release();
    await branch.writer.release();
  });

  void it("a fenced-out claimant's runner write rolls back before touching data", async () => {
    const { path, first, second } = await sharedSession();
    const stale = claimed(await first.claimRun("main", "run-stale"));
    expireClaim(path);
    const successor = claimed(await second.claimRun("main", "run-successor"));
    const before = await first.getLog();
    await assert.rejects(
      stale.writer.appendRecord({
        type: "step_attempt",
        id: "stale-step",
        head: "main",
        runId: "run-stale",
        step: "assistant",
        attempt: 1,
      }),
      /Run claim lost/,
    );
    assert.equal((await first.findRecords({ type: "step_attempt" })).length, 0);
    assert.deepEqual(await first.getLog(), before);
    await successor.writer.release();
  });

  void it("an expired claim is taken over by a second process; the fence increments", async () => {
    const { path, first, second } = await sharedSession();
    const original = claimed(await first.claimRun("main", "run-original"));
    expireClaim(path);
    const takeover = claimed(await second.claimRun("main", "run-takeover"));
    assert.equal(takeover.claim.fence, original.claim.fence + 1);
    await takeover.writer.release();
  });

  void it("release deletes only the claimant's own row, never a successor's", async () => {
    const { path, first, second } = await sharedSession();
    const original = claimed(await first.claimRun("main", "run-original"));
    expireClaim(path);
    const successor = claimed(await second.claimRun("main", "run-successor"));
    await original.writer.release();
    assert.equal((await second.getLiveClaim("main"))?.runId, "run-successor");
    await successor.writer.release();
  });

  void it("renew succeeds past expiry when no successor took over (sleep-wake reclaim)", async () => {
    const { path, first } = await sharedSession();
    const original = claimed(await first.claimRun("main", "run-sleeper"));
    expireClaim(path);
    assert.equal(await original.writer.renew(), true);
    assert.equal((await first.getLiveClaim("main"))?.runId, "run-sleeper");
    await original.writer.release();
  });
});

void describe("open admission (design record: admission, invariants 5-7)", () => {
  void it("send on an idle head places the entry at the tip and reports disposition placed", async () => {
    const { first } = await sharedSession();
    const receipt = await first.send("hello", {
      origin: { clientId: "client-a", device: "phone" },
    });
    assert.equal(receipt.disposition, "placed");
    const entry = await first.getEntry(receipt.entryId);
    assert.equal(entry?.type, "message");
    if (entry?.type === "message") {
      assert.deepEqual(entry.origin, { clientId: "client-a", device: "phone" });
    }
    assert.equal(await first.getLeafId("main"), receipt.entryId);
  });

  void it("send against a live claim lands queued with that runId and does not move the head", async () => {
    const { first, second } = await sharedSession();
    const seed = await first.send("seed");
    const run = claimed(await first.claimRun("main", "run-live"));
    const receipt = await second.send("during run", { delivery: "queue" });
    assert.deepEqual(receipt, {
      disposition: "queued",
      entryId: receipt.entryId,
      runId: "run-live",
      duplicate: false,
    });
    assert.equal(await second.getLeafId("main"), seed.entryId);
    assert.equal(await second.getEntry(receipt.entryId), undefined);
    await run.writer.release();
  });

  void it("three concurrent senders from two repo instances all land, linearized by seq", async () => {
    const { first, second } = await sharedSession();
    const receipts = await Promise.all([
      first.send("one"),
      second.send("two"),
      first.send("three"),
    ]);
    assert.deepEqual(
      receipts.map((receipt) => receipt.disposition),
      ["placed", "placed", "placed"],
    );
    const entries = await first.findEntries({ type: "message" });
    assert.deepEqual(
      entries.map((entry) => entry.seq),
      [...entries.map((entry) => entry.seq)].sort((a, b) => a - b),
    );
    assert.equal(entries.length, 3);
    const branch = await second.getBranch("main");
    assert.deepEqual(
      branch.map((entry) => entry.parentId),
      [null, branch[0]?.id, branch[1]?.id],
    );
  });

  void it("a duplicate idempotencyKey returns the original receipt and writes nothing", async () => {
    const { first, second } = await sharedSession();
    const original = await first.send("once", { idempotencyKey: "retry-key" });
    const before = await first.getLog();
    const duplicate = await second.send("must not land", { idempotencyKey: "retry-key" });
    assert.deepEqual(duplicate, { ...original, duplicate: true });
    assert.deepEqual(await first.getLog(), before);
    assert.equal((await first.findEntries({ type: "message" })).length, 1);
  });

  void it("a queued send is drained by the running harness at its next checkpoint in seq order", async () => {
    const { first, second } = await sharedSession();
    const gate = gatedStream();
    const harness = await createHarness(first, gate.streamFn);
    const running = harness.prompt("initial");
    await withTimeout(gate.entered, "provider did not start");
    await second.send("external-one");
    await second.send("external-two");
    gate.release();
    const result = await running;
    assert.equal(result.ok, true);
    assert.equal(userTexts(gate.contexts[1] ?? []).at(-1), "external-one");
    assert.equal(userTexts(gate.contexts[2] ?? []).at(-1), "external-two");
    assert.deepEqual(await harness.pendingQueue(), []);
    await harness.close();
  });

  void it("a send from a second process while a first-process run is live is answered by that run", async () => {
    const { first, second } = await sharedSession();
    const gate = gatedStream();
    const harness = await createHarness(first, gate.streamFn);
    const running = harness.prompt("initial");
    await withTimeout(gate.entered, "provider did not start");
    const receipt = await second.send("from another process");
    assert.equal(receipt.disposition, "queued");
    gate.release();
    const result = await running;
    assert.equal(result.ok, true);
    assert.ok(userTexts(gate.contexts[1] ?? []).includes("from another process"));
    const branch = await second.getBranch("main");
    assert.equal(
      branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
        .length,
      2,
    );
    await harness.close();
  });
});

void describe("participant tree admission (design record: admission)", () => {
  void it("places an entry immediately when the head is idle", async () => {
    const { first } = await sharedSession();
    const target: ProvisionedEntry<MessageEntry> = {
      type: "message",
      id: "idle-entry",
      message: userMessage("idle write", 1),
    };
    assert.deepEqual(await first.admitEntry(target), { disposition: "placed" });
    assert.equal((await first.getEntry(target.id))?.id, target.id);
    assert.equal(await first.getLeafId("main"), target.id);
  });

  void it("defers behind a live run and preserves entry order across placed and deferred writes", async () => {
    const { first, second } = await sharedSession();
    await first.admitEntry({
      type: "message",
      id: "placed-first",
      message: userMessage("placed", 1),
    });
    const runId = "run-order";
    const writer = claimed(await first.claimRun("main", runId)).writer;
    await writer.appendRecord({
      type: "operation_started",
      id: runId,
      head: "main",
      sourceLeafId: "placed-first",
      intent: { kind: "run", originalPrompt: [], initialMessages: [] },
    });
    assert.deepEqual(
      await second.admitEntry({
        type: "message",
        id: "deferred-one",
        message: userMessage("deferred one", 2),
      }),
      { disposition: "deferred", runId },
    );
    assert.deepEqual(
      await first.admitEntry({
        type: "message",
        id: "deferred-two",
        message: userMessage("deferred two", 3),
      }),
      { disposition: "deferred", runId },
    );
    assert.equal(await first.getEntry("deferred-one"), undefined);
    await writer.finish({
      type: "operation_finished",
      id: "finish-order",
      head: "main",
      runId,
      outcome: "completed",
    });

    const branch = await second.getBranch("main");
    assert.deepEqual(
      branch.map((entry) => entry.id),
      ["placed-first", "deferred-one", "deferred-two"],
    );
    assert.deepEqual(
      branch.map((entry) => entry.seq),
      [...branch.map((entry) => entry.seq)].sort((a, b) => a - b),
    );
  });

  void it("cancels an unconsumed deferred target with the existing entry-id tombstone", async () => {
    const { first, second } = await sharedSession();
    const runId = "run-cancel-deferred";
    const writer = claimed(await first.claimRun("main", runId)).writer;
    await writer.appendRecord({
      type: "operation_started",
      id: runId,
      head: "main",
      sourceLeafId: null,
      intent: { kind: "run", originalPrompt: [], initialMessages: [] },
    });
    const target: ProvisionedEntry<MessageEntry> = {
      type: "message",
      id: "cancelled-deferred",
      message: userMessage("cancel me", 1),
    };
    assert.equal((await second.admitEntry(target)).disposition, "deferred");
    await second.appendRecord({
      type: "queue_cancelled",
      id: "cancel-deferred",
      head: "main",
      entryId: target.id,
    });
    await writer.finish({
      type: "operation_finished",
      id: "finish-cancel-deferred",
      head: "main",
      runId,
      outcome: "completed",
    });
    assert.equal(await first.getEntry(target.id), undefined);
  });
});

void describe("watch (design record: one event stream, invariants 17-18)", () => {
  void it("delivers no gaps and no duplicates across the replay/live boundary", async () => {
    const { first, second } = await sharedSession();
    await first.send("one");
    const watching = collect(first.watch({ afterSeq: 0 }), 6);
    await Promise.all([second.send("two"), first.send("three")]);
    const items = await withTimeout(watching, "watch missed the replay/live boundary");
    const seqs = items.map((item) => item.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
    assert.equal(new Set(seqs).size, seqs.length);
  });

  void it("sees commits from a second repo instance on the same file (data_version wake)", async () => {
    const { first, second } = await sharedSession({ watchPollIntervalMs: 5 });
    const watching = collect(first.watch({ afterSeq: 0 }), 2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await second.send("cross-process wake");
    const items = await withTimeout(watching, "data_version did not wake the watcher");
    assert.deepEqual(
      items.map((item) => item.kind),
      ["entry", "head"],
    );
  });

  void it("terminates cleanly on abort signal", async () => {
    const { first } = await sharedSession();
    const controller = new AbortController();
    const iterator = first
      .watch({ afterSeq: 0, signal: controller.signal })
      [Symbol.asyncIterator]();
    const next = iterator.next();
    controller.abort();
    assert.deepEqual(await withTimeout(next, "aborted watch did not stop"), {
      value: undefined,
      done: true,
    });
  });
});

void describe("runner over claims (design record: the step, invariants 9-12)", () => {
  void it("a run claims its head at start and releases at operation_finished", async () => {
    const { first, second } = await sharedSession();
    const gate = gatedStream();
    const harness = await createHarness(first, gate.streamFn);
    const running = harness.prompt("claim me");
    await withTimeout(gate.entered, "provider did not start");
    const live = await second.getLiveClaim("main");
    assert.ok(live?.runId.startsWith("run_"));
    gate.release();
    const result = await running;
    assert.equal(result.ok, true);
    assert.equal(await second.getLiveClaim("main"), undefined);
    assert.equal((await second.findRecords({ type: "operation_finished" })).length, 1);
    await harness.close();
  });

  void it("streaming overlays identify the durable entry they settle", async () => {
    const { first } = await sharedSession();
    const harness = await createHarness(first, () => streamingFinal("streamed"));
    const updateIds: string[] = [];
    let settledId: string | undefined;
    harness.subscribe((event) => {
      if (event.type === "message_update") updateIds.push(event.entryId);
      if (event.type === "message_end" && event.message.role === "assistant") {
        settledId = event.entryId;
      }
    });
    const result = await harness.prompt("overlay");
    assert.equal(result.ok, true);
    assert.ok(settledId !== undefined);
    assert.deepEqual(updateIds, [settledId]);
    assert.equal((await first.getEntry(settledId))?.type, "message");
    await harness.close();
  });

  void it("applies a second-process deferred write before queued steering at the next checkpoint", async () => {
    const { first, second } = await sharedSession();
    const gate = gatedStream();
    const harness = await createHarness(first, gate.streamFn);
    const running = harness.prompt("initial");
    await withTimeout(gate.entered, "provider did not start");
    const live = await second.getLiveClaim("main");
    assert.ok(live !== undefined);
    assert.deepEqual(
      await second.admitEntry({
        type: "message",
        id: "external-tree-write",
        message: userMessage("tree write", 2),
      }),
      { disposition: "deferred", runId: live.runId },
    );
    const steer = await second.send("queued steer");
    assert.equal(steer.disposition, "queued");

    gate.release();
    const result = await running;
    assert.equal(result.ok, true);
    const checkpointUsers = userTexts(gate.contexts[1] ?? []);
    assert.deepEqual(checkpointUsers.slice(-2), ["tree write", "queued steer"]);
    const branch = await first.getBranch("main");
    const treeWrite = branch.find((entry) => entry.id === "external-tree-write");
    const queued = branch.find((entry) => entry.id === steer.entryId);
    assert.ok(treeWrite !== undefined && queued !== undefined);
    assert.ok(treeWrite.seq < queued.seq);
    await harness.close();
  });

  void it("reconciles a deferred write before an aborted run's terminal record", async () => {
    const { first, second } = await sharedSession();
    const gate = interruptibleGate(true);
    const harness = await createHarness(first, gate.streamFn);
    const running = harness.prompt("initial");
    await withTimeout(gate.entered, "provider did not start");
    const admitted = await second.admitEntry({
      type: "message",
      id: "survives-abort",
      message: userMessage("survives abort", 2),
    });
    assert.equal(admitted.disposition, "deferred");

    const aborted = await harness.abort();
    assert.equal(aborted.ok, true);
    const result = await running;
    assert.equal(result.ok && result.value.kind, "aborted");
    const log = await second.getLog();
    const entryItem = log.find(
      (item) => item.kind === "entry" && item.entry.id === "survives-abort",
    );
    const terminal = log.find(
      (item) =>
        item.kind === "record" &&
        item.record.type === "operation_finished" &&
        item.record.runId === (aborted.ok ? aborted.value.runId : ""),
    );
    assert.ok(entryItem !== undefined && terminal !== undefined);
    assert.ok(entryItem.seq < terminal.seq);
    await harness.close();
  });

  void it("honors a second-process abort request during an in-flight provider stream", async () => {
    const { first, second } = await sharedSession();
    const gate = interruptibleGate(true);
    const harness = await createHarness(first, gate.streamFn);
    const running = harness.prompt("initial");
    await withTimeout(gate.entered, "provider did not start");
    const queued = await second.send("survive the abort");
    assert.equal(queued.disposition, "queued");
    const requested = await second.requestAbort();
    assert.ok(requested !== undefined);
    await withTimeout(gate.signalAborted, "provider signal was not aborted by the durable request");

    const result = await running;
    assert.equal(result.ok && result.value.kind, "aborted");
    assert.equal(await second.getLiveClaim("main"), undefined);
    const terminal = await second.findRecords({
      type: "operation_finished",
      runId: requested.runId,
    });
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.outcome, "aborted");
    assert.deepEqual(
      (await harness.pendingQueue()).map((item) => item.entryId),
      [queued.entryId],
    );
    await harness.close();
  });

  void it("resume executes a tool call whose assistant entry committed before its intent", async () => {
    const { path, first, second } = await sharedSession();
    const runId = "run-before-intent";
    const input: ProvisionedEntry<MessageEntry> = {
      type: "message",
      id: "before-intent-input",
      message: userMessage("call the tool", 10),
    };
    const writer = claimed(await first.claimRun("main", runId)).writer;
    await writer.appendRecord({
      type: "operation_started",
      id: runId,
      head: "main",
      sourceLeafId: null,
      intent: { kind: "run", originalPrompt: [{ ...input.message }], initialMessages: [input] },
    });
    await writer.appendEntry(input);
    await writer.appendEntry({
      type: "message",
      id: "before-intent-assistant",
      message: {
        ...assistant(),
        content: [
          {
            type: "toolCall",
            id: "before-intent-call",
            name: "replay_tool",
            arguments: { value: "known-not-started" },
          },
        ],
        stopReason: "toolUse",
      },
    });
    expireClaim(path);

    const calls: unknown[] = [];
    const tool: HarnessTool = {
      name: "replay_tool",
      label: "Replay tool",
      description: "records recovery arguments",
      parameters: Type.Object({ value: Type.String() }),
      replay: "never",
      execute: async (_id, params) => {
        calls.push(params);
        return { content: [{ type: "text", text: "executed" }], details: {} };
      },
    };
    const harness = await createHarness(second, () => finalStream("continued"), [tool]);
    const resumed = await harness.resume();
    assert.equal(resumed.ok, true);
    assert.deepEqual(calls, [{ value: "known-not-started" }]);
    const intents = await second.findRecords({ type: "tool_started", runId });
    assert.equal(intents.length, 1);
    assert.equal((await second.getEntry(intents[0]?.resultEntryId ?? "missing"))?.type, "message");
    await harness.close();
  });

  void it("SIGKILL between step commits leaves an orphan a DIFFERENT process resumes by claim", async () => {
    const options = { claimTtlMs: 120, claimHeartbeatIntervalMs: 40 };
    const { path, second } = await sharedSession(options);
    const coreUrl = new URL("../src/index.ts", import.meta.url).href;
    const script = `
      import { SqliteSessionRepo } from ${JSON.stringify(coreUrl)};
      const repo = new SqliteSessionRepo(process.argv[1], {
        claimTtlMs: 120,
        claimHeartbeatIntervalMs: 40,
      });
      const session = await repo.open("shared");
      const outcome = await session.claimRun("main", "run-child");
      if (!outcome.ok) throw new Error("child lost claim");
      const message = { role: "user", content: "resume child", timestamp: 1 };
      const provisioned = { type: "message", id: "child-input", message };
      await outcome.writer.appendRecord({
        type: "operation_started",
        id: "run-child",
        head: "main",
        sourceLeafId: null,
        intent: {
          kind: "run",
          originalPrompt: [{ ...message }],
          initialMessages: [provisioned],
        },
      });
      await outcome.writer.appendEntry(provisioned);
      await outcome.writer.appendRecord({
        type: "step_attempt",
        id: "child-step",
        head: "main",
        runId: "run-child",
        step: "assistant",
        attempt: 1,
      });
      process.stdout.write("READY\\n");
      setInterval(() => undefined, 1_000);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stderr = "";
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        let stdout = "";
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes("READY\n")) resolve();
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`child exited before ready: ${stderr}`)));
      }),
      "child did not reach the committed step",
    );
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 160));

    const harness = await createHarness(second, () => finalStream("resumed"));
    const resumed = await harness.resume();
    assert.equal(resumed.ok, true);
    if (resumed.ok) assert.equal(resumed.value.runId, "run-child");
    assert.equal(
      (await second.findRecords({ type: "operation_finished", runId: "run-child" })).length,
      1,
    );
    assert.deepEqual(
      (await second.findRecords({ type: "step_attempt", runId: "run-child" })).map(
        (record) => record.attempt,
      ),
      [1, 2],
    );
    assert.equal(await second.getLiveClaim("main"), undefined);
    await harness.close();
  });

  void it("finishes one run by alternating step calls across two processes", async () => {
    const { path, first, second } = await sharedSession();
    const runId = "run-alternating-steps";
    const input: ProvisionedEntry<MessageEntry> = {
      type: "message",
      id: "alternating-input",
      message: userMessage("alternate processes", 1),
    };
    const seeded = claimed(await first.claimRun("main", runId));
    await seeded.writer.appendRecord({
      type: "operation_started",
      id: runId,
      head: "main",
      sourceLeafId: null,
      intent: {
        kind: "run",
        originalPrompt: [{ ...input.message }],
        initialMessages: [input],
      },
    });
    await seeded.writer.appendEntry(input);
    await seeded.writer.release();

    const coreUrl = new URL("../src/index.ts", import.meta.url).href;
    const script = `
      import { createAssistantMessageEventStream } from "@uji-ai/ai";
      import { Type } from "typebox";
      import { HookRegistry, SqliteSessionRepo, step } from ${JSON.stringify(coreUrl)};
      const model = ${JSON.stringify(model)};
      const usage = ${JSON.stringify(usage)};
      const repo = new SqliteSessionRepo(process.argv[1]);
      const session = await repo.open("shared");
      const hooks = new HookRegistry(() => undefined);
      const streamFn = () => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.push({
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "alternating-call", name: "checkpoint", arguments: {} }],
            api: "openai-responses",
            provider: "openai",
            model: model.id,
            usage,
            stopReason: "toolUse",
            timestamp: 2,
          },
        }));
        return stream;
      };
      const result = await step({
        session,
        runId: ${JSON.stringify(runId)},
        hooks,
        streamFn,
        tools: [{
          name: "checkpoint",
          label: "Checkpoint",
          description: "commit one tool batch",
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text", text: "continue" }], details: {} }),
        }],
        model,
        systemPrompt: "system",
        emit: () => Promise.resolve(),
      });
      if (result.kind !== "continue") throw new Error("first process finished too early");
      hooks.close(new Error("step complete"));
      await session.close();
      await repo.close();
      process.stdout.write("CONTINUE\\n");
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`step child exited ${code}: ${stderr}`));
        });
      }),
      "first process did not commit its step",
    );
    assert.match(stdout, /CONTINUE/);

    const projected = await second.runState(runId);
    assert.equal(projected.kind, "running");
    if (projected.kind === "running") {
      assert.equal(projected.retryCount, 1);
      assert.equal(projected.lastStepAttempt?.attempt, 1);
      assert.deepEqual(projected.unsettledToolIntents, []);
    }

    const hooks = new HookRegistry(() => undefined);
    const finished = await step({
      session: second,
      runId,
      hooks,
      streamFn: () => finalStream("finished elsewhere"),
      tools: [],
      model,
      systemPrompt: "system",
      emit: () => Promise.resolve(),
    });
    hooks.close(new Error("step complete"));
    assert.equal(finished.kind, "finished");
    if (finished.kind === "finished") {
      assert.equal(finished.operation, "run");
      assert.equal(finished.outcome.kind, "completed");
    }
    assert.deepEqual(
      (await second.findRecords({ type: "step_attempt", runId })).map((record) => record.attempt),
      [1, 2],
    );
    assert.equal((await second.findRecords({ type: "operation_finished", runId })).length, 1);
    assert.equal(await second.getLiveClaim("main"), undefined);
  });

  void it("resume settles unsettled never-replay intents as synthetic errors, exactly once", async () => {
    const { path, first, second } = await sharedSession();
    const seeded = await seedUnsettledTool(first, "never");
    expireClaim(path);
    const harness = await createHarness(second, () => finalStream("continued"));
    const resumed = await harness.resume();
    assert.equal(resumed.ok, true);
    const settlement = await second.getEntry(seeded.resultEntryId);
    assert.equal(settlement?.type, "message");
    if (settlement?.type === "message") {
      assert.equal(settlement.message.role, "toolResult");
      if (settlement.message.role === "toolResult") assert.equal(settlement.message.isError, true);
    }
    assert.equal(
      (await second.findEntries()).filter((entry) => entry.id === seeded.resultEntryId).length,
      1,
    );
    await harness.close();
  });

  void it("resume re-executes unsettled safe-replay intents with persisted arguments", async () => {
    const { path, first, second } = await sharedSession();
    const seeded = await seedUnsettledTool(first, "safe");
    expireClaim(path);
    const calls: unknown[] = [];
    const tool: HarnessTool = {
      name: "replay_tool",
      label: "Replay tool",
      description: "records replayed arguments",
      parameters: Type.Object({ value: Type.String() }),
      replay: "safe",
      execute: async (_id, params) => {
        calls.push(params);
        return { content: [{ type: "text", text: "replayed" }], details: {} };
      },
    };
    const harness = await createHarness(second, () => finalStream("continued"), [tool]);
    const resumed = await harness.resume();
    assert.equal(resumed.ok, true);
    assert.deepEqual(calls, [{ value: "persisted" }]);
    assert.equal((await second.getEntry(seeded.resultEntryId))?.type, "message");
    await harness.close();
  });

  void it("fences a hot runner cleanly while a successor resumes and finishes exactly once", async () => {
    const options = { claimTtlMs: 160, claimHeartbeatIntervalMs: 80, watchPollIntervalMs: 5 };
    const { path, first, second } = await sharedSession(options);
    const staleGate = interruptibleGate(false);
    const staleHarness = await createHarness(first, staleGate.streamFn);
    const staleRun = staleHarness.prompt("take over this run");
    await withTimeout(staleGate.entered, "stale provider did not start");
    const live = await second.getLiveClaim("main");
    assert.ok(live !== undefined);

    expireClaim(path);
    const successorHarness = await createHarness(second, () => finalStream("successor"));
    const resumed = await successorHarness.resume();
    assert.equal(resumed.ok, true);
    assert.equal(resumed.value.operation, "run");
    assert.equal(resumed.value.runId, live.runId);
    assert.equal(resumed.value.kind, "completed");
    await withTimeout(staleGate.signalAborted, "stale provider signal was not aborted");

    const fencedLog = await second.getLog();
    staleGate.release();
    const staleResult = await staleRun;
    assert.equal(staleResult.ok, true);
    assert.equal(staleResult.value.kind, "failed");
    if (staleResult.value.kind === "failed") {
      assert.equal(staleResult.value.error.code, "claim_lost");
    }
    assert.deepEqual(await second.getLog(), fencedLog);
    assert.equal(
      (await second.findRecords({ type: "operation_finished", runId: live.runId })).length,
      1,
    );
    assert.equal(await second.getLiveClaim("main"), undefined);
    await successorHarness.close();
    await staleHarness.close();
  });

  void it("attach runs a message placed by a second process on an idle head", async () => {
    const { first, second } = await sharedSession();
    const harness = await createHarness(first, () => finalStream("answered by attach"));
    const detach = harness.attach();
    const receipt = await second.send("hello from a phone");
    assert.equal(receipt.disposition, "placed");
    await waitForFinishedRun(second);
    const branch = await second.getBranch("main");
    assert.deepEqual(
      branch.flatMap((entry) =>
        entry.type === "message" && entry.message.role === "assistant"
          ? [entry.message.content]
          : [],
      ),
      [[{ type: "text", text: "answered by attach" }]],
    );
    assert.equal(await second.getLiveClaim("main"), undefined);
    detach();
    await harness.close();
  });

  void it("attach claims an orphaned operation left by another process", async () => {
    const { first, second } = await sharedSession();
    const seeded = await seedUnsettledTool(first, "never");
    await seeded.writer.release();
    const harness = await createHarness(second, () => finalStream("resumed by attach"));
    const detach = harness.attach();
    await waitForFinishedRun(second);
    assert.equal(
      (await second.findRecords({ type: "operation_finished", runId: "run-never" })).length,
      1,
    );
    const result = await second.getEntry(seeded.resultEntryId);
    assert.equal(result?.type, "message");
    detach();
    await harness.close();
  });

  void it("two attached hosts run one placement exactly once", async () => {
    const { first, second } = await sharedSession();
    const hostA = await createHarness(first, () => finalStream("from A"));
    const hostB = await createHarness(second, () => finalStream("from B"));
    const detachA = hostA.attach();
    const detachB = hostB.attach();
    await first.send("one message, two hosts");
    await waitForFinishedRun(second);
    await Promise.all([hostA.waitForIdle(), hostB.waitForIdle()]);
    assert.equal((await second.findRecords({ type: "operation_started" })).length, 1);
    assert.equal((await second.findRecords({ type: "operation_finished" })).length, 1);
    detachA();
    detachB();
    await Promise.all([hostA.close(), hostB.close()]);
  });
});
