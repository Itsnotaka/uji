import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@june/core";
import { parseAgentDraft, type AgentDraft, type AgentId } from "../src/agents.ts";
import type { JuneDesktopEvent } from "../src/desktop-api.ts";
import { JuneHost, type JuneHostDependencies } from "../src/main/june-host.ts";

const juneDraft: AgentDraft = {
  name: "June",
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

void test("starts empty and persists user-created agents and their conversations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "june-agents-"));
  const databasePath = join(directory, "sessions.db");
  const events: JuneDesktopEvent[] = [];
  const prompts = new Map<AgentId, string>();
  const dependencies = deterministicDependencies(prompts);
  const host = new JuneHost(databasePath, (event) => events.push(event), dependencies);
  let seedId = "";
  let scoutId = "";

  try {
    const initial = await host.initialize();
    assert.deepEqual(initial.agents, []);
    assert.equal(initial.activeAgentId, null);
    assert.deepEqual(initial.messages, []);
    await assert.rejects(() => host.send("no agent yet"), /Create an agent first/);

    const first = await host.createAgent(juneDraft);
    assert.equal(first.agents.length, 1);
    const seed = first.agents[0];
    assert.ok(seed);
    assert.equal(seed.name, "June");
    assert.equal(seed.avatar, "orange");
    assert.equal(first.activeAgentId, seed.id);
    seedId = seed.id;

    const answered = await host.send("A real request");
    assert.equal(answered.messages.length, 2);
    assert.equal(messageText(answered.messages[1]?.message.content), "Handled: A real request");
    assert.equal(answered.agentPreviews[seedId], "Handled: A real request");
    assert.equal(prompts.get(seedId), seed.instructions);

    const created = await host.createAgent(scoutDraft);
    assert.equal(created.agents.length, 2);
    assert.ok(created.activeAgentId);
    assert.notEqual(created.activeAgentId, seedId);
    assert.deepEqual(created.messages, []);
    scoutId = created.activeAgentId;
    assert.equal(created.agentPreviews[scoutId], "");

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

  const restoredHost = new JuneHost(databasePath, () => undefined, dependencies);
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

void test("deleted agents stay deleted and their conversations disappear", async () => {
  const directory = await mkdtemp(join(tmpdir(), "june-delete-"));
  const databasePath = join(directory, "sessions.db");
  const dependencies = deterministicDependencies(new Map());
  const host = new JuneHost(databasePath, () => undefined, dependencies);
  let seedId = "";

  try {
    await host.initialize();
    const seeded = await host.createAgent(juneDraft);
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
    assert.equal(afterScoutDelete.agentPreviews[scoutId], undefined);
    assert.equal(afterScoutDelete.messages.length, 2);

    const afterSeedDelete = await host.deleteAgent(seedId);
    assert.equal(afterSeedDelete.agents.length, 0);
    assert.equal(afterSeedDelete.activeAgentId, null);
    assert.deepEqual(afterSeedDelete.messages, []);
  } finally {
    await host.close();
  }

  const restoredHost = new JuneHost(databasePath, () => undefined, dependencies);
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

void test("the product renderer has no preview-only agent branches", async () => {
  const files = [
    "src/App.tsx",
    "src/components/conversation.tsx",
    "src/components/bot-details.tsx",
    "src/components/search-palette.tsx",
    "src/components/sidebar.tsx",
  ];
  const source = (
    await Promise.all(files.map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")))
  ).join("\n");
  assert.doesNotMatch(source, /Preview only|Preview conversation|product preview|not connected\./);
  assert.doesNotMatch(source, /uppercase|What are we working on|size="lg"/);
  assert.match(source, /<Textarea/);
  assert.match(source, /<ContextMenu/);
  assert.match(source, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(source, /<IconBox glyphSize=\{12\}>/);
  assert.doesNotMatch(source, /Icon(?:PlusMedium|SidebarHiddenRightWide) size=/);
});

void test("signed-out users can complete login and message an agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "june-login-"));
  let signedIn = false;
  const events: JuneDesktopEvent[] = [];
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
  const host = new JuneHost(
    join(directory, "sessions.db"),
    (event) => events.push(event),
    dependencies,
  );

  try {
    assert.equal((await host.initialize()).auth.signedIn, false);
    await host.createAgent(juneDraft);
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

void test("agent settings persist and become the next harness instructions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "june-profile-"));
  const databasePath = join(directory, "sessions.db");
  const prompts = new Map<AgentId, string>();
  const dependencies = deterministicDependencies(prompts);
  const host = new JuneHost(databasePath, () => undefined, dependencies);
  const changes: AgentDraft = {
    name: "Signal",
    role: "Launch editor",
    instructions: "Write one concise launch message using only facts supplied by the user.",
    avatar: "violet",
  };
  let seedId = "";

  try {
    await host.initialize();
    const created = await host.createAgent(juneDraft);
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

  const restoredHost = new JuneHost(databasePath, () => undefined, dependencies);
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
  assert.deepEqual(parseAgentDraft({ ...scoutDraft, name: "  Scout  " }), scoutDraft);
  assert.throws(() => parseAgentDraft({ ...scoutDraft, name: "  " }), /Name is required/);
  assert.throws(() => parseAgentDraft({ ...scoutDraft, avatar: "magenta" }), /avatar color/);
  assert.throws(() => parseAgentDraft(undefined), /Agent details are missing/);
  assert.throws(() => parseAgentDraft({ ...scoutDraft, name: "n".repeat(81) }), /80 characters/);
});

function deterministicDependencies(prompts: Map<AgentId, string>): JuneHostDependencies {
  return {
    authStatus: () => Promise.resolve({ signedIn: true, label: "Test provider connected" }),
    login: () => Promise.resolve(),
    createStreamFn: (_sessionId, agentId) => deterministicStream(agentId, prompts),
    model: "test-model",
    thinkingLevel: "off",
  };
}

function deterministicStream(agentId: AgentId, prompts: Map<AgentId, string>): StreamFn {
  return async (context, options) => {
    prompts.set(agentId, context.systemPrompt);
    const userMessage = context.messages.findLast((message) => message.role === "user");
    const response = `Handled: ${messageText(userMessage?.content)}`;
    options.onDelta?.({ kind: "text", text: response });
    return {
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: response }],
        },
      ],
      stopReason: "stop",
    };
  };
}

function messageText(content: string | { text?: string }[] | undefined): string {
  if (typeof content === "string") return content;
  return content?.map((part) => part.text ?? "").join("") ?? "";
}
