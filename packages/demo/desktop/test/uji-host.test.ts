import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type Model,
} from "@uji-ai/ai";
import type { StreamFn, Turn } from "@uji-ai/core";
import { demoAgentDrafts, parseAgentDraft, type AgentDraft } from "../src/agents.ts";
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

const reasoningModel: Model<"openai-responses"> = {
  ...testModel,
  id: "reasoning-model",
  name: "Reasoning Model",
  reasoning: true,
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
  const prompts: string[] = [];
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

    await host.send("A real request");
    const answered = await waitForTranscript(host, 2);
    assert.deepEqual(transcriptText(answered.messages), [
      "A real request",
      "Handled: A real request",
    ]);
    assert.equal(prompts.at(-1)?.trim(), seed.instructions);

    const created = await host.createAgent(scoutDraft);
    assert.equal(created.agents.length, 2);
    assert.ok(created.activeAgentId);
    assert.notEqual(created.activeAgentId, seedId);
    assert.deepEqual(created.messages, []);
    scoutId = created.activeAgentId;

    await host.send("Scout request");
    const scoutAnswered = await waitForTranscript(host, 2);
    assert.equal(transcriptText(scoutAnswered.messages).length, 2);
    assert.equal(prompts.at(-1)?.trim(), scoutDraft.instructions);

    const restored = await host.selectAgent(seedId);
    assert.equal(transcriptText(restored.messages).length, 2);
    assert.equal(transcriptText(restored.messages)[0], "A real request");

    assert.ok(
      events.some((event) => event.type === "session" && event.event.kind === "run_started"),
    );
    assert.ok(
      events.some((event) => event.type === "session" && event.event.kind === "text_delta"),
    );
    const delta = events.find(
      (event) => event.type === "session" && event.event.kind === "text_delta",
    );
    assert.equal(delta?.type === "session" ? delta.event.contentIndex : undefined, 0);
    assert.ok(events.some((event) => event.type === "snapshot"));
    assert.ok(
      events.every(
        (event) =>
          event.type === "status" ||
          event.type === "snapshot" ||
          event.type === "error" ||
          event.sessionId !== "",
      ),
    );
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
    assert.equal(transcriptText(reselected.messages).length, 2);
  } finally {
    await restoredHost.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test("initial agents are seeded once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uji-initial-agents-"));
  const databasePath = join(directory, "sessions.db");
  const dependencies = deterministicDependencies([]);
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
  const dependencies = deterministicDependencies([]);
  const host = new UjiHost(databasePath, () => undefined, dependencies);
  let seedId = "";

  try {
    await host.initialize();
    const seeded = await host.createAgent(ujiDraft);
    assert.ok(seeded.activeAgentId);
    seedId = seeded.activeAgentId;
    await host.send("Keep this");
    await waitForTranscript(host, 2);

    const created = await host.createAgent(scoutDraft);
    assert.ok(created.activeAgentId);
    const scoutId = created.activeAgentId;
    await host.send("Scoped to Scout");
    await waitForTranscript(host, 2);

    const afterScoutDelete = await host.deleteAgent(scoutId);
    assert.equal(afterScoutDelete.agents.length, 1);
    assert.equal(afterScoutDelete.activeAgentId, seedId);
    assert.equal(transcriptText(afterScoutDelete.messages).length, 2);

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

void test("signed-out users can complete login and message an agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uji-login-"));
  let signedIn = false;
  const events: UjiDesktopEvent[] = [];
  const dependencies = deterministicDependencies([]);
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
    await host.send("Launch note");
    const answered = await waitForTranscript(host, 2);
    assert.equal(transcriptText(answered.messages)[1], "Handled: Launch note");
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
  const dependencies = deterministicDependencies([]);
  dependencies.streamFn = gate.streamFn;
  const host = new UjiHost(join(directory, "sessions.db"), () => undefined, dependencies);

  try {
    await host.initialize();
    await host.createAgent(ujiDraft);
    await host.send("First request");
    await gate.started;

    const queued = await host.send("Second request");
    assert.equal(queued.running, true);
    assert.equal(queued.pending.length, 1);

    gate.release();
    const completed = await waitForTranscript(host, 4);
    assert.deepEqual(completed.pending, []);
    assert.deepEqual(transcriptText(completed.messages), [
      "First request",
      "Handled: First request",
      "Second request",
      "Handled: Second request",
    ]);
  } finally {
    gate.release();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test("running conversations survive navigation and keep their own status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uji-background-navigation-"));
  const gate = gatedStream();
  const events: UjiDesktopEvent[] = [];
  const dependencies = deterministicDependencies([]);
  dependencies.streamFn = gate.streamFn;
  const host = new UjiHost(
    join(directory, "sessions.db"),
    (event) => events.push(event),
    dependencies,
  );

  try {
    await host.initialize();
    await host.createAgent(ujiDraft);
    await host.send("Background request");
    await gate.started;
    const background = await host.initialize();
    assert.ok(background.activeSessionId);
    const backgroundSessionId = background.activeSessionId;
    assert.equal(background.running, true);

    const newChat = await host.newChat();
    assert.ok(newChat.activeSessionId);
    const foregroundSessionId = newChat.activeSessionId;
    assert.notEqual(foregroundSessionId, backgroundSessionId);
    assert.equal(newChat.running, false);
    assert.equal(
      newChat.conversations.find((conversation) => conversation.id === backgroundSessionId)
        ?.running,
      true,
    );

    await host.send("Foreground request");
    const foreground = await waitForTranscript(host, 2);
    assert.deepEqual(transcriptText(foreground.messages), [
      "Foreground request",
      "Handled: Foreground request",
    ]);
    assert.equal(
      foreground.conversations.find((conversation) => conversation.id === backgroundSessionId)
        ?.running,
      true,
    );

    const reselected = await host.selectConversation(backgroundSessionId);
    assert.equal(reselected.running, true);
    gate.release();
    const completed = await waitForTranscript(host, 2);
    assert.deepEqual(transcriptText(completed.messages), [
      "Background request",
      "Handled: Background request",
    ]);
    assert.equal(
      completed.conversations.find((conversation) => conversation.id === backgroundSessionId)
        ?.running,
      false,
    );

    const restoredForeground = await host.selectConversation(foregroundSessionId);
    assert.equal(transcriptText(restoredForeground.messages)[0], "Foreground request");
    assert.ok(
      events.some(
        (event) =>
          event.type === "session" &&
          event.event.kind === "run_finished" &&
          event.sessionId === backgroundSessionId,
      ),
    );
  } finally {
    gate.release();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test("agent settings persist and become the next run instructions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uji-profile-"));
  const databasePath = join(directory, "sessions.db");
  const prompts: string[] = [];
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
    await waitForTranscript(host, 2);
    assert.equal(prompts.at(-1)?.trim(), changes.instructions);
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

void test("conversations can be listed, renamed, and selected by session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uji-conversations-"));
  const host = new UjiHost(
    join(directory, "sessions.db"),
    () => undefined,
    deterministicDependencies([]),
  );

  try {
    await host.initialize();
    const created = await host.createAgent(ujiDraft);
    assert.ok(created.activeAgentId);

    await host.newChat(created.activeAgentId);
    await host.send("First thread");
    const first = await waitForTranscript(host, 2);
    assert.ok(first.activeSessionId);
    const firstSessionId = first.activeSessionId;

    await host.newChat(created.activeAgentId);
    await host.send("Second thread");
    const second = await waitForTranscript(host, 2);
    assert.ok(second.activeSessionId);
    assert.notEqual(second.activeSessionId, firstSessionId);
    assert.equal(second.conversations.length, 2);

    const renamed = await host.renameConversation(firstSessionId, "Launch plan");
    assert.equal(
      renamed.conversations.find((conversation) => conversation.id === firstSessionId)?.name,
      "Launch plan",
    );
    const selected = await host.selectConversation(firstSessionId);
    assert.equal(selected.activeSessionId, firstSessionId);
    assert.equal(transcriptText(selected.messages)[0], "First thread");
  } finally {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test("an untouched chat is neither listed nor duplicated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uji-empty-chats-"));
  const host = new UjiHost(
    join(directory, "sessions.db"),
    () => undefined,
    deterministicDependencies([]),
  );

  try {
    await host.initialize();
    const created = await host.createAgent(ujiDraft);
    assert.ok(created.activeAgentId);
    const agentId = created.activeAgentId;

    const blank = await host.newChat(agentId);
    assert.ok(blank.activeSessionId);
    assert.deepEqual(blank.conversations, []);

    // Pressing new chat again keeps the same untouched session.
    const again = await host.newChat(agentId);
    assert.equal(again.activeSessionId, blank.activeSessionId);
    assert.deepEqual(again.conversations, []);

    await host.send("Now it is a chat");
    const used = await waitForTranscript(host, 2);
    assert.equal(used.conversations.length, 1);
    assert.equal(used.conversations[0]?.id, blank.activeSessionId);

    const next = await host.newChat(agentId);
    assert.notEqual(next.activeSessionId, blank.activeSessionId);
    assert.equal(next.conversations.length, 1);
  } finally {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test("runtime model and reasoning settings persist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uji-runtime-settings-"));
  const databasePath = join(directory, "sessions.db");
  const dependencies = deterministicDependencies([]);
  // Optional catalog entries augment rather than replace the required fallback model.
  dependencies.models = [reasoningModel];

  const host = new UjiHost(databasePath, () => undefined, dependencies);
  try {
    const initial = await host.initialize();
    assert.equal(initial.runtime.modelKey, "test/test-model");
    const selected = await host.updateRuntimeSettings({
      kind: "model",
      modelKey: "test/reasoning-model",
    });
    assert.equal(selected.runtime.modelKey, "test/reasoning-model");
    const reasoned = await host.updateRuntimeSettings({ kind: "thinking", thinkingLevel: "high" });
    assert.equal(reasoned.runtime.thinkingLevel, "high");
  } finally {
    await host.close();
  }

  const restored = new UjiHost(databasePath, () => undefined, dependencies);
  try {
    const snapshot = await restored.initialize();
    assert.equal(snapshot.runtime.modelKey, "test/reasoning-model");
    assert.equal(snapshot.runtime.thinkingLevel, "high");
  } finally {
    await restored.close();
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

function deterministicDependencies(prompts: string[]): UjiHostDependencies {
  return {
    authStatus: () => Promise.resolve({ signedIn: true, label: "Test provider connected" }),
    login: () => Promise.resolve(),
    streamFn: deterministicStream(prompts),
    model: testModel,
    thinkingLevel: "off",
  };
}

function deterministicStream(prompts: string[]): StreamFn {
  return (_model, context) => {
    prompts.push(context.systemPrompt);
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

function transcriptText(turns: readonly Turn[]): string[] {
  const text: string[] = [];
  for (const turn of turns) {
    switch (turn.kind) {
      case "turn":
        for (const part of turn.parts) {
          switch (part.kind) {
            case "user":
              text.push(messageText(part.content));
              break;
            case "assistant":
              text.push(part.text);
              break;
            case "thinking":
            case "tool":
            case "note":
              break;
            default: {
              const _exhaustive: never = part;
              return _exhaustive;
            }
          }
        }
        break;
      case "compaction":
      case "branch_summary":
      case "model_change":
      case "custom":
        break;
      default: {
        const _exhaustive: never = turn;
        return _exhaustive;
      }
    }
  }
  return text;
}

async function waitForTranscript(
  host: UjiHost,
  expectedParts: number,
): Promise<Awaited<ReturnType<UjiHost["initialize"]>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await host.initialize();
    if (transcriptText(snapshot.messages).length >= expectedParts && !snapshot.running)
      return snapshot;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Transcript did not reach ${expectedParts} visible parts`);
}

function messageText(content: Message["content"] | undefined): string {
  if (typeof content === "string") return content;
  return content?.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
}
