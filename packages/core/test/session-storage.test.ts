import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionError, SqliteSessionRepo, type SessionStorage } from "../src/store.ts";

void test("appendEntries rolls back the whole batch when a later entry fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uji-session-storage-"));
  const repo = new SqliteSessionRepo(join(directory, "sessions.db"));

  try {
    const session = await repo.create({ id: "atomic-batch" });
    await session.appendEntry(
      {
        id: "existing",
        type: "message",
        message: { role: "user", content: "seed", timestamp: Date.now() },
      },
      "main",
    );

    await assert.rejects(
      async () =>
        session.appendEntries(
          [
            {
              id: "batch-first",
              type: "message",
              message: { role: "user", content: "must roll back", timestamp: Date.now() },
            },
            {
              id: "existing",
              type: "message",
              message: { role: "user", content: "duplicate", timestamp: Date.now() },
            },
          ],
          "main",
        ),
      (error: unknown) => error instanceof SessionError && error.code === "invalid_entry",
    );

    assert.equal(await session.getEntry("batch-first"), undefined);
    assert.deepEqual(
      (await session.getBranch("main")).map((entry) => entry.id),
      ["existing"],
    );
    await session.close();
  } finally {
    await repo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("setNameIfCurrent writes only from the exact current name and takes no seq otherwise", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uji-session-storage-"));
  const path = join(directory, "sessions.db");
  const firstRepo = new SqliteSessionRepo(path);
  const secondRepo = new SqliteSessionRepo(path);
  const nameItems = async (session: SessionStorage): Promise<string[]> =>
    (await session.getLog()).flatMap((item) => (item.kind === "fact" ? [item.name] : []));

  try {
    const first = await firstRepo.create({ id: "named" });
    const second = await secondRepo.open("named");

    assert.equal(await first.setNameIfCurrent("x", "A"), false);
    assert.equal(await first.getName(), undefined);
    assert.deepEqual(await nameItems(first), []);

    assert.equal(await first.setNameIfCurrent(undefined, "A"), true);
    assert.equal(await first.getName(), "A");
    assert.deepEqual(await nameItems(first), ["A"]);

    // Another handle renames between this handle's read and its write.
    await second.setName("B");
    assert.equal(await first.setNameIfCurrent("A", "C"), false);
    assert.equal(await first.getName(), "B");
    assert.deepEqual(await nameItems(second), ["A", "B"]);

    assert.equal(await first.setNameIfCurrent("B", "C"), true);
    assert.equal(await second.getName(), "C");
    assert.deepEqual(await nameItems(second), ["A", "B", "C"]);

    await second.close();
    await first.close();
  } finally {
    await secondRepo.close();
    await firstRepo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("every open handle can read and participate in one live session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uji-session-storage-"));
  const path = join(directory, "sessions.db");
  const firstRepo = new SqliteSessionRepo(path);
  const secondRepo = new SqliteSessionRepo(path);

  try {
    const first = await firstRepo.create({ id: "shared" });
    const second = await secondRepo.open("shared");
    await first.appendEntry(
      {
        id: "message-1",
        type: "message",
        message: { role: "user", content: "visible to participants", timestamp: Date.now() },
      },
      "main",
    );
    await second.appendEntry(
      {
        id: "message-2",
        type: "message",
        message: { role: "user", content: "written by another process", timestamp: Date.now() },
      },
      "main",
    );
    assert.deepEqual(
      (await first.getBranch("main")).map((entry) => entry.id),
      ["message-1", "message-2"],
    );
    await second.close();
    await first.close();
  } finally {
    await secondRepo.close();
    await firstRepo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
