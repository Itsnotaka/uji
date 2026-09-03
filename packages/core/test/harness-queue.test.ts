/** Core-owned durable message admission and queue regression tests. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Model,
  Usage,
} from "@uji-ai/ai";
import { createAssistantMessageEventStream } from "@uji-ai/ai";
import type { StreamFn } from "../src/types.ts";
import { AgentHarness } from "../src/harness/agent-harness.ts";
import { inlinePlugin, systemPromptPlugin } from "../src/plugins/index.ts";
import { SqliteSessionRepo, type SessionStorage } from "../src/store.ts";
import { pendingQueue, prompt, submit, waitFinished, waitForIdle } from "./harness-driver.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const usage: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model<"openai-responses"> = {
  id: "queue-test",
  name: "Queue test",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};

function assistant(stopReason: "stop" | "aborted", errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: stopReason === "stop" ? [{ type: "text", text: "done" }] : [],
    api: "openai-responses",
    provider: "openai",
    model: model.id,
    usage,
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: Date.now(),
  };
}

function finalStream(message: AssistantMessage): AssistantMessageEventStream {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (message.stopReason === "aborted") {
      events.push({ type: "error", reason: "aborted", error: message });
    } else {
      events.push({ type: "done", reason: "stop", message });
    }
  });
  return events;
}

function abortableThenStop(seen: Message[][]): StreamFn {
  let call = 0;
  return (_model, context, options) => {
    seen.push(context.messages);
    call += 1;
    if (call !== 1) return finalStream(assistant("stop"));

    const events = createAssistantMessageEventStream();
    const finish = () => {
      events.push({
        type: "error",
        reason: "aborted",
        error: assistant("aborted", "Request was aborted"),
      });
    };
    if (options?.signal?.aborted === true) queueMicrotask(finish);
    else options?.signal?.addEventListener("abort", finish, { once: true });
    return events;
  };
}

function gatedThenStop(seen: Message[][]): { streamFn: StreamFn; release: () => void } {
  let release: (() => void) | undefined;
  let released = false;
  let call = 0;
  return {
    streamFn: (_model, context) => {
      seen.push(context.messages);
      call += 1;
      if (call !== 1) return finalStream(assistant("stop"));
      const events = createAssistantMessageEventStream();
      release = () => events.push({ type: "done", reason: "stop", message: assistant("stop") });
      if (released) queueMicrotask(release);
      return events;
    },
    release: () => {
      released = true;
      release?.();
    },
  };
}

async function open(
  streamFn: StreamFn,
  wrapSession: (session: SessionStorage) => SessionStorage = (session) => session,
) {
  const directory = mkdtempSync(join(tmpdir(), "uji-harness-queue-"));
  directories.push(directory);
  const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
  const session = await repo.create();
  const harness = await AgentHarness.create({
    session: wrapSession(session),
    streamFn,
    plugins: [inlinePlugin(systemPromptPlugin("sys"))],
    env: { cwd: "/" },
    model,
  });
  harness.attach();
  return {
    harness,
    close: async () => {
      await harness.close();
      await session.close();
      await repo.close();
    },
  };
}

function userText(message: Message | undefined): string | undefined {
  return message?.role === "user" && typeof message.content === "string"
    ? message.content
    : undefined;
}

void describe("AgentHarness durable queue", () => {
  void test("close aborts an active provider stream", async () => {
    const seen: Message[][] = [];
    const h = await open(abortableThenStop(seen));
    const started = await submit(h.harness, "work");
    const running = waitFinished(h.harness.session, started.runId);

    await h.harness.close();
    const result = await running;
    assert.equal(result.outcome.kind, "aborted");
    await h.close();
  });

  void test("uses the durable session id as the default provider session id", async () => {
    let providerSessionId: string | undefined;
    const h = await open((_model, _context, options) => {
      providerSessionId = options?.sessionId;
      return finalStream(assistant("stop"));
    });
    const durableSessionId = (await h.harness.session.getMetadata()).id;

    await prompt(h.harness, "work");
    assert.equal(providerSessionId, durableSessionId);
    await h.close();
  });

  void test("queued input survives an aborted run and is delivered once by the next run", async () => {
    const seen: Message[][] = [];
    const h = await open(abortableThenStop(seen));
    const started = await submit(h.harness, "first");
    const first = waitFinished(h.harness.session, started.runId);
    const queued = await submit(h.harness, "after abort", "queue");
    assert.equal(queued.disposition, "queued");
    await h.harness.abort();
    const aborted = await first;

    assert.equal(aborted.outcome.kind, "aborted");
    assert.deepEqual(
      (await pendingQueue(h.harness)).map((item) => [item.delivery, item.content]),
      [["queue", "after abort"]],
    );

    const wake = await submit(h.harness, "wake");
    assert.equal(wake.disposition, "started");
    await waitForIdle(h.harness);
    assert.equal(seen.length, 3);
    assert.equal(userText(seen[2]?.at(-1)), "after abort");
    assert.deepEqual(await pendingQueue(h.harness), []);
    await h.close();
  });

  void test("interrupt with continue resumes pending steers but leaves explicit queues parked", async () => {
    const seen: Message[][] = [];
    const h = await open(abortableThenStop(seen));
    const started = await submit(h.harness, "first");
    const first = waitFinished(h.harness.session, started.runId);
    const steer = await submit(h.harness, "keep going");
    const queued = await submit(h.harness, "later", "queue");
    assert.equal(steer.disposition, "queued");
    assert.equal(queued.disposition, "queued");

    await h.harness.abort({ continue: true });
    const interrupted = await first;
    assert.equal(interrupted.outcome.kind, "aborted");
    // The steer wakes a run of its own once the aborted one has settled.
    while ((await h.harness.session.getEntry(steer.entryId)) === undefined)
      await new Promise<void>((resolve) => setImmediate(resolve));
    await waitForIdle(h.harness);
    assert.equal(seen.length, 2);
    assert.equal(userText(seen[1]?.at(-1)), "keep going");
    assert.deepEqual(
      (await pendingQueue(h.harness)).map((item) => [item.delivery, item.content]),
      [["queue", "later"]],
    );
    await h.close();
  });

  void test("cancelQueued withdraws a pending follow-up before any run consumes it", async () => {
    const seen: Message[][] = [];
    const h = await open(abortableThenStop(seen));
    const started = await submit(h.harness, "first");
    const first = waitFinished(h.harness.session, started.runId);
    const queued = await submit(h.harness, "never sent", "queue");
    if (queued.disposition !== "queued") throw new Error("expected the follow-up to queue");
    const entryId = queued.entryId;

    assert.deepEqual(await h.harness.cancelQueued(entryId), { kind: "cancelled" });
    assert.deepEqual(await pendingQueue(h.harness), []);

    await h.harness.abort();
    await first;
    // The follow-up never joins a later run even though the head went idle.
    await submit(h.harness, "wake");
    await waitForIdle(h.harness);
    for (const messages of seen) {
      assert.notEqual(userText(messages.at(-1)), "never sent");
    }
    await h.close();
  });

  void test("a cancelled steer is not woken into the next run", async () => {
    const seen: Message[][] = [];
    const h = await open(abortableThenStop(seen));
    const started = await submit(h.harness, "first");
    const first = waitFinished(h.harness.session, started.runId);
    const steer = await submit(h.harness, "interject");
    if (steer.disposition !== "queued") throw new Error("expected the steer to queue");
    assert.deepEqual(await h.harness.cancelQueued(steer.entryId), { kind: "cancelled" });

    await h.harness.abort({ continue: true });
    const interrupted = await first;
    assert.equal(interrupted.outcome.kind, "aborted");
    // abort({continue}) wakes pending steers at the run boundary; this one is gone.
    await waitForIdle(h.harness);
    for (const messages of seen.slice(1)) {
      assert.notEqual(userText(messages.at(-1)), "interject");
    }
    await h.close();
  });

  void test("cancelling an unknown or already-consumed item answers without writing", async () => {
    const seen: Message[][] = [];
    const gated = gatedThenStop(seen);
    const h = await open(gated.streamFn);

    assert.deepEqual(await h.harness.cancelQueued("e-nonexistent"), { kind: "not_found" });

    const running = await submit(h.harness, "first");
    assert.equal(running.disposition, "started");
    const second = await submit(h.harness, "second");
    if (second.disposition !== "queued") throw new Error("expected the second submit to queue");

    gated.release();
    await waitForIdle(h.harness);
    // Drained at the first checkpoint the run reached after it queued.
    assert.ok(seen.some((messages) => userText(messages.at(-1)) === "second"));
    assert.deepEqual(await h.harness.cancelQueued(second.entryId), { kind: "already_consumed" });
    await h.close();
  });

  void test("redeliverQueued moves a parked follow-up into the running turn", async () => {
    const seen: Message[][] = [];
    const gated = gatedThenStop(seen);
    const h = await open(gated.streamFn);

    const running = await submit(h.harness, "first");
    assert.equal(running.disposition, "started");
    const queued = await submit(h.harness, "later", "queue");
    if (queued.disposition !== "queued") throw new Error("expected the follow-up to queue");

    assert.deepEqual(await h.harness.redeliverQueued(queued.entryId, "steer"), {
      kind: "redelivered",
      delivery: "steer",
    });

    gated.release();
    await waitForIdle(h.harness);
    // It reached the turn that was already running. Which boundary it landed
    // on is the runner's business — before the first provider call when the
    // run has not started one yet, the next checkpoint otherwise — but it is
    // that run, not a second one.
    assert.ok(
      seen.some((messages) => userText(messages.at(-1)) === "later"),
      "the re-delivered message never reached the model",
    );
    assert.equal((await h.harness.session.findRecords({ type: "operation_started" })).length, 1);
    assert.deepEqual(await pendingQueue(h.harness), []);
    await h.close();
  });

  void test("a follow-up parked by an abort runs when it is re-delivered as a steer", async () => {
    const seen: Message[][] = [];
    const h = await open(abortableThenStop(seen));
    const started = await submit(h.harness, "first");
    const first = waitFinished(h.harness.session, started.runId);
    const queued = await submit(h.harness, "later", "queue");
    if (queued.disposition !== "queued") throw new Error("expected the follow-up to queue");
    await h.harness.abort({ continue: true });
    assert.equal((await first).outcome.kind, "aborted");
    await waitForIdle(h.harness);
    // Parked: an abort leaves explicit follow-ups for a later run.
    assert.equal((await pendingQueue(h.harness)).length, 1);

    const steered = await h.harness.redeliverQueued(queued.entryId, "steer");
    assert.equal(steered.kind, "redelivered");
    await waitForIdle(h.harness);
    // The re-delivery is also the wake: nothing else was sent.
    assert.equal(userText(seen.at(-1)?.at(-1)), "later");
    assert.deepEqual(await pendingQueue(h.harness), []);
    await h.close();
  });

  void test("a steer moved back to the queue waits for the run instead of joining it", async () => {
    const seen: Message[][] = [];
    const gated = gatedThenStop(seen);
    const h = await open(gated.streamFn);

    await submit(h.harness, "first");
    // The run must be inside the provider call before the interject arrives,
    // or the first step's checkpoint drain consumes it before the move.
    while (seen.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const steer = await submit(h.harness, "interject");
    if (steer.disposition !== "queued") throw new Error("expected the steer to queue");

    assert.deepEqual(await h.harness.redeliverQueued(steer.entryId, "queue"), {
      kind: "redelivered",
      delivery: "queue",
    });
    assert.deepEqual(
      (await pendingQueue(h.harness)).map((item) => item.delivery),
      ["queue"],
    );

    gated.release();
    await waitForIdle(h.harness);
    // The first turn ran alone; the follow-up opened the next one.
    assert.equal(userText(seen[0]?.at(-1)), "first");
    assert.equal(userText(seen[1]?.at(-1)), "interject");
    await h.close();
  });

  /**
   * Ported from OpenCode v2's "moves pending input between steer and queue
   * delivery", assertion for assertion: order survives the move, steering wakes
   * a run and queueing does not, one announcement per move, and asking for the
   * lane an item already holds is a conflict rather than a quiet success.
   * https://github.com/anomalyco/opencode/blob/v2/packages/core/test/session-prompt.test.ts
   */
  void test("moves pending input between steer and queue delivery", async () => {
    const seen: Message[][] = [];
    const gated = gatedThenStop(seen);
    const h = await open(gated.streamFn);
    await submit(h.harness, "first");
    // The run must already be inside the provider call, or it drains what
    // follows before there is anything to move. A live claim is also what
    // keeps the wake a no-op, which is how OpenCode's test reads it: their
    // wake is a spy, here it is a claim nobody else can take.
    while (seen.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));

    const queued = await submit(h.harness, "Steer this", "queue");
    const alreadySteered = await submit(h.harness, "Already steer");
    if (queued.disposition !== "queued" || alreadySteered.disposition !== "queued") {
      throw new Error("expected both messages to be pending");
    }
    const lanes = async () =>
      (await pendingQueue(h.harness)).map((item) => [item.entryId, item.delivery]);
    assert.deepEqual(await lanes(), [
      [queued.entryId, "queue"],
      [alreadySteered.entryId, "steer"],
    ]);

    assert.equal((await h.harness.redeliverQueued(queued.entryId, "steer")).kind, "redelivered");
    // Admission order survives the move: the item keeps the place it has held
    // all along, and only its lane changed.
    assert.deepEqual(await lanes(), [
      [queued.entryId, "steer"],
      [alreadySteered.entryId, "steer"],
    ]);

    assert.equal((await h.harness.redeliverQueued(queued.entryId, "queue")).kind, "redelivered");
    assert.deepEqual(await lanes(), [
      [queued.entryId, "queue"],
      [alreadySteered.entryId, "steer"],
    ]);

    // Asking for the lane an item already holds is a conflict, and writes
    // nothing: no record, no change.
    assert.deepEqual(await h.harness.redeliverQueued(alreadySteered.entryId, "steer"), {
      kind: "unchanged",
      delivery: "steer",
    });
    assert.deepEqual(await lanes(), [
      [queued.entryId, "queue"],
      [alreadySteered.entryId, "steer"],
    ]);

    assert.deepEqual(await h.harness.cancelQueued(alreadySteered.entryId), { kind: "cancelled" });
    assert.deepEqual(await lanes(), [[queued.entryId, "queue"]]);

    gated.release();
    await waitForIdle(h.harness);
    await h.close();
  });

  void test("re-delivering an unknown or consumed item answers without writing", async () => {
    const seen: Message[][] = [];
    const gated = gatedThenStop(seen);
    const h = await open(gated.streamFn);

    assert.deepEqual(await h.harness.redeliverQueued("e-nonexistent", "steer"), {
      kind: "not_found",
    });

    await submit(h.harness, "first");
    const second = await submit(h.harness, "second");
    const withdrawn = await submit(h.harness, "withdrawn", "queue");
    if (second.disposition !== "queued" || withdrawn.disposition !== "queued") {
      throw new Error("expected both submits to queue");
    }
    // A cancelled item is gone, not merely in the other lane.
    assert.deepEqual(await h.harness.cancelQueued(withdrawn.entryId), { kind: "cancelled" });
    assert.deepEqual(await h.harness.redeliverQueued(withdrawn.entryId, "steer"), {
      kind: "already_consumed",
    });

    gated.release();
    await waitForIdle(h.harness);
    assert.deepEqual(await h.harness.redeliverQueued(second.entryId, "queue"), {
      kind: "already_consumed",
    });
    await h.close();
  });
});
