import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { SqliteSessionRepo } from "../src/harness/session/sqlite.ts";
import type {
  MessageEntry,
  NewRecord,
  OperationStartedRecord,
  ProvisionedEntry,
} from "../src/harness/session/types.ts";
import { newId } from "../src/harness/session/types.ts";

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
    const crashed = new SqliteSessionRepo(path, { leaseTtlMs: 25 });
    cleanups.push(() => void crashed.close());
    const stale = await crashed.create({ id: "s1" });
    await stale.appendEntry(message("before crash"), "main");

    await new Promise((resolve) => setTimeout(resolve, 50));
    const successor = new SqliteSessionRepo(path, { leaseTtlMs: 25 });
    cleanups.push(() => void successor.close());
    const taken = await successor.open("s1");
    assert.equal((await taken.getBranch("main")).length, 1);
    await taken.appendEntry(message("after takeover"), "main");

    await assert.rejects(
      async () => stale.appendEntry(message("zombie write"), "main"),
      (error: Error) => error.message.includes("lease lost"),
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
