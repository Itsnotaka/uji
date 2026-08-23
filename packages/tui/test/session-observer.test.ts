import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteSessionRepo } from "@uji-ai/core";
import { watchSessionBranch } from "../src/session-observer.ts";

void test("a session observer publishes a pre-existing branch on startup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uji-cli-observer-startup-"));
  const path = join(directory, "sessions.db");
  const writerRepo = new SqliteSessionRepo(path);
  const observerRepo = new SqliteSessionRepo(path);

  try {
    const writer = await writerRepo.create({ id: "shared" });
    await writer.appendEntry(
      {
        id: "already-present",
        type: "message",
        message: { role: "user", content: "existing", timestamp: Date.now() },
      },
      "main",
    );
    const reader = await observerRepo.open("shared");
    const branches: string[][] = [];
    const errors: Error[] = [];
    const stop = watchSessionBranch(reader, {
      head: "main",
      onBranch(entries) {
        branches.push(entries.map((entry) => entry.id));
      },
      onError(error) {
        errors.push(error);
      },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    stop();

    assert.deepEqual(errors, []);
    assert.deepEqual(branches, [["already-present"]]);
    await reader.close();
    await writer.close();
  } finally {
    await observerRepo.close();
    await writerRepo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("a session observer follows cross-process writes through watch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uji-cli-observer-"));
  const path = join(directory, "sessions.db");
  const writerRepo = new SqliteSessionRepo(path);
  const observerRepo = new SqliteSessionRepo(path);

  try {
    const writer = await writerRepo.create({ id: "shared" });
    const reader = await observerRepo.open("shared");
    const observed = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("observer did not refresh")), 1_000);
      const stop = watchSessionBranch(reader, {
        head: "main",
        onBranch(entries) {
          const entry = entries.at(-1);
          if (entry === undefined) return;
          clearTimeout(timeout);
          stop();
          resolve(entry.id);
        },
        onError: reject,
      });
    });

    await writer.appendEntry(
      {
        id: "message-1",
        type: "message",
        message: { role: "user", content: "hello", timestamp: Date.now() },
      },
      "main",
    );
    assert.equal(await observed, "message-1");

    await reader.close();
    await writer.close();
  } finally {
    await observerRepo.close();
    await writerRepo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("a session observer skips head moves the caller already rendered", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uji-cli-observer-skip-"));
  const path = join(directory, "sessions.db");
  const writerRepo = new SqliteSessionRepo(path);
  const observerRepo = new SqliteSessionRepo(path);

  try {
    const writer = await writerRepo.create({ id: "shared" });
    const reader = await observerRepo.open("shared");
    const rendered = new Set(["message-1"]);
    const leaves: (string | undefined)[] = [];
    const skipped: (string | null)[] = [];
    let started = (): void => undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const observed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("observer did not refresh")), 1_000);
      const stop = watchSessionBranch(reader, {
        head: "main",
        shouldReload(leafId) {
          if (leafId !== null && rendered.has(leafId)) {
            skipped.push(leafId);
            return false;
          }
          return true;
        },
        onBranch(entries) {
          leaves.push(entries.at(-1)?.id);
          if (leaves.length === 1) {
            started();
            return;
          }
          clearTimeout(timeout);
          stop();
          resolve();
        },
        onError: reject,
      });
    });

    await ready;
    for (const id of ["message-1", "message-2"]) {
      await writer.appendEntry(
        { id, type: "message", message: { role: "user", content: id, timestamp: Date.now() } },
        "main",
      );
    }
    await observed;
    assert.deepEqual(skipped, ["message-1"]);
    assert.deepEqual(leaves, [undefined, "message-2"]);

    await reader.close();
    await writer.close();
  } finally {
    await observerRepo.close();
    await writerRepo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
