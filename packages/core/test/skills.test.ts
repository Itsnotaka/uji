import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { AssistantMessage, AssistantMessageEvent, Model, Usage } from "@uji-ai/ai";
import { EventStream } from "@uji-ai/ai";
import type { StreamFn } from "../src/types.ts";
import { AgentHarness } from "../src/harness/agent-harness.ts";
import { formatSkillsForPrompt, loadSkills } from "../src/skills.ts";
import {
  formatSkillInvocation,
  inlinePlugin,
  skillsPlugin,
  systemPromptPlugin,
} from "../src/plugins/index.ts";
import { SqliteSessionRepo } from "../src/store.ts";
import { prompt } from "./harness-driver.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "uji-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeSkill(
  root: string,
  name: string,
  description: string | undefined,
  body: string,
  extraFrontmatter = "",
): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  const descriptionLine = description === undefined ? "" : `description: ${description}\n`;
  writeFileSync(path, `---\nname: ${name}\n${descriptionLine}${extraFrontmatter}---\n${body}\n`);
  return path;
}

void describe("skills", () => {
  void test("discovers standard skill folders, honors ignores, and diagnoses invalid metadata", async () => {
    const root = tempDir();
    const alphaPath = writeSkill(root, "alpha", "Alpha workflow", "Use alpha.");
    writeSkill(root, "ignored", "Ignored workflow", "Do not load.");
    writeSkill(root, "broken", undefined, "Missing its description.");
    writeFileSync(join(root, ".gitignore"), "ignored/\n");

    const loaded = await loadSkills(root);

    assert.deepEqual(loaded.skills, [
      {
        name: "alpha",
        description: "Alpha workflow",
        content: "Use alpha.",
        filePath: alphaPath,
        disableModelInvocation: false,
      },
    ]);
    assert.equal(loaded.diagnostics.length, 1);
    assert.equal(loaded.diagnostics[0]?.code, "invalid_metadata");
    assert.equal(loaded.diagnostics[0]?.message, "description is required");
  });

  void test("stops walking at a skill root and excludes opt-out skills from the catalog", async () => {
    const root = tempDir();
    const parentPath = writeSkill(
      root,
      "parent",
      "Parent & <workflow>",
      "Use parent.",
      "disable-model-invocation: true\n",
    );
    writeSkill(join(root, "parent"), "child", "Child workflow", "Do not discover.");

    const loaded = await loadSkills(root);

    assert.deepEqual(
      loaded.skills.map((skill) => skill.name),
      ["parent"],
    );
    assert.equal(formatSkillsForPrompt(loaded.skills), "");
    const invocation = formatSkillInvocation(loaded.skills[0]!, "Review this");
    assert.equal(invocation.includes(`<skill name="parent" location="${parentPath}">`), true);
    assert.equal(invocation.endsWith("Review this"), true);
  });
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
  contextWindow: 100_000,
  maxTokens: 1_000,
};

function stopStream(prompts: string[]): StreamFn {
  return (_model, context) => {
    prompts.push(JSON.stringify(context));
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

void test("the skills plugin exposes resources and explicit invocation runs a skill turn", async () => {
  const root = tempDir();
  const skillsDirectory = join(root, "skills");
  const skillPath = writeSkill(
    skillsDirectory,
    "review",
    "Review TypeScript changes",
    "Inspect the types first.",
  );
  const repo = new SqliteSessionRepo(join(root, "sessions.db"));
  const session = await repo.create();
  const prompts: string[] = [];
  const harness = await AgentHarness.create({
    session,
    streamFn: stopStream(prompts),
    plugins: [
      inlinePlugin(systemPromptPlugin("base")),
      inlinePlugin(skillsPlugin({ directories: [skillsDirectory] })),
    ],
    env: { cwd: root },
    model,
  });
  harness.attach();
  try {
    assert.equal(harness.getResources().get("review")?.filePath, skillPath);
    assert.match(harness.getSystemPrompt(), /<name>review<\/name>/);

    const review = harness.getResources().get("review");
    assert.ok(review);
    const result = await prompt(harness, formatSkillInvocation(review, "Check the parser"));
    assert.equal(result.outcome.kind, "completed");
    assert.match(prompts[0] ?? "", /Inspect the types first\./);
    assert.match(prompts[0] ?? "", /Check the parser/);

    assert.equal(harness.getResources().get("missing"), undefined);
  } finally {
    await harness.close();
    await session.close();
    await repo.close();
  }
});
