/**
 * Host behaviour that the proof of concept does not cover: disposal of
 * effects, contributions to prompt and commands, and a file plugin loaded
 * from disk with same-name replacement of a built-in.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { AssistantMessage, AssistantMessageEvent, Model, Usage } from "@uji-ai/ai";
import { EventStream } from "@uji-ai/ai";
import { resolvePlugins, watchPluginDirectories } from "../src/index.ts";
import type { StreamFn } from "../src/types.ts";
import { AgentHarness } from "../src/harness/agent-harness.ts";
import { definePlugin, inlinePlugin, systemPromptPlugin } from "../src/plugins/index.ts";
import type { EphemeralEvent } from "../src/sdk/types.ts";
import { SqliteSessionRepo } from "../src/store.ts";
import { prompt } from "./harness-driver.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

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

function stopStream(seen: string[]): StreamFn {
  return (_model, context) => {
    seen.push(context.systemPrompt ?? "");
    const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("no terminal event");
      },
    );
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => events.push({ type: "done", reason: "stop", message }));
    return events;
  };
}

async function open(plugins: Parameters<typeof AgentHarness.create>[0]["plugins"]) {
  const directory = tempDir("uji-plugins-host-");
  const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
  const session = await repo.create();
  const seen: string[] = [];
  const harness = await AgentHarness.create({
    session,
    streamFn: stopStream(seen),
    plugins,
    env: { cwd: directory },
    model,
  });
  harness.attach();
  const events: EphemeralEvent[] = [];
  harness.subscribe((event) => {
    events.push(event);
  });
  return {
    harness,
    events,
    seen,
    close: async () => {
      await harness.close();
      await session.close();
      await repo.close();
    },
  };
}

void describe("PluginHost", () => {
  void test("prompt sections join by order; commands run by name", async () => {
    const base = inlinePlugin(systemPromptPlugin("base"));
    const h = await open([base]);
    await h.harness.plugins.activate([
      base,
      inlinePlugin(
        definePlugin({
          id: "extra",
          session(api) {
            api.prompt.add((d) => d.set("env", { text: "cwd: /x", order: 10 }));
            api.commands.add((d) =>
              d.set("hello", { description: "say hi", run: (arg) => `hi ${arg}` }),
            );
          },
        }),
      ),
    ]);
    assert.equal(h.harness.getSystemPrompt(), "base\n\ncwd: /x");
    await prompt(h.harness, "go");
    assert.equal(h.seen[0], "base\n\ncwd: /x");
    assert.equal(await h.harness.runCommand("hello", "there"), "hi there");
    await h.close();
  });

  void test("settings: choices read and apply through plugin storage; the registry announces", async () => {
    const h = await open([]);
    const tiers = inlinePlugin(
      definePlugin({
        id: "tiers",
        session(api) {
          api.settings.add((d) =>
            d.set("tier", {
              label: "Tier",
              key: "tier",
              fallback: "normal",
              choices: [
                { id: "fast", label: "fast", status: "fast" },
                { id: "normal", label: "normal" },
              ],
            }),
          );
        },
      }),
    );
    await h.harness.plugins.activate([tiers]);
    // Owner comes from the replaying contribution, not from the plugin's own claim.
    assert.deepEqual(
      (await h.harness.listSettings()).map(({ id, owner, current }) => ({ id, owner, current })),
      [{ id: "tier", owner: "tiers", current: "normal" }],
    );
    assert.deepEqual(await h.harness.applySetting("tier", "fast"), { kind: "applied" });
    assert.equal((await h.harness.listSettings())[0]?.current, "fast");
    assert.deepEqual(await h.harness.applySetting("tier", "glacial"), { kind: "invalid_choice" });

    // The value survives the descriptor: a rebuilt registry reads the same storage.
    await h.harness.plugins.activate([]);
    assert.equal(h.harness.registries.settings.current().has("tier"), false);
    assert.deepEqual(await h.harness.applySetting("tier", "fast"), { kind: "not_found" });
    await h.harness.plugins.activate([tiers]);
    assert.equal((await h.harness.listSettings())[0]?.current, "fast");
    await h.close();
  });

  void test("close is idempotent", async () => {
    const h = await open([inlinePlugin(systemPromptPlugin("base"))]);
    await Promise.all([h.harness.close(), h.harness.close()]);
    // Closed means closed: a later verb refuses instead of half-working.
    await assert.rejects(h.harness.abort(), { message: "harness is closed" });
    await h.close();
  });

  void test("a throwing contribution is a diagnostic, not an empty table", async () => {
    const base = inlinePlugin(systemPromptPlugin("base"));
    const h = await open([base]);
    await h.harness.plugins.activate([
      base,
      inlinePlugin(
        definePlugin({
          id: "bad",
          session(api) {
            api.prompt.add(() => {
              throw new Error("boom");
            });
          },
        }),
      ),
    ]);
    assert.equal(h.harness.getSystemPrompt(), "base");
    assert.equal(
      h.events.some((e) => e.kind === "diagnostic" && e.owner === "bad" && e.message === "boom"),
      true,
    );
    await h.close();
  });
});

void describe("resolvePlugins", () => {
  void test("loads files, replaces a built-in with the same name, appends new ids, honours the manifest", async () => {
    const dir = tempDir("uji-plugins-dir-");
    writeFileSync(
      join(dir, "system-prompt.ts"),
      `export default { id: "system-prompt", session(api) { api.prompt.add((d) => d.set("p", { text: "mine" })); } };`,
    );
    mkdirSync(join(dir, "profile"));
    writeFileSync(
      join(dir, "profile", "index.ts"),
      `export default { id: "profile", session() {} };`,
    );
    writeFileSync(join(dir, "broken.ts"), `export default { nope: true };`);
    writeFileSync(join(dir, "notes.md"), `ignored`);

    const builtins = [
      definePlugin({ id: "system-prompt", session() {} }),
      definePlugin({ id: "tools-fs", session() {} }),
      definePlugin({ id: "skills", session() {} }),
    ];
    const resolved = await resolvePlugins({
      builtins,
      directories: [{ path: dir, source: "project" }],
      manifest: { plugins: ["-skills", { id: "profile", options: { depth: 2 } }] },
    });
    assert.deepEqual(
      resolved.plugins.map((p) => [p.id, p.source]),
      [
        ["system-prompt", "project"],
        ["tools-fs", "builtin"],
        ["profile", "project"],
      ],
    );
    assert.equal(resolved.failures.length, 1);
    assert.match(resolved.failures[0]?.error ?? "", /not a plugin/);

    // An edit changes the version, so the host reloads it.
    const before = resolved.plugins[0]?.version;
    utimesSync(
      join(dir, "system-prompt.ts"),
      new Date(Date.now() + 5_000),
      new Date(Date.now() + 5_000),
    );
    const again = await resolvePlugins({
      builtins,
      directories: [{ path: dir, source: "project" }],
    });
    assert.notEqual(again.plugins.find((p) => p.id === "system-prompt")?.version, before);
  });

  void test("a file whose id does not match its name is a load failure", async () => {
    const dir = tempDir("uji-plugins-dir-");
    writeFileSync(join(dir, "alpha.ts"), `export default { id: "beta", session() {} };`);
    const resolved = await resolvePlugins({
      builtins: [],
      directories: [{ path: dir, source: "user" }],
    });
    assert.equal(resolved.plugins.length, 0);
    assert.match(resolved.failures[0]?.error ?? "", /must match the file name/);
  });
});

/** Reject after `ms`, clearing the timer either way so a failure cannot outlive the test. */
async function withTimeout<T>(promise: Promise<T>, message: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

void describe("watchPluginDirectories", () => {
  void test("an edit under a watched directory fires onChange once per burst; stop ends it", async () => {
    const dir = tempDir("uji-plugins-watch-");
    const debounceMs = 50;
    let fired = 0;
    let observed: (() => void) | undefined;
    const nextChange = (): Promise<void> =>
      new Promise<void>((resolve) => {
        observed = resolve;
      });
    const stop = watchPluginDirectories({
      directories: [{ path: dir }],
      debounceMs,
      onChange: () => {
        fired += 1;
        observed?.();
      },
    });
    let priming: ReturnType<typeof setInterval> | undefined;
    // The watcher is an OS handle that keeps the process alive: it and the
    // priming timer are released whether the assertions pass, fail, or time out.
    try {
      // Readiness: the native watcher reports nothing until it is live, and
      // nothing says when that is. Touch a priming file, one touch per two
      // debounce windows so each lands as its own burst, until one is seen.
      const ready = nextChange();
      let touches = 0;
      priming = setInterval(() => {
        touches += 1;
        writeFileSync(join(dir, "prime.txt"), String(touches));
      }, debounceMs * 2);
      await withTimeout(ready, "the watcher never reported a priming touch", 10_000);
      clearInterval(priming);
      priming = undefined;
      // Drain what the last touch may still have scheduled, then start counting.
      await sleep(debounceMs * 3);
      fired = 0;
      const burst = nextChange();
      // Both writes land inside one debounce window, so they are one burst.
      writeFileSync(join(dir, "a.ts"), "export default { id: 'a', session() {} };");
      writeFileSync(join(dir, "b.ts"), "export default { id: 'b', session() {} };");
      await withTimeout(burst, "no change event for the burst", 5_000);
      // Anything else from the same burst has had two full windows to land.
      await sleep(debounceMs * 3);
      assert.equal(fired, 1);
    } finally {
      if (priming !== undefined) clearInterval(priming);
      stop();
    }
    writeFileSync(join(dir, "c.ts"), "export default { id: 'c', session() {} };");
    await sleep(debounceMs * 4);
    assert.equal(fired, 1);
  });
});
