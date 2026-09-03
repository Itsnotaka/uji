/**
 * The workspace registry: the durable recents list behind `workspace.list`,
 * owned by core so hosts never hand-roll a store (design record, "workspace
 * and provider"). Reads are tolerant, writes are atomic, entries are
 * realpaths, and `createUji` records `env.cwd` when a registry is supplied.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { AssistantMessage, AssistantMessageEvent, Model, Usage } from "@uji-ai/ai";
import { EventStream } from "@uji-ai/ai";
import { createUji, WorkspaceRegistry } from "../src/index.ts";
import { SqliteSessionRepo } from "../src/store.ts";
import type { StreamFn } from "../src/types.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "uji-workspaces-"));
  directories.push(directory);
  return directory;
}

describe("WorkspaceRegistry", () => {
  test("lists nothing before the file exists", async () => {
    const registry = new WorkspaceRegistry(join(scratch(), "workspaces.json"));
    assert.deepEqual(await registry.list(), []);
  });

  test("touch records realpaths newest-first and dedupes", async () => {
    const base = scratch();
    const a = join(base, "alpha");
    const b = join(base, "beta");
    mkdirSync(a);
    mkdirSync(b);
    const registry = new WorkspaceRegistry(join(base, "workspaces.json"));

    await registry.touch(a, 100);
    await registry.touch(b, 200);
    await registry.touch(a, 300);

    const listed = await registry.list();
    assert.deepEqual(
      listed.map(({ path, name, lastOpenedAt }) => ({ path, name, lastOpenedAt })),
      [
        { path: await realpath(a), name: "alpha", lastOpenedAt: 300 },
        { path: await realpath(b), name: "beta", lastOpenedAt: 200 },
      ],
    );
  });

  test("a symlinked open collapses onto the real workspace", async () => {
    const base = scratch();
    const real = join(base, "project");
    const link = join(base, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    const registry = new WorkspaceRegistry(join(base, "workspaces.json"));

    await registry.touch(real, 100);
    await registry.touch(link, 200);

    const listed = await registry.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.path, await realpath(real));
    assert.equal(listed[0]?.lastOpenedAt, 200);
  });

  test("forget removes the listed path, including one that no longer exists", async () => {
    const base = scratch();
    const gone = join(base, "gone");
    mkdirSync(gone);
    const registry = new WorkspaceRegistry(join(base, "workspaces.json"));
    await registry.touch(gone, 100);
    rmSync(gone, { recursive: true });

    // A client forgets what `list()` handed it: the stored realpath.
    const listed = await registry.list();
    await registry.forget(listed[0]?.path ?? "");
    assert.deepEqual(await registry.list(), []);
  });

  test("a corrupt file reads as empty and bad rows are dropped", async () => {
    const base = scratch();
    const kept = join(base, "kept");
    mkdirSync(kept);
    const file = join(base, "workspaces.json");

    writeFileSync(file, "not json");
    const registry = new WorkspaceRegistry(file);
    assert.deepEqual(await registry.list(), []);

    writeFileSync(
      file,
      JSON.stringify({
        [kept]: 100,
        "relative/path": 200,
        [join(base, "bad-stamp")]: "yesterday",
      }),
    );
    const listed = await registry.list();
    assert.deepEqual(
      listed.map((workspace) => workspace.path),
      [kept],
    );
  });

  test("touch trims beyond the limit, oldest first", async () => {
    const base = scratch();
    const paths = ["one", "two", "three"].map((name) => join(base, name));
    for (const path of paths) mkdirSync(path);
    const registry = new WorkspaceRegistry(join(base, "workspaces.json"), { limit: 2 });

    await registry.touch(paths[0] ?? "", 100);
    await registry.touch(paths[1] ?? "", 200);
    await registry.touch(paths[2] ?? "", 300);

    const listed = await registry.list();
    assert.deepEqual(
      listed.map((workspace) => workspace.name),
      ["three", "two"],
    );
  });

  test("rejects a relative registry path", () => {
    assert.throws(() => new WorkspaceRegistry("workspaces.json"));
  });
});

// ---------------------------------------------------------------------------
// the SDK verbs over the registry
// ---------------------------------------------------------------------------

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

const idleStream: StreamFn = () => {
  const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
      throw new Error("no terminal event");
    },
  );
  events.push({
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    },
  });
  return events;
};

const catalog = {
  getModels: () => [model as Model<"openai-responses">],
  getModel: (_provider: string, id: string) => (id === model.id ? model : undefined),
  checkAuth: async (provider: string) => (provider === "openai" ? { type: "api_key" } : undefined),
  getProvider: (id: string) => (id === "openai" ? { id } : undefined),
};

describe("workspace verbs", () => {
  test("createUji records env.cwd; list and forget ride the SDK", async () => {
    const cwd = scratch();
    const registry = new WorkspaceRegistry(join(cwd, "registry", "workspaces.json"));
    const store = new SqliteSessionRepo(join(cwd, "sessions.db"));
    const uji = await createUji({
      store,
      streamFn: idleStream,
      models: catalog,
      model,
      plugins: [],
      env: { cwd },
      workspaces: registry,
    });
    try {
      const listed = await uji.workspace.list();
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.path, await realpath(cwd));

      await uji.workspace.forget({ path: cwd });
      assert.deepEqual(await uji.workspace.list(), []);
    } finally {
      await uji.close();
      await store.close();
    }
  });

  test("without a registry the list is empty and forget is a no-op", async () => {
    const cwd = scratch();
    const store = new SqliteSessionRepo(join(cwd, "sessions.db"));
    const uji = await createUji({
      store,
      streamFn: idleStream,
      models: catalog,
      model,
      plugins: [],
      env: { cwd },
    });
    try {
      assert.deepEqual(await uji.workspace.list(), []);
      await uji.workspace.forget({ path: cwd });
    } finally {
      await uji.close();
      await store.close();
    }
  });
});
