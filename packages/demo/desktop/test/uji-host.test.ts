import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type Model,
} from "@uji-ai/ai";
import type { StreamFn } from "@uji-ai/core";
import { demoAgentDrafts, parseAgentDraft, type AgentDraft, type AgentId } from "../src/agents.ts";
import type { UjiDesktopEvent } from "../src/desktop-api.ts";
import { UjiHost, type UjiHostDependencies } from "../src/main/uji-host.ts";

const ujiDraft: AgentDraft = {
  name: "Uji",
  role: "Chief of staff",
  instructions: "Help the user think, plan, write, and follow through.",
  avatar: "orange",
};

const scoutDraft: AgentDraft = {
  name: "Scout",
  role: "Research lead",
  instructions: "Evaluate evidence supplied by the user and finish with a recommendation.",
  avatar: "blue",
};

const testModel: Model<"openai-responses"> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

class DeterministicAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type");
      },
    );
  }
}

void test("starts empty and persists user-created agents and their conversations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uji-agents-"));
  const databasePath = join(directory, "sessions.db");
  const events: UjiDesktopEvent[] = [];
  const prompts = new Map<AgentId, string>();
  const dependencies = deterministicDependencies(prompts);
  const host = new UjiHost(databasePath, (event) => events.push(event), dependencies);
  let seedId = "";
  let scoutId = "";

  try {
    const initial = await host.initialize();
    assert.deepEqual(initial.agents, []);
    assert.equal(initial.activeAgentId, null);
    assert.deepEqual(initial.messages, []);
    await assert.rejects(() => host.send("no agent yet"), /Create an agent first/);

    const first = await host.createAgent(ujiDraft);
    assert.equal(first.agents.length, 1);
    const seed = first.agents[0];
    assert.ok(seed);
    assert.equal(seed.name, "Uji");
    assert.equal(seed.avatar, "orange");
    assert.equal(first.activeAgentId, seed.id);
    seedId = seed.id;

    const answered = await host.send("A real request");
    assert.equal(answered.messages.length, 2);
    assert.equal(messageText(answered.messages[1]?.message.content), "Handled: A real request");
    assert.equal(prompts.get(seedId), seed.instructions);

    const created = await host.createAgent(scoutDraft);
    assert.equal(created.agents.length, 2);
    assert.ok(created.activeAgentId);
    assert.notEqual(created.activeAgentId, seedId);
    assert.deepEqual(created.messages, []);
    scoutId = created.activeAgentId;

    const scoutAnswered = await host.send("Scout request");
    assert.equal(scoutAnswered.messages.length, 2);
    assert.equal(prompts.get(scoutId), scoutDraft.instructions);

    const restored = await host.selectAgent(seedId);
    assert.equal(restored.messages.length, 2);
    assert.equal(messageText(restored.messages[0]?.message.content), "A real request");

    assert.ok(events.some((event) => event.type === "running" && event.running));
    assert.ok(events.some((event) => event.type === "delta"));
    assert.ok(events.some((event) => event.type === "snapshot"));
  } finally {
    await host.close();
  }

  const restoredHost = new UjiHost(databasePath, () => undefined, dependencies);
  try {
    const resumed = await restoredHost.initialize();
    assert.equal(resumed.agents.length, 2);
    assert.equal(resumed.activeAgentId, scoutId);
    const scout = resumed.agents.find((agent) => agent.id === scoutId);
    assert.deepEqual(scout, { id: scoutId, ...scoutDraft });
    const reselected = await restoredHost.selectAgent(seedId);
    assert.equal(reselected.messages.length, 2);
  } finally {
    await restoredHost.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test("initial agents are seeded once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uji-initial-agents-"));
  const databasePath = join(directory, "sessions.db");
  const dependencies = deterministicDependencies(new Map());
  dependencies.initialAgents = demoAgentDrafts;

  const host = new UjiHost(databasePath, () => undefined, dependencies);
  try {
    const initial = await host.initialize();
    assert.deepEqual(
      initial.agents.map((agent) => agent.name),
      demoAgentDrafts.map((agent) => agent.name),
    );
    assert.equal(initial.activeAgentId, initial.agents[0]?.id);
  } finally {
    await host.close();
  }

  const restoredHost = new UjiHost(databasePath, () => undefined, dependencies);
  try {
    const restored = await restoredHost.initialize();
    assert.equal(restored.agents.length, demoAgentDrafts.length);
  } finally {
    await restoredHost.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test("deleted agents stay deleted and their conversations disappear", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uji-delete-"));
  const databasePath = join(directory, "sessions.db");
  const dependencies = deterministicDependencies(new Map());
  const host = new UjiHost(databasePath, () => undefined, dependencies);
  let seedId = "";

  try {
    await host.initialize();
    const seeded = await host.createAgent(ujiDraft);
    assert.ok(seeded.activeAgentId);
    seedId = seeded.activeAgentId;
    await host.send("Keep this");

    const created = await host.createAgent(scoutDraft);
    assert.ok(created.activeAgentId);
    const scoutId = created.activeAgentId;
    await host.send("Scoped to Scout");

    const afterScoutDelete = await host.deleteAgent(scoutId);
    assert.equal(afterScoutDelete.agents.length, 1);
    assert.equal(afterScoutDelete.activeAgentId, seedId);
    assert.equal(afterScoutDelete.messages.length, 2);

    const afterSeedDelete = await host.deleteAgent(seedId);
    assert.equal(afterSeedDelete.agents.length, 0);
    assert.equal(afterSeedDelete.activeAgentId, null);
    assert.deepEqual(afterSeedDelete.messages, []);
  } finally {
    await host.close();
  }

  const restoredHost = new UjiHost(databasePath, () => undefined, dependencies);
  try {
    const resumed = await restoredHost.initialize();
    assert.equal(resumed.agents.length, 0);
    assert.equal(resumed.activeAgentId, null);

    const recreated = await restoredHost.createAgent(scoutDraft);
    assert.equal(recreated.agents.length, 1);
  } finally {
    await restoredHost.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test("the product renderer stays on the minimal chat path", async () => {
  const files = ["src/App.tsx", "src/styles.css"];
  const source = (
    await Promise.all(files.map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")))
  ).join("\n");
  assert.match(source, /agent-strip/);
  assert.match(source, /className="composer"/);
  assert.doesNotMatch(source, /Sidebar|SearchPalette|BotDetails|@tanstack|@stylexjs/);
});

void test("signed-out users can complete login and message an agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uji-login-"));
  let signedIn = false;
  const events: UjiDesktopEvent[] = [];
  const dependencies = deterministicDependencies(new Map());
  dependencies.authStatus = () =>
    Promise.resolve({
      signedIn,
      label: signedIn ? "Test provider connected" : "Test provider not connected",
    });
  dependencies.login = async (emit) => {
    emit({ type: "status", message: "Opening test login…" });
    signedIn = true;
  };
  const host = new UjiHost(
    join(directory, "sessions.db"),
    (event) => events.push(event),
    dependencies,
  );

  try {
    assert.equal((await host.initialize()).auth.signedIn, false);
    await host.createAgent(ujiDraft);
    await assert.rejects(() => host.send("before login"), /Sign in with ChatGPT first/);
    assert.equal((await host.login()).auth.signedIn, true);
    const answered = await host.send("Launch note");
    assert.equal(messageText(answered.messages[1]?.message.content), "Handled: Launch note");
    assert.ok(
      events.some((event) => event.type === "status" && event.message === "Opening test login…"),
    );
  } finally {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a message submitted during a run joins the active loop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uji-queue-"));
  const gate = gatedStream();
  const dependencies = deterministicDependencies(new Map());
  dependencies.createStreamFn = () => gate.streamFn;
  const host = new UjiHost(join(directory, "sessions.db"), () => undefined, dependencies);

  try {
    await host.initialize();
    await host.createAgent(ujiDraft);
    const first = host.send("First request");
    await gate.started;

    const queued = await host.send("Second request");
    assert.equal(queued.running, true);

    gate.release();
    const completed = await first;
    assert.deepEqual(
      completed.messages.map((entry) => messageText(entry.message.content)),
      ["First request", "Handled: First request", "Second request", "Handled: Second request"],
    );
  } finally {
    gate.release();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test("agent settings persist and become the next harness instructions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uji-profile-"));
  const databasePath = join(directory, "sessions.db");
  const prompts = new Map<AgentId, string>();
  const dependencies = deterministicDependencies(prompts);
  const host = new UjiHost(databasePath, () => undefined, dependencies);
  const changes: AgentDraft = {
    name: "Signal",
    role: "Launch editor",
    instructions: "Write one concise launch message using only facts supplied by the user.",
    avatar: "violet",
  };
  let seedId = "";

  try {
    await host.initialize();
    const created = await host.createAgent(ujiDraft);
    assert.ok(created.activeAgentId);
    seedId = created.activeAgentId;
    const updated = await host.updateAgent(seedId, changes);
    assert.deepEqual(
      updated.agents.find((agent) => agent.id === seedId),
      { id: seedId, ...changes },
    );
    await host.send("Ship it");
    assert.equal(prompts.get(seedId), changes.instructions);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT name, role, instructions, avatar FROM demo_agent_profiles WHERE id = ?")
        .get(seedId);
      assert.ok(row);
      assert.deepEqual({ ...row }, changes);
    } finally {
      database.close();
    }
  } finally {
    await host.close();
  }

  const restoredHost = new UjiHost(databasePath, () => undefined, dependencies);
  try {
    const restored = await restoredHost.initialize();
    assert.deepEqual(
      restored.agents.find((agent) => agent.id === seedId),
      { id: seedId, ...changes },
    );
  } finally {
    await restoredHost.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test("agent drafts are parsed at the boundary", () => {
  assert.deepEqual(parseAgentDraft(scoutDraft), scoutDraft);
  const blank = { ...scoutDraft, role: "", instructions: "" };
  assert.deepEqual(parseAgentDraft(blank), blank);
  assert.throws(() => parseAgentDraft({ ...scoutDraft, name: "  " }), /Name is required/);
  assert.throws(() => parseAgentDraft({ ...scoutDraft, avatar: "magenta" }), /avatar color/);
  assert.throws(() => parseAgentDraft(undefined), /Agent details are missing/);
});

function deterministicDependencies(prompts: Map<AgentId, string>): UjiHostDependencies {
  return {
    authStatus: () => Promise.resolve({ signedIn: true, label: "Test provider connected" }),
    login: () => Promise.resolve(),
    createStreamFn: (agentId) => deterministicStream(agentId, prompts),
    model: testModel,
    thinkingLevel: "off",
  };
}

function deterministicStream(agentId: AgentId, prompts: Map<AgentId, string>): StreamFn {
  return (_model, context) => {
    prompts.set(agentId, context.systemPrompt);
    const userMessage = context.messages.findLast((message) => message.role === "user");
    const response = `Handled: ${messageText(userMessage?.content)}`;
    const stream = new DeterministicAssistantStream();
    queueMicrotask(() => finishStream(stream, response));
    return stream;
  };
}

function gatedStream(): { streamFn: StreamFn; started: Promise<void>; release: () => void } {
  let releaseFirst: (() => void) | undefined;
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let call = 0;
  return {
    streamFn: (_model, context) => {
      call += 1;
      const userMessage = context.messages.findLast((message) => message.role === "user");
      const response = `Handled: ${messageText(userMessage?.content)}`;
      const stream = new DeterministicAssistantStream();
      if (call === 1) {
        releaseFirst = () => finishStream(stream, response);
        resolveStarted?.();
      } else {
        queueMicrotask(() => finishStream(stream, response));
      }
      return stream;
    },
    started,
    release: () => {
      releaseFirst?.();
      releaseFirst = undefined;
    },
  };
}

function finishStream(stream: DeterministicAssistantStream, response: string): void {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: response }],
    api: testModel.api,
    provider: testModel.provider,
    model: testModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: message });
  stream.push({ type: "text_start", contentIndex: 0, partial: message });
  stream.push({ type: "text_delta", contentIndex: 0, delta: response, partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: response, partial: message });
  stream.push({ type: "done", reason: "stop", message });
}

function messageText(content: Message["content"] | undefined): string {
  if (typeof content === "string") return content;
  return content?.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
}
