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
import {
  AgentHarness,
  type HarnessEvent,
  inlinePlugin,
  type SessionStorage,
  SqliteSessionRepo,
  systemPromptPlugin,
} from "../src/index.ts";
import type { StreamFn } from "../src/types.ts";

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
  const { harness } = await AgentHarness.create({
    session: wrapSession(session),
    streamFn,
    plugins: [inlinePlugin(systemPromptPlugin("sys"))],
    env: { cwd: "/" },
    model,
  });
  const events: HarnessEvent[] = [];
  harness.subscribe((event) => {
    events.push(event);
  });
  return {
    harness,
    events,
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
    const running = h.harness.prompt("work");
    while (!h.harness.state.isStreaming)
      await new Promise<void>((resolve) => setImmediate(resolve));

    await h.harness.close();
    const result = await running;
    assert.equal(result.ok && result.value.kind, "aborted");
    await h.close();
  });

  void test("uses the durable session id as the default provider session id", async () => {
    let providerSessionId: string | undefined;
    const h = await open((_model, _context, options) => {
      providerSessionId = options?.sessionId;
      return finalStream(assistant("stop"));
    });
    const durableSessionId = (await h.harness.session.getMetadata()).id;

    await h.harness.prompt("work");
    assert.equal(providerSessionId, durableSessionId);
    await h.close();
  });

  void test("queued input survives an aborted run and is delivered once by the next run", async () => {
    const seen: Message[][] = [];
    const h = await open(abortableThenStop(seen));
    const first = h.harness.prompt("first");

    while (!h.harness.state.isStreaming)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const queued = await h.harness.submit("after abort", { delivery: "queue" });
    assert.equal(queued.ok && queued.value.disposition, "queued");
    await h.harness.abort();
    const aborted = await first;

    assert.equal(aborted.ok && aborted.value.kind, "aborted");
    assert.equal(h.harness.state.errorMessage, undefined);
    assert.deepEqual(
      (await h.harness.pendingQueue()).map((item) => [item.delivery, userText(item.message)]),
      [["queue", "after abort"]],
    );

    const wake = await h.harness.submit("wake");
    assert.equal(wake.ok && wake.value.disposition, "started");
    await h.harness.waitForIdle();
    assert.equal(seen.length, 3);
    assert.equal(userText(seen[2]?.at(-1)), "after abort");
    assert.deepEqual(await h.harness.pendingQueue(), []);
    const queueSizes = h.events
      .filter((event) => event.type === "queue_update")
      .map((event) => event.items.length);
    assert.deepEqual(queueSizes, [1, 0]);
    await h.close();
  });

  void test("interrupt with continue resumes pending steers but leaves explicit queues parked", async () => {
    const seen: Message[][] = [];
    const h = await open(abortableThenStop(seen));
    const first = h.harness.prompt("first");

    while (!h.harness.state.isStreaming)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const steer = await h.harness.submit("keep going");
    const queued = await h.harness.submit("later", { delivery: "queue" });
    assert.equal(steer.ok && steer.value.disposition, "queued");
    assert.equal(queued.ok && queued.value.disposition, "queued");

    await h.harness.abort({ continue: true });
    const interrupted = await first;
    assert.equal(interrupted.ok && interrupted.value.kind, "aborted");
    assert.equal(seen.length, 2);
    assert.equal(userText(seen[1]?.at(-1)), "keep going");
    assert.deepEqual(
      (await h.harness.pendingQueue()).map((item) => [item.delivery, userText(item.message)]),
      [["queue", "later"]],
    );
    await h.close();
  });

  void test("cancelQueued withdraws a pending follow-up before any run consumes it", async () => {
    const seen: Message[][] = [];
    const h = await open(abortableThenStop(seen));
    const first = h.harness.prompt("first");

    while (!h.harness.state.isStreaming)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const queued = await h.harness.submit("never sent", { delivery: "queue" });
    if (!queued.ok || queued.value.disposition !== "queued") {
      throw new Error("expected the follow-up to queue");
    }
    const entryId = queued.value.entryId;

    const cancelled = await h.harness.cancelQueued(entryId);
    assert.equal(cancelled.ok && cancelled.value.entryId, entryId);
    assert.deepEqual(await h.harness.pendingQueue(), []);

    await h.harness.abort();
    await first;
    // The follow-up never joins a later run even though the head went idle.
    await h.harness.submit("wake");
    await h.harness.waitForIdle();
    for (const messages of seen) {
      assert.notEqual(userText(messages.at(-1)), "never sent");
    }
    const updates = h.events
      .filter((event) => event.type === "queue_update")
      .map((event) => event.items.length);
    assert.deepEqual(updates, [1, 0]);
    await h.close();
  });

  void test("a cancelled steer is not woken into the next run", async () => {
    const seen: Message[][] = [];
    const h = await open(abortableThenStop(seen));
    const first = h.harness.prompt("first");

    while (!h.harness.state.isStreaming)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const steer = await h.harness.submit("interject");
    if (!steer.ok || steer.value.disposition !== "queued") {
      throw new Error("expected the steer to queue");
    }
    const entryId = steer.value.entryId;
    const cancelled = await h.harness.cancelQueued(entryId);
    assert.ok(cancelled.ok);

    await h.harness.abort({ continue: true });
    const interrupted = await first;
    assert.equal(interrupted.ok && interrupted.value.kind, "aborted");
    // abort({continue}) wakes pending steers at the run boundary; this one is gone.
    await h.harness.waitForIdle();
    for (const messages of seen.slice(1)) {
      assert.notEqual(userText(messages.at(-1)), "interject");
    }
    assert.equal(h.harness.state.isStreaming, false);
    await h.close();
  });

  void test("cancelling an unknown or already-consumed item answers NotQueued without writing", async () => {
    const seen: Message[][] = [];
    const gated = gatedThenStop(seen);
    const h = await open(gated.streamFn);

    const unknown = await h.harness.cancelQueued("e-nonexistent");
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error._tag, "NotQueued");

    const running = h.harness.submit("first");
    const second = await h.harness.submit("second");
    const firstAccepted = await running;
    assert.equal(firstAccepted.ok && firstAccepted.value.disposition, "started");
    if (!second.ok || second.value.disposition !== "queued") {
      throw new Error("expected the second submit to queue");
    }
    const entryId = second.value.entryId;

    gated.release();
    await h.harness.waitForIdle();
    assert.equal(userText(seen[0]?.at(-1)), "second");
    const consumed = await h.harness.cancelQueued(entryId);
    assert.equal(consumed.ok, false);
    if (!consumed.ok) assert.equal(consumed.error._tag, "NotQueued");
    await h.close();
  });
});
