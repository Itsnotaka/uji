/**
 * Retries are published, not silent. A transient provider failure must reach a client
 * as `retry_scheduled` / `retry_started`, and a first-try success must emit
 * none of them (pi harness.md 5.5).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { AssistantMessage, AssistantMessageEvent, Message, Model, Usage } from "@uji-ai/ai";
import { EventStream } from "@uji-ai/ai";
import type { StreamFn } from "../src/types.ts";
import { AgentHarness } from "../src/harness/agent-harness.ts";
import type { EphemeralEvent } from "../src/sdk/types.ts";
import { inlinePlugin, systemPromptPlugin } from "../src/plugins/index.ts";
import { SqliteSessionRepo } from "../src/store.ts";
import { prompt, submit, waitFinished } from "./harness-driver.ts";

type RetryEvent = Extract<EphemeralEvent, { kind: "retry_scheduled" | "retry_started" }>;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
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
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};

function message(text: string, errorMessage?: string): AssistantMessage {
  const base: Omit<AssistantMessage, "stopReason"> = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage,
    timestamp: Date.now(),
  };
  return errorMessage === undefined
    ? { ...base, stopReason: "stop" }
    : { ...base, stopReason: "error", errorMessage };
}

function settle(result: AssistantMessage): EventStream<AssistantMessageEvent, AssistantMessage> {
  const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
      throw new Error("no terminal event");
    },
  );
  queueMicrotask(() => {
    if (result.stopReason === "error")
      events.push({ type: "error", reason: "error", error: result });
    else events.push({ type: "done", reason: "stop", message: result });
  });
  return events;
}

/**
 * Answers the conversation turn normally; fails the summarization request
 * `failures` times with a transient error before letting it through.
 */
function flakySummaryStream(failures: number): StreamFn {
  let summaryCalls = 0;
  return async (_model, context, _options) => {
    const isSummary = context.systemPrompt?.includes("summar") === true;
    if (!isSummary) return settle(message("reply"));
    summaryCalls += 1;
    return settle(
      summaryCalls <= failures ? message("", "Connection error.") : message("a short summary"),
    );
  };
}

async function open(streamFn: StreamFn, retryOverrides?: { baseDelayMs?: number }) {
  const directory = mkdtempSync(join(tmpdir(), "uji-retry-"));
  directories.push(directory);
  const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
  const session = await repo.create();
  const events: EphemeralEvent[] = [];
  const harness = await AgentHarness.create({
    session,
    streamFn,
    plugins: [inlinePlugin(systemPromptPlugin("base"))],
    env: { cwd: directory },
    model,
    retry: { enabled: true, maxRetries: 2, baseDelayMs: retryOverrides?.baseDelayMs ?? 0 },
  });
  harness.attach();
  harness.subscribe((event) => {
    events.push(event);
  });
  return {
    harness,
    events,
    retries: () =>
      events.filter(
        (event): event is RetryEvent =>
          event.kind === "retry_scheduled" || event.kind === "retry_started",
      ),
    records: async () => session.findRecords({ type: "retry_scheduled" }),
    close: async () => {
      await harness.close();
      await session.close();
      await repo.close();
    },
  };
}

/**
 * Fails the conversation turn `failures` times with a transient error, then answers.
 * Records the context each attempt was given.
 */
function flakyAssistantStream(failures: number, seen: Message[][]): StreamFn {
  let calls = 0;
  return async (_model, context, _options) => {
    seen.push([...context.messages]);
    calls += 1;
    return settle(calls <= failures ? message("", "Connection error.") : message("answered"));
  };
}

void describe("assistant retry", () => {
  void test("a transient failure is retried instead of ending the run", async () => {
    const seen: Message[][] = [];
    const session = await open(flakyAssistantStream(1, seen));
    try {
      const result = await prompt(session.harness, "hello");
      assert.equal(result.outcome.kind, "completed");
      assert.equal(seen.length, 2);

      const retries = session.retries();
      assert.deepEqual(
        retries.map((event) => event.kind),
        ["retry_scheduled", "retry_started"],
      );
      const scheduled = retries[0];
      assert.ok(scheduled?.kind === "retry_scheduled");
      assert.equal(scheduled.message, "Connection error.");
    } finally {
      await session.close();
    }
  });

  void test("the wake time is durable, so a lost process resumes the wait", async () => {
    const session = await open(flakyAssistantStream(1, []));
    try {
      await prompt(session.harness, "hello");
      const scheduled = await session.records();
      assert.equal(scheduled.length, 1);
      const only = scheduled[0];
      assert.ok(only !== undefined);
      assert.equal(only.attempt, 1, "the first retry");
      assert.equal(only.errorMessage, "Connection error.");
      assert.ok(only.notBefore > 0);
    } finally {
      await session.close();
    }
  });

  void test("the failed turn stays in the tree but never reaches the next attempt", async () => {
    const seen: Message[][] = [];
    const session = await open(flakyAssistantStream(1, seen));
    try {
      await prompt(session.harness, "hello");

      const branch = await session.harness.session.getBranch("main");
      const stored = branch.flatMap((entry) =>
        entry.type === "message" && entry.message.role === "assistant"
          ? [entry.message.stopReason]
          : [],
      );
      assert.deepEqual(stored, ["error", "stop"], "the billed failure is durable history");

      const retryContext = seen[1] ?? [];
      assert.equal(
        retryContext.filter((entry) => entry.role === "assistant").length,
        0,
        "the failed turn must not poison the retry",
      );
    } finally {
      await session.close();
    }
  });

  void test("an exhausted budget fails the run with the provider's error", async () => {
    const seen: Message[][] = [];
    const session = await open(flakyAssistantStream(Number.POSITIVE_INFINITY, seen));
    try {
      const result = await prompt(session.harness, "hello");
      assert.equal(result.outcome.kind, "failed");
      if (result.outcome.kind === "failed") {
        assert.equal(result.outcome.error.message, "Connection error.");
      }
      // The first attempt plus the policy's two retries.
      assert.equal(seen.length, 3);
    } finally {
      await session.close();
    }
  });

  void test("the committed backoff is actually waited out", async () => {
    const session = await open(flakyAssistantStream(1, []), { baseDelayMs: 120 });
    try {
      const startedAt = Date.now();
      const result = await prompt(session.harness, "hello");
      assert.equal(result.outcome.kind, "completed");
      assert.ok(
        Date.now() - startedAt >= 110,
        "the run must not race past its own committed wake time",
      );
    } finally {
      await session.close();
    }
  });

  void test("an abort during backoff stops the run instead of retrying", async () => {
    const session = await open(flakyAssistantStream(1, []), { baseDelayMs: 10_000 });
    try {
      const started = await submit(session.harness, "hello");
      const running = waitFinished(session.harness.session, started.runId);
      while (session.retries().length === 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      await session.harness.abort();
      const result = await running;
      assert.equal(result.outcome.kind, "aborted");
    } finally {
      await session.close();
    }
  });

  void test("a non-transient failure is not retried", async () => {
    const seen: Message[][] = [];
    let calls = 0;
    const session = await open(async (_model, context, _options) => {
      seen.push([...context.messages]);
      calls += 1;
      return settle(message("", "invalid_api_key: check your credentials"));
    });
    try {
      const result = await prompt(session.harness, "hello");
      assert.equal(result.outcome.kind, "failed");
      assert.equal(calls, 1);
      assert.deepEqual(session.retries(), []);
    } finally {
      await session.close();
    }
  });
});

void describe("retry events", () => {
  void test("a transient compaction failure is published, then recovers", async () => {
    const session = await open(flakySummaryStream(1));
    try {
      await prompt(session.harness, "hello");
      const compacted = await session.harness.compact();
      assert.equal(compacted.kind, "compacted");

      const retries = session.retries();
      assert.deepEqual(
        retries.map((event) => event.kind),
        ["retry_scheduled", "retry_started"],
      );

      const scheduled = retries[0];
      assert.ok(scheduled?.kind === "retry_scheduled");
      assert.equal(scheduled.attempt, 1);
      assert.equal(scheduled.maxAttempts, 2);
      assert.equal(scheduled.message, "Connection error.");
    } finally {
      await session.close();
    }
  });

  void test("an exhausted budget stops scheduling and the step reports the failure", async () => {
    const session = await open(flakySummaryStream(Number.POSITIVE_INFINITY));
    try {
      await prompt(session.harness, "hello");
      const compacted = await session.harness.compact();

      assert.deepEqual(
        session.retries().map((event) => event.kind),
        ["retry_scheduled", "retry_started", "retry_scheduled", "retry_started"],
      );
      assert.equal(compacted.kind, "failed");
    } finally {
      await session.close();
    }
  });

  void test("a first-try success stays silent", async () => {
    const session = await open(flakySummaryStream(0));
    try {
      await prompt(session.harness, "hello");
      await session.harness.compact();
      assert.deepEqual(session.retries(), []);
    } finally {
      await session.close();
    }
  });
});
