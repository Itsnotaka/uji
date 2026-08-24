import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { AssistantMessage, AssistantMessageEvent, Model, Usage } from "@uji-ai/ai";
import { EventStream } from "@uji-ai/ai";
import {
  AgentHarness,
  buildSystemPrompt,
  DEFAULT_SELECTED_TOOLS,
  DEFAULT_TOOL_SNIPPETS,
  inlinePlugin,
  SqliteSessionRepo,
  systemPromptPlugin,
} from "../src/index.ts";
import type { StreamFn } from "../src/types.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
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
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_000,
  maxTokens: 256,
};

const stop: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  api: "openai-responses",
  provider: "openai",
  model: "test-model",
  usage,
  stopReason: "stop",
  timestamp: Date.now(),
};

const streamFn: StreamFn = () => {
  const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
      throw new Error("stream ended without a terminal event");
    },
  );
  queueMicrotask(() => events.push({ type: "done", reason: "stop", message: stop }));
  return events;
};

void describe("buildSystemPrompt", () => {
  void test("default prompt lists uji tools and cwd, with no guidelines section", () => {
    const prompt = buildSystemPrompt({ cwd: String.raw`C:\work\uji` });

    assert.match(
      prompt,
      /You are an expert coding assistant operating inside uji, a coding agent harness/,
    );
    const toolsList = DEFAULT_SELECTED_TOOLS.map(
      (name) => `- ${name}: ${DEFAULT_TOOL_SNIPPETS[name]}`,
    ).join("\n");
    assert.ok(prompt.includes(`Available tools:\n${toolsList}`));
    assert.match(prompt, /Current working directory: C:\/work\/uji$/);
    assert.equal(prompt.includes("Guidelines:"), false);
    assert.equal(prompt.includes("Pi documentation"), false);
  });

  void test("promptGuidelines become a Guidelines section; empty entries are skipped", () => {
    const prompt = buildSystemPrompt({
      cwd: "/tmp",
      promptGuidelines: [" Prefer diffs. ", "", "Prefer diffs."],
    });
    assert.match(prompt, /Guidelines:\n- Prefer diffs\.\n\nCurrent working directory: \/tmp$/);
  });

  void test("customPrompt replaces the body and still appends cwd", () => {
    const prompt = buildSystemPrompt({
      cwd: "/repo",
      customPrompt: "You are a reviewer.",
      appendSystemPrompt: "Prefer diffs.",
    });
    assert.equal(
      prompt,
      "You are a reviewer.\n\nPrefer diffs.\nCurrent working directory: /repo\n",
    );
  });
});

void describe("systemPromptPlugin", () => {
  void test("omitted text builds the default prompt from session cwd", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uji-system-prompt-"));
    directories.push(directory);
    const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
    const session = await repo.create();
    const { harness } = await AgentHarness.create({
      session,
      streamFn,
      plugins: [inlinePlugin(systemPromptPlugin())],
      env: { cwd: directory },
      model,
    });
    try {
      const prompt = harness.getSystemPrompt();
      assert.equal(prompt, buildSystemPrompt({ cwd: directory }));
    } finally {
      await harness.close();
      await session.close();
      await repo.close();
    }
  });

  void test("explicit text is used as the section unchanged", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uji-system-prompt-custom-"));
    directories.push(directory);
    const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
    const session = await repo.create();
    const { harness } = await AgentHarness.create({
      session,
      streamFn,
      plugins: [inlinePlugin(systemPromptPlugin("base"))],
      env: { cwd: directory },
      model,
    });
    try {
      assert.equal(harness.getSystemPrompt(), "base");
    } finally {
      await harness.close();
      await session.close();
      await repo.close();
    }
  });
});
