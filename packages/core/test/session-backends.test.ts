import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, test } from "node:test";
import { AgentHarness } from "../src/harness/agent-harness.ts";
import { SqliteSessionRepo } from "../src/harness/session/sqlite.ts";
import type {
  MessageEntry,
  NewRecord,
  OperationStartedRecord,
  ProvisionedEntry,
} from "../src/harness/session/types.ts";
import { newId, toJsonValue } from "../src/harness/session/types.ts";
import type { AgentTool, AssistantTurn, StreamFn } from "../src/types.ts";
import { toolResultContent } from "../src/utils/tool-result.ts";

function message(text: string): ProvisionedEntry<MessageEntry> {
  return { type: "message", id: newId("e"), message: { role: "user", content: text } };
}

function operationStarted(id: string): NewRecord<OperationStartedRecord> {
  return {
    type: "operation_started",
    id,
    lane: "main",
    sourceLeafId: null,
    intent: { kind: "run", originalPrompt: [{ role: "user", content: "go" }], initialMessages: [] },
  };
}

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "june-session-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRepo(options?: { leaseTtlMs?: number }): SqliteSessionRepo {
  const repo = new SqliteSessionRepo(join(tempDir(), "sessions.db"), options);
  cleanups.push(() => void repo.close());
  return repo;
}

void describe("durable JSON values", () => {
  void test("clones plain JSON without changing its shape", () => {
    const value = { path: "file.ts", edits: [{ oldText: "a", newText: "b" }], limit: 2 };
    const cloned = toJsonValue(value);
    assert.deepEqual(cloned, value);
    assert.notEqual(cloned, value);
  });

  void test("rejects values whose live and replayed forms would differ", () => {
    assert.throws(() => toJsonValue({ value: undefined }), /cannot be represented as JSON/);
    assert.throws(() => toJsonValue({ value: Number.NaN }), /finite JSON number/);
    assert.throws(() => toJsonValue({ value: -0 }), /negative zero/);
    assert.throws(() => toJsonValue({ value: new Date() }), /plain JSON object/);
    assert.throws(() => toJsonValue(Object.freeze({ value: "fixed" })), /plain JSON object/);
    const sparse: string[] = [];
    sparse.length = 2;
    sparse[1] = "value";
    assert.throws(() => toJsonValue(sparse), /enumerable data property/);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    assert.throws(() => toJsonValue(circular), /repeated or circular reference/);
    const shared = {};
    assert.throws(() => toJsonValue({ first: shared, second: shared }), /repeated or circular/);
  });
});

void describe("agent harness", () => {
  void test("persists prepared tool arguments and both usage sources", async () => {
    const repo = makeRepo();
    const session = await repo.create();
    const turns: AssistantTurn[] = [
      {
        items: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "echo",
            arguments: JSON.stringify({ value: "hello" }),
          },
        ],
        stopReason: "stop",
      },
      {
        items: [{ type: "message", role: "assistant", content: "done" }],
        stopReason: "stop",
        usage: { input: 10, output: 2, total: 12 },
      },
    ];
    let turnIndex = 0;
    const streamFn: StreamFn = async () => turns[turnIndex++]!;
    const tool: AgentTool<{ value: string }, undefined> = {
      name: "echo",
      label: "Echo",
      description: "Echo a value",
      parameters: { type: "object" },
      prepareArguments(args) {
        if (typeof args !== "object" || args === null || !("value" in args)) {
          throw new Error("value must be a string");
        }
        const value = (args as { value: unknown }).value;
        if (typeof value !== "string") throw new Error("value must be a string");
        return { value };
      },
      async execute(_toolCallId, { value }) {
        return {
          content: toolResultContent(value),
          details: undefined,
          usage: { input: 1, output: 1, total: 2 },
        };
      },
    };
    const { harness } = await AgentHarness.create({
      session,
      streamFn,
      systemPrompt: "",
      tools: [tool],
    });

    const running = harness.prompt("go");
    const concurrent = await harness.prompt("again");
    assert.equal(concurrent.ok, false);
    if (!concurrent.ok) assert.equal(concurrent.error._tag, "LaneBusy");
    const result = await running;
    assert.equal(result.ok, true);
    const toolRecords = await session.findRecords({ type: "tool_started" });
    assert.deepEqual(toolRecords[0]?.effectiveArgs, { value: "hello" });
    const usageRecords = await session.findRecords({ type: "usage" });
    assert.deepEqual(
      usageRecords.map(({ cause, usage }) => ({ cause, usage })),
      [
        { cause: "tool", usage: { input: 1, output: 1, total: 2 } },
        { cause: "assistant", usage: { input: 10, output: 2, total: 12 } },
      ],
    );
    await session.close();
  });
});

void describe("sqlite session storage", () => {
  void test("create, append, reopen preserves the log", async () => {
    const repo = makeRepo();
    const session = await repo.create();
    const { id } = await session.getMetadata();

    const a = await session.appendEntry(message("first message"), "main");
    const b = await session.appendEntry(message("second message"), "main");
    assert.equal(a.parentId, null);
    assert.equal(b.parentId, a.id);
    assert.ok(b.seq > a.seq);
    await session.appendRecord(operationStarted("run_1"));
    await session.setName("my session");

    const listed = await repo.list();
    assert.ok(listed.some((meta) => meta.id === id));

    await session.close();
    const restored = await repo.open(id);
    assert.equal((await restored.getMetadata()).id, id);
    assert.equal(await restored.getLeafId("main"), b.id);
    assert.deepEqual(
      (await restored.getBranch("main")).map((entry) => entry.id),
      [a.id, b.id],
    );
    assert.deepEqual(await restored.getEntry(a.id), a);
    assert.equal(await restored.getName(), "my session");

    const started = await restored.findRecords({ type: "operation_started", runId: "run_1" });
    assert.equal(started.length, 1);
    assert.equal(started[0]?.id, "run_1");

    const log = await restored.getLog();
    assert.deepEqual(
      log.map((item) => item.kind),
      ["entry", "lane", "entry", "lane", "record", "fact"],
    );
    const seqs = log.map((item) => item.seq);
    assert.deepEqual(
      seqs,
      [...seqs].sort((x, y) => x - y),
    );
    assert.equal(new Set(seqs).size, seqs.length);
    await restored.close();
    assert.throws(() => restored.getMetadata(), /Session is closed/);
  });

  void test("findOpenOperations reports the suspended run until it finishes", async () => {
    const repo = makeRepo();
    const session = await repo.create();
    await session.appendEntry(message("prompt"), "main");
    await session.appendRecord(operationStarted("run_crash"));
    const { id } = await session.getMetadata();

    await session.close();
    const restored = await repo.open(id);
    const open = await restored.findOpenOperations("main");
    assert.equal(open.length, 1);
    assert.equal(open[0]?.id, "run_crash");

    await restored.appendRecord({
      type: "operation_finished",
      id: newId("r"),
      lane: "main",
      runId: "run_crash",
      outcome: "completed",
    });
    assert.deepEqual(await restored.findOpenOperations("main"), []);
    await restored.close();
  });

  void test("moveLane forks a sibling branch and keeps the old one reachable", async () => {
    const repo = makeRepo();
    const session = await repo.create();
    const a = await session.appendEntry(message("root"), "main");
    const b = await session.appendEntry(message("first try"), "main");
    const c = await session.appendEntry(message("dead end"), "main");

    await session.moveLane("main", a.id);
    assert.equal(await session.getLeafId("main"), a.id);
    const d = await session.appendEntry(message("second try"), "main");
    assert.equal(d.parentId, a.id);
    assert.deepEqual(
      (await session.getBranch("main")).map((entry) => entry.id),
      [a.id, d.id],
    );

    assert.equal((await session.getEntry(c.id))?.parentId, b.id);
    assert.deepEqual(
      (await session.findEntries()).map((entry) => entry.id),
      [a.id, b.id, c.id, d.id],
    );
    assert.equal((await session.findEntries({ type: "message", limit: 2 })).length, 2);

    await assert.rejects(
      async () => session.moveLane("main", "e_missing"),
      (error: Error) => error.message.includes("Entry not found"),
    );
    await session.close();
  });

  void test("duplicate entry ids are rejected", async () => {
    const repo = makeRepo();
    const session = await repo.create();
    const entry = message("once");
    await session.appendEntry(entry, "main");
    await assert.rejects(
      async () => session.appendEntry(entry, "main"),
      (error: Error) => error.message.includes("already exists"),
    );
    await session.close();
  });
});

void describe("writer lease", () => {
  void test("a second open is refused until the first closes", async () => {
    const repo = makeRepo();
    const session = await repo.create({ id: "s1" });
    await assert.rejects(
      async () => repo.open("s1"),
      (error: Error) => error.message.includes("active writer"),
    );
    await session.close();
    const again = await repo.open("s1");
    assert.equal((await again.getMetadata()).id, "s1");
    await again.close();
  });

  void test("an expired lease can be taken over; the stale owner's writes fail", async () => {
    const path = join(tempDir(), "sessions.db");
    const crashed = new SqliteSessionRepo(path);
    cleanups.push(() => void crashed.close());
    const stale = await crashed.create({ id: "s1" });
    await stale.appendEntry(message("before crash"), "main");

    // Simulate a crash: force the lease past expiry instead of waiting out the
    // TTL, which the heartbeat would otherwise keep renewing.
    const db = new DatabaseSync(path);
    db.prepare("UPDATE writer_leases SET expires_at_ms = 0 WHERE session_id = ?").run("s1");
    db.close();

    const successor = new SqliteSessionRepo(path);
    cleanups.push(() => void successor.close());
    const taken = await successor.open("s1");
    assert.equal((await taken.getBranch("main")).length, 1);
    await taken.appendEntry(message("after takeover"), "main");

    await assert.rejects(
      async () => stale.appendEntry(message("zombie write"), "main"),
      (error: Error) => error.message.includes("lease lost"),
    );
  });

  void test("the heartbeat renews an idle lease past its original TTL", async () => {
    const path = join(tempDir(), "sessions.db");
    const repo = new SqliteSessionRepo(path, { leaseTtlMs: 300, heartbeatIntervalMs: 50 });
    cleanups.push(() => void repo.close());
    const session = await repo.create({ id: "s1" });

    const db = new DatabaseSync(path);
    cleanups.push(() => db.close());
    const expiresAt = () =>
      (
        db.prepare("SELECT expires_at_ms FROM writer_leases WHERE session_id = 's1'").get() as {
          expires_at_ms: number;
        }
      ).expires_at_ms;

    const before = expiresAt();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(expiresAt() > before);
    await session.appendEntry(message("still the owner"), "main");
  });

  void test("a heartbeat shorter than the TTL is required", () => {
    assert.throws(
      () => new SqliteSessionRepo(join(tempDir(), "sessions.db"), { leaseTtlMs: 25 }),
      RangeError,
    );
  });
});

void describe("search", () => {
  void test("finds entries across sessions by text", async () => {
    const repo = makeRepo();
    const first = await repo.create({ id: "s1" });
    const hitEntry = await first.appendEntry(message("the flux capacitor hums quietly"), "main");
    await first.appendEntry(message("nothing to see here"), "main");
    await first.close();
    const second = await repo.create({ id: "s2" });
    await second.appendEntry(message("groceries: milk and eggs"), "main");
    await second.close();

    const hits = await repo.searchEntries("flux capacitor");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.sessionId, "s1");
    assert.equal(hits[0]?.entryId, hitEntry.id);
    assert.ok(hits[0].snippet.includes("flux capacitor"));

    assert.deepEqual(await repo.searchEntries("flux", { type: "model_change" }), []);
    assert.deepEqual(await repo.searchEntries("zz"), []); // trigram search needs 3 characters
    const limited = await repo.searchEntries("milk and eggs", { limit: 1 });
    assert.equal(limited.length, 1);
    assert.equal(limited[0]?.sessionId, "s2");
  });
});
