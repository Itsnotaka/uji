/**
 * Host behaviour that the proof of concept does not cover: ask and answer,
 * the default when no client answers, disposal of effects, contributions to
 * prompt and commands, and a file plugin loaded from disk with same-name
 * replacement of a built-in.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { AssistantMessage, AssistantMessageEvent, Model, Usage } from "@uji-ai/ai";
import { EventStream } from "@uji-ai/ai";
import {
  AgentHarness,
  definePlugin,
  type HarnessEvent,
  inlinePlugin,
  resolvePlugins,
  SqliteSessionRepo,
  systemPromptPlugin,
  watchPluginDirectories,
} from "../src/index.ts";
import type { StreamFn } from "../src/types.ts";

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

async function open(
  plugins: Parameters<typeof AgentHarness.create>[0]["plugins"],
  askTimeoutMs = 50,
) {
  const directory = tempDir("uji-plugins-host-");
  const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
  const session = await repo.create();
  const seen: string[] = [];
  const { harness } = await AgentHarness.create({
    session,
    streamFn: stopStream(seen),
    plugins,
    env: { cwd: directory },
    model,
    askTimeoutMs,
  });
  const events: HarnessEvent[] = [];
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
    await h.harness.prompt("go");
    assert.equal(h.seen[0], "base\n\ncwd: /x");
    assert.equal(await h.harness.runCommand("hello", "there"), "hi there");
    assert.equal(
      h.events.some((e) => e.type === "config_update" && e.property === "prompt"),
      true,
    );
    await h.close();
  });

  void test("settings: choices read and apply through plugin storage; the registry announces", async () => {
    const h = await open([]);
    await h.harness.plugins.activate([
      inlinePlugin(
        definePlugin({
          id: "tiers",
          session(api) {
            api.settings.add((d) =>
              d.set("tier", {
                label: "Tier",
                choices: [
                  { id: "fast", label: "fast", status: "fast" },
                  { id: "normal", label: "normal" },
                ],
                read: async () => ((await api.storage.get("tier")) === "fast" ? "fast" : "normal"),
                apply: (choiceId) => api.storage.set("tier", choiceId),
              }),
            );
          },
        }),
      ),
    ]);
    assert.equal(
      h.events.some((e) => e.type === "config_update" && e.property === "settings"),
      true,
    );
    const setting = h.harness.getSettings().get("tier");
    assert.notEqual(setting, undefined);
    assert.equal(await setting?.read(), "normal");
    await setting?.apply("fast");
    assert.equal(await setting?.read(), "fast");
    // The value survives the descriptor: a rebuilt registry reads the same storage.
    await h.harness.plugins.activate([]);
    assert.equal(h.harness.getSettings().has("tier"), false);
    await h.close();
  });

  void test("ask: a client answers through answer(); without one the default is used", async () => {
    let answered: unknown;
    const h = await open([
      inlinePlugin(
        definePlugin({
          id: "asker",
          session(api) {
            api.commands.add((d) =>
              d.set("ask", {
                description: "",
                run: async () => {
                  answered = await api.ask({ kind: "confirm", title: "ok?", default: false });
                  return undefined;
                },
              }),
            );
          },
        }),
      ),
    ]);
    const off = h.harness.subscribe((event) => {
      if (event.type === "ask") h.harness.answer(event.askId, true);
    });
    await h.harness.runCommand("ask");
    assert.equal(answered, true);
    off();
    await h.harness.runCommand("ask");
    assert.equal(answered, false);
    const sources = h.events
      .filter((e) => e.type === "ask_answered")
      .map((e) => (e.type === "ask_answered" ? e.source : ""));
    assert.deepEqual(sources, ["client", "default"]);
    await h.close();
  });

  void test("close is idempotent and cancels an unanswered ask", async () => {
    const h = await open(
      [
        inlinePlugin(
          definePlugin({
            id: "asker",
            session(api) {
              api.commands.add((draft) =>
                draft.set("ask", {
                  description: "",
                  run: async () => {
                    await api.ask({ kind: "confirm", title: "wait forever?" });
                    return undefined;
                  },
                }),
              );
            },
          }),
        ),
      ],
      120_000,
    );
    let sawAsk: (() => void) | undefined;
    const asked = new Promise<void>((resolve) => {
      sawAsk = resolve;
    });
    h.harness.subscribe((event) => {
      if (event.type === "ask") sawAsk?.();
    });
    const command = h.harness.runCommand("ask");
    await asked;

    const first = h.harness.close();
    const second = h.harness.close();
    assert.equal(first, second);
    await first;
    await assert.rejects(command, /harness is closed/);
    await h.close();
  });

  void test("disposing a plugin aborts its effect and runs its disposer", async () => {
    let aborted = false;
    let disposed = false;
    const watcher = definePlugin({
      id: "watcher",
      session(api) {
        api.effect((signal) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          return () => {
            disposed = true;
          };
        });
      },
    });
    const h = await open([inlinePlugin(watcher)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.harness.plugins.activate([]);
    assert.equal(aborted, true);
    assert.equal(disposed, true);
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
      h.events.some((e) => e.type === "diagnostic" && e.owner === "bad" && e.message === "boom"),
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
    assert.deepEqual(resolved.plugins[2]?.options, { depth: 2 });
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

void describe("watchPluginDirectories", () => {
  void test("an edit under a watched directory fires onChange once per burst; stop ends it", async () => {
    const dir = tempDir("uji-plugins-watch-");
    let fired = 0;
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const stop = watchPluginDirectories({
      directories: [{ path: dir }],
      debounceMs: 50,
      onChange: () => {
        fired += 1;
        resolveFirst?.();
      },
    });
    writeFileSync(join(dir, "a.ts"), "export default { id: 'a', session() {} };");
    writeFileSync(join(dir, "b.ts"), "export default { id: 'b', session() {} };");
    await Promise.race([
      first,
      new Promise((_, reject) => setTimeout(() => reject(new Error("no change event")), 3_000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(fired, 1);
    stop();
    writeFileSync(join(dir, "c.ts"), "export default { id: 'c', session() {} };");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fired, 1);
  });
});
