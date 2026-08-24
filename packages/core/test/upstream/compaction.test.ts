/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/test/harness/compaction.test.ts
 * and https://github.com/earendil-works/pi/blob/dev/packages/agent/test/harness/session-context.test.ts
 * Synced with pi d4edf066f. Adapted only to Uji's message schema and injected StreamFn.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  EventStream,
  type Message,
  type Model,
  type Usage,
} from "@uji-ai/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentHarness,
  buildSessionContext,
  calculateContextTokens,
  COMPACTION_SUMMARY_PREFIX,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  findCutPoint,
  inlinePlugin,
  prepareCompaction,
  shouldCompact,
  SqliteSessionRepo,
  SUMMARIZATION_SYSTEM_PROMPT,
  systemPromptPlugin,
} from "../../src/index.ts";
import type { CompactionEntry, Entry, MessageEntry } from "../../src/harness/session/types.ts";
import type { StreamFn } from "../../src/types.ts";

const temporaryDirectories: string[] = [];
let nextEntryId = 0;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  nextEntryId = 0;
});

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function model(): Model<"openai-responses"> {
  return {
    id: "test-model",
    name: "Test model",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
}

function user(text: string, timestamp = Date.now()): Message {
  return { role: "user", content: text, timestamp };
}

function assistant(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
  messageUsage = usage(100, 20),
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: text.length === 0 ? [] : [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: messageUsage,
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: Date.now(),
  };
}

function messageEntry(message: Message, parentId: string | null = null): MessageEntry {
  nextEntryId += 1;
  return {
    type: "message",
    id: `entry-${nextEntryId}`,
    parentId,
    seq: nextEntryId,
    timestamp: message.timestamp,
    message,
  };
}

function compactionEntry(
  summary: string,
  retainedTail: Message[],
  parentId: string | null = null,
): CompactionEntry {
  nextEntryId += 1;
  return {
    type: "compaction",
    id: `entry-${nextEntryId}`,
    parentId,
    seq: nextEntryId,
    timestamp: Date.now(),
    summary,
    retainedTail,
    tokensBefore: 500,
    fromHook: false,
  };
}

function messageStream(message: AssistantMessage): AssistantMessageEventStream {
  const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
      throw new Error("stream ended without a terminal event");
    },
  );
  queueMicrotask(() => {
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
      return;
    }
    if (message.stopReason === "pending") {
      throw new Error("a final test message cannot be pending");
    }
    stream.push({ type: "done", reason: message.stopReason, message });
  });
  return stream;
}

function createRepo(): { directory: string; repo: SqliteSessionRepo } {
  const directory = mkdtempSync(join(tmpdir(), "uji-compaction-"));
  temporaryDirectories.push(directory);
  return { directory, repo: new SqliteSessionRepo(join(directory, "sessions.db")) };
}

async function appendMessages(
  session: Awaited<ReturnType<SqliteSessionRepo["create"]>>,
  messages: Message[],
): Promise<void> {
  for (const message of messages) {
    nextEntryId += 1;
    await session.appendEntry({ type: "message", id: `seed-${nextEntryId}`, message }, "main");
  }
}

describe("Pi compaction helpers", () => {
  it("calculates usage and applies the configured threshold", () => {
    expect(calculateContextTokens(usage(1_000, 500, 200, 100))).toBe(1_800);
    expect(
      shouldCompact(95_000, 100_000, {
        enabled: true,
        reserveTokens: 10_000,
        keepRecentTokens: 20_000,
      }),
    ).toBe(true);
    expect(
      shouldCompact(95_000, 100_000, {
        enabled: false,
        reserveTokens: 10_000,
        keepRecentTokens: 20_000,
      }),
    ).toBe(false);
  });

  it("finds a valid cut point and carries the prior summary into repeated compaction", () => {
    const retainedUser = user("retained user");
    const retainedAssistant = assistant("retained assistant");
    const prior = compactionEntry("previous summary", [retainedUser, retainedAssistant]);
    const nextUser = messageEntry(user("new user"), prior.id);
    const nextAssistant = messageEntry(assistant("new assistant"), nextUser.id);
    const entries: Entry[] = [prior, nextUser, nextAssistant];

    const cut = findCutPoint(entries, 0, entries.length, 1);
    expect(entries[cut.firstKeptEntryIndex]?.type).toBe("message");

    const prepared = prepareCompaction(entries, {
      ...DEFAULT_COMPACTION_SETTINGS,
      reserveTokens: 100,
      keepRecentTokens: 1,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || prepared.value === undefined) return;
    expect(prepared.value.previousSummary).toBe("previous summary");
    expect([
      ...prepared.value.messagesToSummarize,
      ...prepared.value.turnPrefixMessages,
      ...prepared.value.retainedTail,
    ]).toEqual([retainedUser, retainedAssistant, nextUser.message, nextAssistant.message]);
  });

  it("projects only the latest checkpoint and filters failed retained responses", () => {
    const first = compactionEntry("stale", [user("stale tail")]);
    const between = messageEntry(user("between"), first.id);
    const failed = assistant("", "error", usage(0, 0), "provider failed");
    const latest = compactionEntry("latest", [failed, user("kept")], between.id);
    const after = messageEntry(user("after"), latest.id);

    const projected = buildSessionContext([first, between, latest, after]);
    expect(projected).toHaveLength(3);
    expect(projected[0]).toMatchObject({ role: "user" });
    expect(projected[0]?.content).toEqual([
      {
        type: "text",
        text: `${COMPACTION_SUMMARY_PREFIX}latest\n</summary>`,
      },
    ]);
    expect(projected.slice(1)).toEqual([latest.retainedTail[1], after.message]);
  });

  it("uses provider usage plus trailing estimates", () => {
    const base = assistant("answer", "stop", usage(10, 5, 3, 2));
    const estimate = estimateContextTokens([base, user("continue")]);
    expect(estimate.usageTokens).toBe(20);
    expect(estimate.lastUsageIndex).toBe(0);
    expect(estimate.tokens).toBe(estimate.usageTokens + estimate.trailingTokens);
  });
});

describe("AgentHarness compaction", () => {
  it("exposes manual compaction and persists its checkpoint and usage", async () => {
    const { repo } = createRepo();
    const session = await repo.create();
    await appendMessages(session, [user("first request"), assistant("first answer"), user("keep")]);

    const streamFn: StreamFn = (_requestModel, context) => {
      expect(context.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
      return messageStream(assistant("durable summary", "stop", usage(12, 4)));
    };
    const { harness } = await AgentHarness.create({
      session,
      streamFn,
      plugins: [inlinePlugin(systemPromptPlugin("agent"))],
      env: { cwd: "/" },
      model: model(),
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
    });
    const eventTypes: string[] = [];
    harness.subscribe((event) => {
      eventTypes.push(event.type);
    });

    const result = await harness.compact({ customInstructions: "Preserve decisions" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.operation).toBe("compaction");
    expect(result.value.kind).toBe("completed");
    if (result.value.kind !== "completed") return;
    expect(result.value.entry.summary).toContain("durable summary");
    expect(eventTypes).toEqual(["compaction_start", "compaction_end"]);

    const branch = await session.getBranch("main");
    expect(branch.at(-1)?.type).toBe("compaction");
    expect(buildSessionContext(branch)[0]?.role).toBe("user");
    expect((await session.findRecords({ type: "usage" }))[0]?.cause).toBe("compaction");
    expect(await session.findOpenOperations("main")).toEqual([]);

    await harness.close();
    await session.close();
    await repo.close();
  });

  it("compacts before a run when the prior response crossed the threshold", async () => {
    const { repo } = createRepo();
    const session = await repo.create();
    await appendMessages(session, [
      user("large request"),
      assistant("large answer", "stop", usage(930, 20)),
    ]);
    let summaryCalls = 0;
    const mainContexts: Message[][] = [];
    const streamFn: StreamFn = (_requestModel, context) => {
      if (context.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT) {
        summaryCalls += 1;
        return messageStream(assistant("threshold summary", "stop", usage(10, 5)));
      }
      mainContexts.push(context.messages);
      return messageStream(assistant("done"));
    };
    const { harness } = await AgentHarness.create({
      session,
      streamFn,
      plugins: [inlinePlugin(systemPromptPlugin("agent"))],
      env: { cwd: "/" },
      model: model(),
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
    });

    const result = await harness.prompt("continue");
    expect(result.ok).toBe(true);
    expect(summaryCalls).toBe(1);
    expect(mainContexts).toHaveLength(1);
    expect(mainContexts[0]?.[0]).toMatchObject({ role: "user" });
    expect(await session.findEntries({ type: "compaction" })).toHaveLength(1);

    await harness.close();
    await session.close();
    await repo.close();
  });

  it("compacts an overflow and retries the interrupted turn once", async () => {
    const { repo } = createRepo();
    const session = await repo.create();
    let summaryCalls = 0;
    let mainCalls = 0;
    const retryContexts: Message[][] = [];
    const streamFn: StreamFn = (_requestModel, context) => {
      if (context.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT) {
        summaryCalls += 1;
        return messageStream(assistant("overflow summary", "stop", usage(10, 5)));
      }
      mainCalls += 1;
      retryContexts.push(context.messages);
      if (mainCalls === 1) {
        return messageStream(
          assistant("", "error", usage(0, 0), "Your input exceeds the context window"),
        );
      }
      return messageStream(assistant("recovered"));
    };
    const { harness } = await AgentHarness.create({
      session,
      streamFn,
      plugins: [inlinePlugin(systemPromptPlugin("agent"))],
      env: { cwd: "/" },
      model: model(),
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
    });

    const result = await harness.prompt("overflow please");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("completed");
    expect(summaryCalls).toBe(1);
    expect(mainCalls).toBe(2);
    expect(retryContexts[1]?.some((message) => message.role === "assistant")).toBe(false);
    expect(await session.findEntries({ type: "compaction" })).toHaveLength(1);

    await harness.close();
    await session.close();
    await repo.close();
  });

  it("compacts a successful silent overflow without retrying it", async () => {
    const { repo } = createRepo();
    const session = await repo.create();
    let summaryCalls = 0;
    let mainCalls = 0;
    const streamFn: StreamFn = (_requestModel, context) => {
      if (context.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT) {
        summaryCalls += 1;
        return messageStream(assistant("silent overflow summary", "stop", usage(10, 5)));
      }
      mainCalls += 1;
      return messageStream(assistant("complete answer", "stop", usage(1_001, 20)));
    };
    const { harness } = await AgentHarness.create({
      session,
      streamFn,
      plugins: [inlinePlugin(systemPromptPlugin("agent"))],
      env: { cwd: "/" },
      model: model(),
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
    });

    const result = await harness.prompt("large prompt");
    expect(result.ok).toBe(true);
    expect(mainCalls).toBe(1);
    expect(summaryCalls).toBe(1);
    expect(await session.findEntries({ type: "compaction" })).toHaveLength(1);

    await harness.close();
    await session.close();
    await repo.close();
  });

  it("bounds overflow recovery to one compact-and-retry attempt", async () => {
    const { repo } = createRepo();
    const session = await repo.create();
    let summaryCalls = 0;
    let mainCalls = 0;
    const streamFn: StreamFn = (_requestModel, context) => {
      if (context.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT) {
        summaryCalls += 1;
        return messageStream(assistant("overflow summary", "stop", usage(10, 5)));
      }
      mainCalls += 1;
      return messageStream(
        assistant("", "error", usage(0, 0), "Your input exceeds the context window"),
      );
    };
    const { harness } = await AgentHarness.create({
      session,
      streamFn,
      plugins: [inlinePlugin(systemPromptPlugin("agent"))],
      env: { cwd: "/" },
      model: model(),
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
    });

    const result = await harness.prompt("overflow twice");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("failed");
    expect(mainCalls).toBe(2);
    expect(summaryCalls).toBe(1);
    expect(await session.findEntries({ type: "compaction" })).toHaveLength(1);

    await harness.close();
    await session.close();
    await repo.close();
  });

  it("resumes a durable compaction operation", async () => {
    const { repo } = createRepo();
    const session = await repo.create();
    await appendMessages(session, [user("first"), assistant("answer"), user("keep")]);
    const operationId = "compact-interrupted";
    const claim = await session.claimRun("main", operationId);
    if (!claim.ok) throw new Error("expected compaction seed claim");
    await claim.writer.appendRecord({
      type: "operation_started",
      id: operationId,
      head: "main",
      sourceLeafId: await session.getLeafId("main"),
      intent: { kind: "compaction", customInstructions: "Keep the plan" },
    });
    await claim.writer.release();
    const streamFn: StreamFn = (_requestModel, context) => {
      expect(context.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
      return messageStream(assistant("resumed summary", "stop", usage(10, 5)));
    };
    const created = await AgentHarness.create({
      session,
      streamFn,
      plugins: [inlinePlugin(systemPromptPlugin("agent"))],
      env: { cwd: "/" },
      model: model(),
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
    });
    expect(created.suspended).toEqual([
      expect.objectContaining({ id: operationId, kind: "compaction" }),
    ]);

    const resumed = await created.harness.resume();
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value).toMatchObject({
      operation: "compaction",
      runId: operationId,
      kind: "completed",
    });
    expect(await session.findOpenOperations("main")).toEqual([]);

    await created.harness.close();
    await session.close();
    await repo.close();
  });
});
