import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Model } from "@uji-ai/ai";
import { AgentHarness, buildSystemPrompt, inlinePlugin, SqliteSessionRepo } from "@uji-ai/core";
import { cliBuiltinPlugins, openRunSession, parsePluginManifest } from "../src/run.ts";

const model: Model<"openai-responses"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "test",
  baseUrl: "https://example.invalid",
  reasoning: false,
  modes: ["fast"],
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};

void test("keeps the question example opt-in while preinstalling fast mode", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uji-tui-plugins-"));
  const plugins = cliBuiltinPlugins(directory, model);
  assert.deepEqual(
    plugins.map((plugin) => plugin.id),
    ["system-prompt", "context-files", "tools-fs", "fast-mode", "skills"],
  );

  const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
  const session = await repo.create();
  const { harness } = await AgentHarness.create({
    session,
    streamFn() {
      throw new Error("streamFn should not run while inspecting plugins");
    },
    plugins: plugins.map((plugin) => inlinePlugin(plugin)),
    env: { cwd: directory },
    model,
  });
  try {
    assert.equal(
      harness.getTools().some((tool) => tool.name === "question"),
      false,
    );
    assert.equal(harness.getCommands().has("fast"), true);
    assert.equal(harness.getSystemPrompt().startsWith(buildSystemPrompt({ cwd: directory })), true);
  } finally {
    await harness.close();
    await session.close();
    await repo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("opens the latest or specified session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uji-tui-resume-"));
  const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
  try {
    const first = await repo.create({ id: "session-a" });
    const firstId = (await first.getMetadata()).id;
    await first.close();

    const second = await repo.create({ id: "session-b" });
    const secondId = (await second.getMetadata()).id;
    await second.close();

    const latest = await openRunSession(repo, { kind: "latest" });
    assert.equal((await latest.getMetadata()).id, secondId);
    await latest.close();

    const specified = await openRunSession(repo, { kind: "session", id: firstId });
    assert.equal((await specified.getMetadata()).id, firstId);
    await specified.close();
  } finally {
    await repo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("parses the project plugin manifest at the file boundary", () => {
  const cases = [
    { input: {}, expected: {} },
    { input: { plugins: [] }, expected: { plugins: [] } },
    {
      input: {
        plugins: ["-skills", { id: "profile", options: { depth: 2, labels: ["a", null] } }],
      },
      expected: {
        plugins: ["-skills", { id: "profile", options: { depth: 2, labels: ["a", null] } }],
      },
    },
  ];

  for (const { input, expected } of cases) {
    assert.deepEqual(parsePluginManifest(input), expected);
  }
});

void test("rejects malformed project plugin manifests", () => {
  const cases: Array<{ input: unknown; message: RegExp }> = [
    { input: null, message: /uji\.json must be an object/ },
    { input: [], message: /uji\.json must be an object/ },
    { input: { plugin: [] }, message: /unknown property "plugin"/ },
    { input: { plugins: {} }, message: /plugins must be an array/ },
    { input: { plugins: [1] }, message: /plugins\[0\] must be a string or object/ },
    { input: { plugins: [{}] }, message: /plugins\[0\]\.id must be a string/ },
    { input: { plugins: [{ id: 1 }] }, message: /plugins\[0\]\.id must be a string/ },
    {
      input: { plugins: [{ id: "profile", enabled: true }] },
      message: /plugins\[0\] has unknown property "enabled"/,
    },
    {
      input: { plugins: [{ id: "profile", options: BigInt(1) }] },
      message: /plugins\[0\]\.options must be JSON/,
    },
  ];

  for (const { input, message } of cases) {
    assert.throws(() => parsePluginManifest(input), message);
  }
});
