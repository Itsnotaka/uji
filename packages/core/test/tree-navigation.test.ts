/** Tree projection and the durable navigation operation (design record: "Heads are named pointers"). */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { Context as AiContext } from "@uji-ai/ai/types";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Usage,
} from "@uji-ai/ai";
import {
  collectAbandonedEntries,
  navigationTarget,
  projectSessionTree,
  transcriptFromEntries,
} from "../src/index.ts";
import type { StreamFn } from "../src/types.ts";
import { AgentHarness } from "../src/harness/agent-harness.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../src/harness/compaction/compaction.ts";
import { inlinePlugin, systemPromptPlugin } from "../src/plugins/index.ts";
import type { MoveOutcome } from "../src/sdk/types.ts";
import {
  BRANCH_SUMMARY_PREFIX,
  SqliteSessionRepo,
  buildSessionContext,
  type BranchSummaryEntry,
  type Entry,
  type SessionStorage,
} from "../src/store.ts";
import { pendingQueue, prompt as promptHarness, submit, waitForIdle } from "./harness-driver.ts";

const directories: string[] = [];
const repositories: SqliteSessionRepo[] = [];
const harnesses: AgentHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close().catch(() => undefined);
  for (const repo of repositories.splice(0)) await repo.close();
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
  id: "tree-navigation-test",
  name: "Tree navigation test",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};

function assistant(text: string, stopReason: "stop" | "aborted" = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: stopReason === "stop" ? [{ type: "text", text }] : [],
    api: "openai-responses",
    provider: "openai",
    model: model.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

function finalStream(text: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant(text) }));
  return stream;
}

/**
 * A provider double that answers chat turns with `reply-N` and summarization
 * requests with `summary-N`, and can hold the next summarization open until
 * the test releases or aborts it.
 */
interface Provider {
  streamFn: StreamFn;
  chats: AiContext[];
  summaries: AiContext[];
  /** Hold the next summarization request; resolves once it is in flight. */
  hold(): Promise<void>;
  failNextSummary(message: string): void;
  release(): void;
}

function provider(): Provider {
  const chats: AiContext[] = [];
  const summaries: AiContext[] = [];
  let entered: (() => void) | undefined;
  let failure: string | undefined;
  let holding = false;
  let release: (() => void) | undefined;
  return {
    chats,
    summaries,
    hold() {
      holding = true;
      return new Promise<void>((resolve) => {
        entered = resolve;
      });
    },
    failNextSummary(message) {
      failure = message;
    },
    release() {
      holding = false;
      release?.();
    },
    streamFn: (_model, context, options) => {
      const isSummary = context.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT;
      if (!isSummary) {
        chats.push(context);
        return finalStream(`reply-${String(chats.length)}`);
      }
      summaries.push(context);
      const text = `summary-${String(summaries.length)}`;
      if (failure !== undefined) {
        const errorMessage = failure;
        failure = undefined;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() =>
          stream.push({
            type: "error",
            reason: "error",
            error: { ...assistant("", "aborted"), stopReason: "error", errorMessage },
          }),
        );
        return stream;
      }
      if (!holding) return finalStream(text);
      const stream = createAssistantMessageEventStream();
      let settled = false;
      release = () => {
        if (settled) return;
        settled = true;
        stream.push({ type: "done", reason: "stop", message: assistant(text) });
      };
      const abort = (): void => {
        if (settled) return;
        settled = true;
        stream.push({
          type: "error",
          reason: "aborted",
          error: assistant("", "aborted"),
        });
      };
      if (options?.signal?.aborted === true) queueMicrotask(abort);
      else options?.signal?.addEventListener("abort", abort, { once: true });
      entered?.();
      return stream;
    },
  };
}

async function openSession(): Promise<{ session: SessionStorage; path: string }> {
  const directory = mkdtempSync(join(tmpdir(), "uji-tree-navigation-"));
  directories.push(directory);
  const path = join(directory, "sessions.db");
  const repo = new SqliteSessionRepo(path);
  repositories.push(repo);
  return { session: await repo.create({ id: "tree" }), path };
}

async function createHarness(session: SessionStorage, streamFn: StreamFn): Promise<AgentHarness> {
  const harness = await AgentHarness.create({
    session,
    streamFn,
    plugins: [inlinePlugin(systemPromptPlugin("system"))],
    env: { cwd: "/" },
    model,
  });
  harness.attach();
  harnesses.push(harness);
  return harness;
}

/** u1 → a1 → u2 → a2 on main; returns the four entries oldest first. */
async function twoTurns(harness: AgentHarness): Promise<Entry[]> {
  assert.equal((await promptHarness(harness, "u1")).outcome.kind, "completed");
  assert.equal((await promptHarness(harness, "u2")).outcome.kind, "completed");
  const branch = await harness.session.getBranch("main");
  assert.deepEqual(
    branch.map((entry) => (entry.type === "message" ? entry.message.role : entry.type)),
    ["user", "assistant", "user", "assistant"],
  );
  return branch;
}

function userText(entry: Entry | undefined): string | undefined {
  if (entry?.type !== "message" || entry.message.role !== "user") return undefined;
  return typeof entry.message.content === "string" ? entry.message.content : undefined;
}

function restoredText(result: Extract<MoveOutcome, { kind: "moved" }>): string | undefined {
  const content = result.restored?.content;
  return typeof content === "string" ? content : undefined;
}

function completed(result: MoveOutcome): Extract<MoveOutcome, { kind: "moved" }> {
  assert.equal(result.kind, "moved", JSON.stringify(result));
  if (result.kind !== "moved") throw new Error("unreachable");
  return result;
}

/** The summary the latest navigation appended: the newest branch_summary entry on the log. */
async function latestSummary(session: SessionStorage): Promise<BranchSummaryEntry | undefined> {
  const summaries = await summaryEntries(session);
  const last = summaries.at(-1);
  return last?.type === "branch_summary" ? last : undefined;
}

/** The id of the most recent navigation operation. */
async function latestNavigationRunId(session: SessionStorage): Promise<string> {
  const started = (await session.findRecords({ type: "operation_started" })).filter(
    (record) => record.intent.kind === "navigation",
  );
  const last = started.at(-1);
  assert.ok(last);
  return last.id;
}

function promptText(context: AiContext): string {
  const first = context.messages[0];
  if (first?.role !== "user" || typeof first.content === "string") return "";
  return first.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function summaryEntries(session: SessionStorage): Promise<Entry[]> {
  return session.findEntries({ type: "branch_summary" });
}

void describe("tree projection", () => {
  void test("folds entries into a tree and marks the head's path", async () => {
    const { session } = await openSession();
    const stream = provider();
    const harness = await createHarness(session, stream.streamFn);
    const [u1, a1, u2, a2] = await twoTurns(harness);
    assert.ok(u1 && a1 && u2 && a2);
    completed(await harness.navigate({ entryId: a1.id }));
    assert.equal((await promptHarness(harness, "u3")).outcome.kind, "completed");
    const branch = await session.getBranch("main");
    const u3 = branch[2];
    const a3 = branch[3];
    assert.ok(u3 && a3);

    const tree = projectSessionTree(await session.findEntries(), await session.getLeafId("main"));
    assert.equal(tree.roots.length, 1);
    assert.equal(tree.roots[0]?.entry.id, u1.id);
    const a1Node = tree.roots[0]?.children[0];
    assert.equal(a1Node?.entry.id, a1.id);
    assert.deepEqual(
      a1Node?.children.map((child) => child.entry.id),
      [u2.id, u3.id],
    );
    assert.deepEqual([...tree.activePath].sort(), [u1.id, a1.id, u3.id, a3.id].sort());
    assert.equal(a1Node?.children[0]?.active, false);
    assert.equal(a1Node?.children[1]?.active, true);
    assert.equal(a1Node?.children[1]?.children[0]?.depth, 3);
  });

  void test("answers where a selection lands and what a move abandons", () => {
    const entries: Entry[] = [
      {
        type: "message",
        id: "u1",
        seq: 1,
        parentId: null,
        timestamp: 1,
        message: { role: "user", content: "one", timestamp: 1 },
      },
      { type: "message", id: "a1", seq: 2, parentId: "u1", timestamp: 2, message: assistant("r1") },
      {
        type: "message",
        id: "u2",
        seq: 3,
        parentId: "a1",
        timestamp: 3,
        message: { role: "user", content: "two", timestamp: 3 },
      },
      { type: "message", id: "a2", seq: 4, parentId: "u2", timestamp: 4, message: assistant("r2") },
    ];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));

    assert.deepEqual(navigationTarget(undefined), { kind: "move", targetId: null });
    assert.deepEqual(navigationTarget(byId.get("a1")), { kind: "move", targetId: "a1" });
    const restore = navigationTarget(byId.get("u2"));
    assert.equal(restore.kind, "restore");
    assert.equal(restore.targetId, "a1");

    // Selecting the assistant turn abandons everything after it.
    assert.deepEqual(
      collectAbandonedEntries(byId, "a2", "a1").entries.map((entry) => entry.id),
      ["u2", "a2"],
    );
    // Selecting the user turn keeps it out of the abandoned set: it returns to the composer.
    assert.deepEqual(
      collectAbandonedEntries(byId, "a2", "u2").entries.map((entry) => entry.id),
      ["a2"],
    );
    assert.deepEqual(
      collectAbandonedEntries(byId, "a2", null).entries.map((entry) => entry.id),
      ["u1", "a1", "u2", "a2"],
    );
    assert.deepEqual(collectAbandonedEntries(byId, null, "a1").entries, []);
  });
});

void describe("navigation operation", () => {
  void test("moves the head to a selected assistant turn and keeps the abandoned branch", async () => {
    const { session } = await openSession();
    const stream = provider();
    const harness = await createHarness(session, stream.streamFn);
    const [u1, a1, u2, a2] = await twoTurns(harness);
    assert.ok(u1 && a1 && u2 && a2);

    const result = completed(await harness.navigate({ entryId: a1.id }));
    assert.equal(await session.getLeafId("main"), a1.id);
    assert.equal(result.restored, undefined);
    assert.equal(await latestSummary(session), undefined);
    assert.deepEqual(
      (await session.getBranch("main")).map((entry) => entry.id),
      [u1.id, a1.id],
    );
    // Nothing is deleted: the abandoned turns keep their parents.
    const all = await session.findEntries();
    assert.equal(all.length, 4);
    assert.equal(all.find((entry) => entry.id === u2.id)?.parentId, a1.id);
    assert.equal(all.find((entry) => entry.id === a2.id)?.parentId, u2.id);
    assert.deepEqual(await session.findOpenOperations("main"), []);
    assert.equal(stream.summaries.length, 0);

    // Already there: the asked-for state holds, so the move is a no-op success.
    const before = (await session.getLog()).length;
    assert.equal((await harness.navigate({ entryId: a1.id })).kind, "moved");
    assert.equal((await session.getLog()).length, before);
  });

  void test("hands a selected user turn back and parks the head on its parent", async () => {
    const { session } = await openSession();
    const stream = provider();
    const harness = await createHarness(session, stream.streamFn);
    const [u1, a1, u2] = await twoTurns(harness);
    assert.ok(u1 && a1 && u2);

    const result = completed(await harness.navigate({ entryId: u2.id }));
    assert.equal(result.restored?.entryId, u2.id);
    assert.equal(restoredText(result), "u2");
    assert.equal(await session.getLeafId("main"), a1.id);

    const root = completed(await harness.navigate({ entryId: u1.id }));
    assert.equal(restoredText(root), "u1");
    assert.equal(await session.getLeafId("main"), null);
    assert.equal((await session.findEntries()).length, 4);
  });

  void test("appends the branch summary at the destination and projects it into context", async () => {
    const { session } = await openSession();
    const stream = provider();
    const harness = await createHarness(session, stream.streamFn);
    const [u1, a1, u2, a2] = await twoTurns(harness);
    assert.ok(u1 && a1 && u2 && a2);

    completed(
      await harness.navigate({ entryId: a1.id, summary: { customInstructions: "focus on math" } }),
    );
    const summary = await latestSummary(session);
    assert.ok(summary);
    assert.equal(summary.type, "branch_summary");
    assert.equal(summary.parentId, a1.id);
    assert.equal(summary.fromId, a2.id);
    assert.equal(summary.selectedId, a1.id);
    assert.equal(summary.summary.startsWith("The user explored"), true);
    assert.equal(summary.summary.includes("summary-1"), true);
    assert.deepEqual(summary.details, { readFiles: [], modifiedFiles: [] });
    assert.deepEqual(summary.usage, usage);
    assert.equal(await session.getLeafId("main"), summary.id);

    // The prompt saw the abandoned turns, serialized rather than continued, plus the focus.
    assert.equal(stream.summaries.length, 1);
    const prompt = promptText(stream.summaries[0]);
    assert.equal(prompt.includes("[User]: u2"), true);
    assert.equal(prompt.includes("[Assistant]: reply-2"), true);
    assert.equal(prompt.includes("[User]: u1"), false);
    assert.equal(prompt.includes("Additional focus: focus on math"), true);

    const branch = await session.getBranch("main");
    assert.deepEqual(
      branch.map((entry) => entry.id),
      [u1.id, a1.id, summary.id],
    );
    const context = buildSessionContext(branch);
    assert.equal(context.length, 3);
    const last = context[2];
    assert.equal(last?.role, "user");
    assert.equal(
      last?.role === "user" && typeof last.content !== "string"
        ? last.content[0]?.type === "text" && last.content[0].text.startsWith(BRANCH_SUMMARY_PREFIX)
        : false,
      true,
    );
    assert.deepEqual(
      transcriptFromEntries(branch).map((turn) => turn.kind),
      ["turn", "branch_summary"],
    );
    const usageRecords = await session.findRecords({
      type: "usage",
      runId: await latestNavigationRunId(session),
    });
    assert.deepEqual(
      usageRecords.map((record) => record.cause),
      ["branch_summary"],
    );

    // The next send parents on the summary.
    assert.equal((await promptHarness(harness, "u3")).outcome.kind, "completed");
    const next = await session.getBranch("main");
    assert.equal(next[3]?.parentId, summary.id);
    assert.equal(stream.chats.at(-1)?.messages.length, 4);
  });

  void test("summarizes from the selection, not the destination, for a user turn", async () => {
    const { session } = await openSession();
    const stream = provider();
    const harness = await createHarness(session, stream.streamFn);
    const [, a1, u2, a2] = await twoTurns(harness);
    assert.ok(a1 && u2 && a2);

    const result = completed(await harness.navigate({ entryId: u2.id, summary: {} }));
    assert.equal(restoredText(result), "u2");
    const summary = await latestSummary(session);
    assert.ok(summary);
    assert.equal(summary.parentId, a1.id);
    assert.equal(summary.selectedId, u2.id);
    assert.equal(summary.fromId, a2.id);
    const prompt = promptText(stream.summaries[0]);
    assert.equal(prompt.includes("[Assistant]: reply-2"), true);
    assert.equal(prompt.includes("[User]: u2"), false);
  });

  void test("skips the summary when nothing was abandoned", async () => {
    const { session } = await openSession();
    const stream = provider();
    const harness = await createHarness(session, stream.streamFn);
    const [, , u2] = await twoTurns(harness);
    assert.ok(u2);
    completed(await harness.navigate({ entryId: u2.id }));
    // Selecting the same user turn again from its parent abandons nothing.
    completed(await harness.navigate({ entryId: u2.id, summary: {} }));
    assert.equal(stream.summaries.length, 0);
    assert.equal((await summaryEntries(session)).length, 0);
  });

  void test("a failed summary leaves the session unchanged", async () => {
    const { session } = await openSession();
    const stream = provider();
    const harness = await createHarness(session, stream.streamFn);
    const [, a1, , a2] = await twoTurns(harness);
    assert.ok(a1 && a2);
    stream.failNextSummary("provider unavailable");

    const result = await harness.navigate({ entryId: a1.id, summary: {} });
    assert.equal(result.kind, "failed");
    if (result.kind === "failed") assert.match(result.message, /provider unavailable/u);
    assert.equal(await session.getLeafId("main"), a2.id);
    assert.equal((await summaryEntries(session)).length, 0);
    assert.deepEqual(await session.findOpenOperations("main"), []);
  });

  void test("an aborted summary leaves the session unchanged", async () => {
    const { session } = await openSession();
    const stream = provider();
    const harness = await createHarness(session, stream.streamFn);
    const [, a1, , a2] = await twoTurns(harness);
    assert.ok(a1 && a2);
    const before = (await session.getLog()).length;

    const entered = stream.hold();
    const navigation = harness.navigate({ entryId: a1.id, summary: {} });
    await entered;
    assert.equal((await harness.abort()).kind, "requested");
    const result = await navigation;
    assert.equal(result.kind, "aborted");

    assert.equal(await session.getLeafId("main"), a2.id);
    assert.equal((await summaryEntries(session)).length, 0);
    assert.deepEqual(await session.findOpenOperations("main"), []);
    // Only bookkeeping records were added; no entry and no head move.
    const added = (await session.getLog()).slice(before);
    assert.deepEqual(
      added.filter((item) => item.kind === "entry" || item.kind === "head"),
      [],
    );
  });

  void test("resumes an interrupted navigation and appends the provisioned summary once", async () => {
    const { session } = await openSession();
    const stream = provider();
    const first = await createHarness(session, stream.streamFn);
    const [, a1, , a2] = await twoTurns(first);
    assert.ok(a1 && a2);
    await first.close();

    // The crash landed after operation_started: the intent is durable, nothing else is.
    const claimed = await session.claimRun("main", "nav-crash");
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    await claimed.writer.appendRecord({
      type: "operation_started",
      id: "nav-crash",
      head: "main",
      sourceLeafId: a2.id,
      intent: {
        kind: "navigation",
        selectedId: a1.id,
        targetId: a1.id,
        summary: { entryId: "summary-provisioned" },
      },
    });
    await claimed.writer.release();

    const harness = await AgentHarness.create({
      session,
      streamFn: stream.streamFn,
      plugins: [inlinePlugin(systemPromptPlugin("system"))],
      env: { cwd: "/" },
      model,
    });
    harnesses.push(harness);
    const resumed = await harness.resume();
    assert.equal(resumed?.kind, "finished");
    if (resumed?.kind !== "finished") return;
    assert.equal(resumed.operation, "navigation");
    assert.equal(resumed.outcome.kind, "completed");
    if (resumed.operation === "navigation" && resumed.outcome.kind === "completed") {
      assert.equal(resumed.outcome.summaryEntry?.id, "summary-provisioned");
    }
    assert.equal(await session.getLeafId("main"), "summary-provisioned");
    const summaries = await summaryEntries(session);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.parentId, a1.id);
    assert.equal(stream.summaries.length, 1);

    // Nothing is open any more: resume has nothing to pick up.
    assert.equal(await harness.resume(), undefined);
  });

  void test("a crash after the summary landed settles without a second model call", async () => {
    const { session } = await openSession();
    const stream = provider();
    const first = await createHarness(session, stream.streamFn);
    const [, a1, , a2] = await twoTurns(first);
    assert.ok(a1 && a2);
    await first.close();

    const claimed = await session.claimRun("main", "nav-landed");
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    await claimed.writer.appendRecord({
      type: "operation_started",
      id: "nav-landed",
      head: "main",
      sourceLeafId: a2.id,
      intent: {
        kind: "navigation",
        selectedId: a1.id,
        targetId: a1.id,
        summary: { entryId: "summary-landed" },
      },
    });
    await claimed.writer.moveHead(a1.id);
    await claimed.writer.appendEntry({
      type: "branch_summary",
      id: "summary-landed",
      fromId: a2.id,
      selectedId: a1.id,
      summary: "already written",
      usage,
    });
    await claimed.writer.release();

    const harness = await createHarness(session, () => {
      throw new Error("the model must not be called again");
    });
    const resumed = await harness.resume();
    assert.equal(resumed?.kind, "finished");
    if (resumed?.kind === "finished") assert.equal(resumed.outcome.kind, "completed");
    assert.equal(await session.getLeafId("main"), "summary-landed");
    assert.equal((await summaryEntries(session)).length, 1);
    assert.equal(
      (await session.findRecords({ type: "usage", runId: "nav-landed" })).filter(
        (record) => record.cause === "branch_summary",
      ).length,
      1,
    );
    assert.deepEqual(await session.findOpenOperations("main"), []);
  });

  void test("resume does not duplicate branch-summary usage that already landed", async () => {
    const { session } = await openSession();
    const stream = provider();
    const first = await createHarness(session, stream.streamFn);
    const [, a1, , a2] = await twoTurns(first);
    assert.ok(a1 && a2);
    await first.close();

    const claimed = await session.claimRun("main", "nav-usage-landed");
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    await claimed.writer.appendRecord({
      type: "operation_started",
      id: "nav-usage-landed",
      head: "main",
      sourceLeafId: a2.id,
      intent: {
        kind: "navigation",
        selectedId: a1.id,
        targetId: a1.id,
        summary: { entryId: "summary-usage-landed" },
      },
    });
    await claimed.writer.moveHead(a1.id);
    await claimed.writer.appendEntry({
      type: "branch_summary",
      id: "summary-usage-landed",
      fromId: a2.id,
      selectedId: a1.id,
      summary: "already written",
      usage,
    });
    await claimed.writer.appendRecord({
      type: "usage",
      id: "summary-usage-record",
      head: "main",
      runId: "nav-usage-landed",
      cause: "branch_summary",
      usage,
    });
    await claimed.writer.release();

    const harness = await createHarness(session, () => {
      throw new Error("the model must not be called again");
    });
    const resumed = await harness.resume();
    assert.equal(resumed?.kind, "finished");
    assert.equal(
      (await session.findRecords({ type: "usage", runId: "nav-usage-landed" })).filter(
        (record) => record.cause === "branch_summary",
      ).length,
      1,
    );
  });

  void test("a message sent during navigation queues and runs at the destination", async () => {
    const { session } = await openSession();
    const stream = provider();
    const harness = await createHarness(session, stream.streamFn);
    const [, a1] = await twoTurns(harness);
    assert.ok(a1);

    const entered = stream.hold();
    const navigation = harness.navigate({ entryId: a1.id, summary: {} });
    await entered;
    const submitted = await submit(harness, "u3");
    assert.equal(submitted.disposition, "queued");
    assert.equal((await pendingQueue(harness)).length, 1);

    stream.release();
    completed(await navigation);
    const summary = await latestSummary(session);
    assert.ok(summary);

    // The navigation woke the queued steer; it runs from the new leaf.
    await waitForIdle(harness);
    for (let attempt = 0; attempt < 50 && (await pendingQueue(harness)).length > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await waitForIdle(harness);
    }
    const branch = await session.getBranch("main");
    assert.deepEqual(
      branch.map((entry) => (entry.type === "message" ? entry.message.role : entry.type)),
      ["user", "assistant", "branch_summary", "user", "assistant"],
    );
    assert.equal(userText(branch[3]), "u3");
    assert.equal(branch[3]?.parentId, summary.id);
    assert.equal((await pendingQueue(harness)).length, 0);
  });
});
