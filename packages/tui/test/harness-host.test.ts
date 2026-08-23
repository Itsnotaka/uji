import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Entry, ProvisionedEntry, ThinkingLevel } from "@uji-ai/core";
import type { CreateHostedHarness, HostedHarness, HostedRuntime } from "../src/harness-host.ts";
import { HarnessHost, resolveDirectory } from "../src/harness-host.ts";

type FakeSession = HostedHarness["session"];

/** A member the double is not meant to answer: reaching it is a test bug, not a scenario. */
function unused(member: string): () => never {
  return () => {
    throw new Error(`test double does not implement ${member}`);
  };
}

/** Fill in the write-once fields the storage owns, so a double can honour `appendEntry`. */
function storedEntry(entry: ProvisionedEntry, seq: number): Entry {
  return { ...entry, seq, parentId: null, timestamp: 0 };
}

function fakeSession(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    appendEntry: unused("appendEntry"),
    appendEntries: unused("appendEntries"),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

/** Record every entry the host writes and hand back what the storage would have stored. */
function recordingSession(entries: ProvisionedEntry[], onClose?: () => void): FakeSession {
  return fakeSession({
    appendEntry: (entry) => {
      entries.push(entry);
      return Promise.resolve(storedEntry(entry, entries.length));
    },
    appendEntries: (batch) => {
      const stored = batch.map((entry) => {
        entries.push(entry);
        return storedEntry(entry, entries.length);
      });
      return Promise.resolve(stored);
    },
    close: () => {
      onClose?.();
      return Promise.resolve();
    },
  });
}

interface FakeHarnessOptions {
  session: FakeSession;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  isStreaming?: boolean;
  onClose?: () => void;
  close?: () => Promise<void>;
  waitForIdle?: () => Promise<void>;
}

function fakeHarness(options: FakeHarnessOptions): HostedHarness {
  return {
    session: options.session,
    state: {
      isStreaming: options.isStreaming ?? false,
      isCompacting: false,
      model: { id: options.model ?? "model" },
      thinkingLevel: options.thinkingLevel ?? "medium",
    },
    close:
      options.close ??
      (() => {
        options.onClose?.();
        return Promise.resolve();
      }),
    abort: unused("abort"),
    waitForIdle: options.waitForIdle ?? (() => Promise.resolve()),
  };
}

function fakeRuntime(id: string, name = id): HostedRuntime & { provider: { name: string } } {
  return { provider: { id, name } };
}

type FakeCreateHarness = CreateHostedHarness<HostedHarness, HostedRuntime>;

void describe("HarnessHost", () => {
  void test("constructs and binds a replacement before recording a runtime switch", async () => {
    const order: string[] = [];
    const entries: ProvisionedEntry[] = [];
    const session = fakeSession({
      appendEntries: (batch) => {
        const stored = batch.map((entry) => {
          order.push(`entry:${entry.type}`);
          entries.push(entry);
          return storedEntry(entry, entries.length);
        });
        return Promise.resolve(stored);
      },
    });
    let oldClosed = false;
    const oldHarness = fakeHarness({
      session,
      model: "old-model",
      onClose: () => {
        oldClosed = true;
        order.push("close:old");
      },
    });
    const nextHarness = fakeHarness({ session, model: "new-model" });
    const oldRuntime = fakeRuntime("old-provider", "Old");
    const nextRuntime = fakeRuntime("new-provider", "New");
    const makeHarness: FakeCreateHarness = (_runtime, _session, options) => {
      order.push(`create:${options.model}`);
      return Promise.resolve({ harness: nextHarness, suspended: [] });
    };
    const host = new HarnessHost<HostedHarness, HostedRuntime>({
      harness: oldHarness,
      runtime: oldRuntime,
      sessionId: "session-1",
      cwd: "/repo",
      createHarness: makeHarness,
    });
    const unbound: string[] = [];
    host.bind((harness) => {
      const id = harness.state.model.id;
      order.push(`bind:${id}`);
      return () => unbound.push(id);
    });

    assert.equal(await host.switchRuntime(nextRuntime, "new-model"), true);
    assert.equal(host.harness, nextHarness);
    assert.equal(host.runtime, nextRuntime);
    assert.equal(oldClosed, true);
    assert.deepEqual(
      entries.map((entry) => entry.type),
      ["custom", "model_change"],
    );
    assert.deepEqual(order, [
      "bind:old-model",
      "create:new-model",
      "bind:new-model",
      "entry:custom",
      "entry:model_change",
      "close:old",
    ]);
    assert.deepEqual(unbound, ["old-model"]);
  });

  void test("keeps the current harness when replacement construction fails", async () => {
    const entries: ProvisionedEntry[] = [];
    const harness = fakeHarness({ session: recordingSession(entries), model: "old-model" });
    const runtime = fakeRuntime("old-provider", "Old");
    const nextRuntime = fakeRuntime("new-provider", "New");
    const makeHarness: FakeCreateHarness = () => Promise.reject(new Error("cannot create harness"));
    const host = new HarnessHost<HostedHarness, HostedRuntime>({
      harness,
      runtime,
      sessionId: "session-1",
      cwd: "/repo",
      createHarness: makeHarness,
    });

    await assert.rejects(host.switchRuntime(nextRuntime, "new-model"), /cannot create harness/);
    assert.equal(host.harness, harness);
    assert.equal(host.runtime, runtime);
    assert.deepEqual(entries, []);
  });

  void test("changes the tool root without changing the process directory", async () => {
    const before = process.cwd();
    const entries: ProvisionedEntry[] = [];
    const session = recordingSession(entries);
    const oldHarness = fakeHarness({ session });
    const nextHarness = fakeHarness({ session });
    const runtime = fakeRuntime("provider", "Provider");
    let configuredCwd = "";
    const makeHarness: FakeCreateHarness = (_runtime, _session, options) => {
      configuredCwd = options.cwd;
      return Promise.resolve({ harness: nextHarness, suspended: [] });
    };
    const host = new HarnessHost<HostedHarness, HostedRuntime>({
      harness: oldHarness,
      runtime,
      sessionId: "session-1",
      cwd: "/repo",
      createHarness: makeHarness,
      statDirectory: () => Promise.resolve({ isDirectory: () => true }),
    });

    assert.equal(await host.changeDirectory("packages/core"), "/repo/packages/core");
    assert.equal(configuredCwd, "/repo/packages/core");
    assert.equal(host.cwd, "/repo/packages/core");
    assert.equal(process.cwd(), before);
    const recorded = entries[0];
    assert.ok(recorded !== undefined && recorded.type === "custom");
    assert.equal(recorded.customType, "cwd_change");
  });

  void test("does not construct or record an untrusted directory", async () => {
    const entries: ProvisionedEntry[] = [];
    const session = recordingSession(entries);
    const harness = fakeHarness({ session });
    const runtime = fakeRuntime("provider", "Provider");
    let created = false;
    const host = new HarnessHost<HostedHarness, HostedRuntime>({
      harness,
      runtime,
      sessionId: "session-1",
      cwd: "/repo",
      createHarness: () => {
        created = true;
        return Promise.reject(new Error("must not create"));
      },
      statDirectory: () => Promise.resolve({ isDirectory: () => true }),
      authorizeWorkspace: () => Promise.reject(new Error("workspace not trusted")),
    });

    await assert.rejects(host.changeDirectory("../other"), /workspace not trusted/);
    assert.equal(created, false);
    assert.equal(host.cwd, "/repo");
    assert.equal(host.harness, harness);
    assert.deepEqual(entries, []);
  });

  void test("changes thinking level through a replacement harness and persists it", async () => {
    const entries: ProvisionedEntry[] = [];
    const session = recordingSession(entries);
    let oldClosed = false;
    const oldHarness = fakeHarness({
      session,
      onClose: () => {
        oldClosed = true;
      },
    });
    const nextHarness = fakeHarness({ session, thinkingLevel: "high" });
    const runtime = fakeRuntime("provider", "Provider");
    let configuredEffort = "";
    const makeHarness: FakeCreateHarness = (_runtime, _session, options) => {
      configuredEffort = options.effort ?? "";
      return Promise.resolve({ harness: nextHarness, suspended: [] });
    };
    const host = new HarnessHost<HostedHarness, HostedRuntime>({
      harness: oldHarness,
      runtime,
      sessionId: "session-1",
      cwd: "/repo",
      createHarness: makeHarness,
    });

    assert.equal(await host.changeThinkingLevel("high"), true);
    assert.equal(configuredEffort, "high");
    assert.equal(host.harness, nextHarness);
    assert.equal(oldClosed, true);
    assert.deepEqual(entries[0], {
      type: "thinking_level_change",
      id: entries[0]?.id,
      thinkingLevel: "high",
    });
  });

  void test("serializes replacement transitions in invocation order", async () => {
    const entries: ProvisionedEntry[] = [];
    const session = recordingSession(entries);
    const initialHarness = fakeHarness({ session });
    const highHarness = fakeHarness({ session, thinkingLevel: "high" });
    const lowHarness = fakeHarness({ session, thinkingLevel: "low" });
    const highCreateStarted = Promise.withResolvers<void>();
    const continueHighCreate = Promise.withResolvers<void>();
    const createdEfforts: ThinkingLevel[] = [];
    const makeHarness: FakeCreateHarness = async (_runtime, _session, options) => {
      if (options.effort === "high") {
        createdEfforts.push("high");
        highCreateStarted.resolve();
        await continueHighCreate.promise;
        return { harness: highHarness, suspended: [] };
      }
      assert.equal(options.effort, "low");
      createdEfforts.push("low");
      return { harness: lowHarness, suspended: [] };
    };
    const host = new HarnessHost<HostedHarness, HostedRuntime>({
      harness: initialHarness,
      runtime: fakeRuntime("provider"),
      sessionId: "session-1",
      cwd: "/repo",
      createHarness: makeHarness,
    });

    const high = host.changeThinkingLevel("high");
    await highCreateStarted.promise;
    const low = host.changeThinkingLevel("low");
    await Promise.resolve();
    assert.deepEqual(createdEfforts, ["high"]);

    continueHighCreate.resolve();
    assert.deepEqual(await Promise.all([high, low]), [true, true]);
    assert.equal(host.harness, lowHarness);
    assert.deepEqual(createdEfforts, ["high", "low"]);
    assert.deepEqual(
      entries.map((entry) =>
        entry.type === "thinking_level_change" ? entry.thinkingLevel : entry.type,
      ),
      ["high", "low"],
    );
  });

  void test("switches sessions without carrying the old session handle", async () => {
    let oldSessionClosed = false;
    const oldSession = fakeSession({
      close: () => {
        oldSessionClosed = true;
        return Promise.resolve();
      },
    });
    const nextSession = fakeSession();
    let oldHarnessClosed = false;
    const oldHarness = fakeHarness({
      session: oldSession,
      onClose: () => {
        oldHarnessClosed = true;
      },
    });
    const nextHarness = fakeHarness({ session: nextSession });
    const runtime = fakeRuntime("provider", "Provider");
    const makeHarness: FakeCreateHarness = (_runtime, session) => {
      assert.equal(session, nextSession);
      return Promise.resolve({ harness: nextHarness, suspended: [] });
    };
    const host = new HarnessHost<HostedHarness, HostedRuntime>({
      harness: oldHarness,
      runtime,
      sessionId: "session-1",
      cwd: "/repo",
      createHarness: makeHarness,
    });

    await host.switchSession(nextSession, "session-2");
    assert.equal(host.sessionId, "session-2");
    assert.equal(host.harness, nextHarness);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(oldHarnessClosed, true);
    assert.equal(oldSessionClosed, true);
  });

  void test("waits for its old handle to close before reopening a session", async () => {
    let releaseHarnessClose: (() => void) | undefined;
    const harnessClose = new Promise<void>((resolve) => {
      releaseHarnessClose = resolve;
    });
    let oldSessionClosed = false;
    const oldSession = fakeSession({
      close: () => {
        oldSessionClosed = true;
        return Promise.resolve();
      },
    });
    const nextSession = fakeSession();
    const reopenedSession = fakeSession();
    const oldHarness = fakeHarness({ session: oldSession, close: () => harnessClose });
    const nextHarness = fakeHarness({ session: nextSession });
    const reopenedHarness = fakeHarness({ session: reopenedSession });
    const runtime = fakeRuntime("provider", "Provider");
    const makeHarness: FakeCreateHarness = (_runtime, session) => {
      if (session === nextSession) {
        return Promise.resolve({ harness: nextHarness, suspended: [] });
      }
      assert.equal(session, reopenedSession);
      return Promise.resolve({ harness: reopenedHarness, suspended: [] });
    };
    const host = new HarnessHost<HostedHarness, HostedRuntime>({
      harness: oldHarness,
      runtime,
      sessionId: "session-1",
      cwd: "/repo",
      createHarness: makeHarness,
    });

    await host.switchSession(nextSession, "session-2");
    await new Promise<void>((resolve) => setImmediate(resolve));

    let reopened = false;
    const activation = host.activateSession("session-1", () => {
      reopened = true;
      return Promise.resolve(reopenedSession);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reopened, false);
    assert.equal(oldSessionClosed, false);

    assert.ok(releaseHarnessClose !== undefined);
    releaseHarnessClose();
    await activation;
    assert.equal(oldSessionClosed, true);
    assert.equal(reopened, true);
    assert.equal(host.sessionId, "session-1");
    assert.equal(host.harness, reopenedHarness);
    await host.close();
  });

  void test("keeps a running session in the background and reselects it without reopening", async () => {
    let finishRun: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    let oldSessionClosed = false;
    const oldSession = fakeSession({
      close: () => {
        oldSessionClosed = true;
        return Promise.resolve();
      },
    });
    const nextSession = fakeSession();
    const oldHarness = fakeHarness({
      session: oldSession,
      isStreaming: true,
      waitForIdle: () => running,
    });
    const nextHarness = fakeHarness({ session: nextSession });
    const runtime = fakeRuntime("provider", "Provider");
    const makeHarness: FakeCreateHarness = () =>
      Promise.resolve({ harness: nextHarness, suspended: [] });
    const host = new HarnessHost<HostedHarness, HostedRuntime>({
      harness: oldHarness,
      runtime,
      sessionId: "session-1",
      cwd: "/repo",
      createHarness: makeHarness,
    });

    await host.switchSession(nextSession, "session-2");
    assert.equal(oldSessionClosed, false);

    let reopened = false;
    await host.activateSession("session-1", () => {
      reopened = true;
      return Promise.resolve(oldSession);
    });
    assert.equal(reopened, false);
    assert.equal(host.sessionId, "session-1");
    assert.equal(host.harness, oldHarness);
    assert.equal(oldSessionClosed, false);

    assert.ok(finishRun !== undefined);
    finishRun();
  });

  void test("close waits for a replacement and discards the harness it created", async () => {
    let oldHarnessClosed = 0;
    let nextHarnessClosed = 0;
    let sessionClosed = 0;
    const session = fakeSession({
      close: () => {
        sessionClosed += 1;
        return Promise.resolve();
      },
    });
    const oldHarness = fakeHarness({
      session,
      onClose: () => {
        oldHarnessClosed += 1;
      },
    });
    const nextHarness = fakeHarness({
      session,
      thinkingLevel: "high",
      onClose: () => {
        nextHarnessClosed += 1;
      },
    });
    let resolveCreate: (() => void) | undefined;
    let sawCreate: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      sawCreate = resolve;
    });
    const makeHarness: FakeCreateHarness = async () => {
      sawCreate?.();
      await new Promise<void>((resolve) => {
        resolveCreate = resolve;
      });
      return { harness: nextHarness, suspended: [] };
    };
    const host = new HarnessHost<HostedHarness, HostedRuntime>({
      harness: oldHarness,
      runtime: fakeRuntime("provider"),
      sessionId: "session-1",
      cwd: "/repo",
      createHarness: makeHarness,
    });

    const changing = host.changeThinkingLevel("high");
    await createStarted;
    const firstClose = host.close();
    const secondClose = host.close();
    assert.equal(firstClose, secondClose);
    let closeSettled = false;
    void firstClose.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    assert.equal(closeSettled, false);
    assert.ok(resolveCreate !== undefined);
    resolveCreate();

    await assert.rejects(changing, /Harness host is closed/);
    await firstClose;
    assert.equal(closeSettled, true);
    assert.equal(nextHarnessClosed, 1);
    assert.equal(oldHarnessClosed, 1);
    assert.equal(sessionClosed, 1);
  });
});

void test("resolveDirectory expands relative paths and home", () => {
  assert.equal(resolveDirectory("/repo", "packages/core"), "/repo/packages/core");
  assert.equal(resolveDirectory("/repo", "/tmp/work"), "/tmp/work");
  assert.equal(resolveDirectory("/repo", "~"), process.env["HOME"]);
});
