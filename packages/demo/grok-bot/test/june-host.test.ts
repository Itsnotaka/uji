import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@june/core";
import { agents, type AgentId } from "../src/demo-data.ts";
import type { JuneDesktopEvent } from "../src/desktop-api.ts";
import { JuneHost, type JuneHostDependencies } from "../src/main/june-host.ts";

test("every demo agent runs and restores its own persisted conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "june-agents-"));
  const databasePath = join(directory, "sessions.db");
  const events: JuneDesktopEvent[] = [];
  const prompts = new Map<AgentId, string>();
  const dependencies = deterministicDependencies(prompts);
  const host = new JuneHost(databasePath, (event) => events.push(event), dependencies);

  try {
    const initial = await host.initialize();
    assert.equal(initial.activeAgentId, "june");
    assert.deepEqual(initial.messages, []);

    const targeted = await host.newChat("slacker");
    assert.equal(targeted.activeAgentId, "slacker");
    assert.deepEqual(targeted.messages, []);

    for (const agent of agents) {
      const selected = await host.selectAgent(agent.id);
      assert.equal(selected.activeAgentId, agent.id);
      const fresh = await host.newChat();
      assert.deepEqual(fresh.messages, []);

      const prompt = `A real request for ${agent.name}`;
      const answered = await host.send(prompt);
      assert.equal(answered.activeAgentId, agent.id);
      assert.equal(answered.messages.length, 2);
      assert.equal(messageText(answered.messages[0]?.message.content), prompt);
      assert.equal(
        messageText(answered.messages[1]?.message.content),
        `${agent.name} handled: ${prompt}`,
      );
      assert.equal(answered.agentPreviews[agent.id], `${agent.name} handled: ${prompt}`);
      assert.equal(prompts.get(agent.id), agent.instructions);
    }

    for (const agent of agents) {
      const restored = await host.selectAgent(agent.id);
      assert.equal(restored.activeAgentId, agent.id);
      assert.equal(restored.messages.length, 2);
      assert.equal(
        messageText(restored.messages[1]?.message.content),
        `${agent.name} handled: A real request for ${agent.name}`,
      );
    }

    assert.ok(events.some((event) => event.type === "running" && event.running));
    assert.ok(events.some((event) => event.type === "delta"));
    assert.ok(events.some((event) => event.type === "snapshot"));
  } finally {
    await host.close();
  }

  const restoredHost = new JuneHost(databasePath, () => undefined, dependencies);
  try {
    const resumed = await restoredHost.initialize();
    assert.equal(resumed.activeAgentId, "rawr");
    assert.equal(resumed.messages.length, 2);

    for (const agent of agents) {
      const restored = await restoredHost.selectAgent(agent.id);
      assert.equal(restored.messages.length, 2);
      assert.equal(
        messageText(restored.messages[0]?.message.content),
        `A real request for ${agent.name}`,
      );
    }
  } finally {
    await restoredHost.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the product renderer has no preview-only agent branches", async () => {
  const files = [
    "src/App.tsx",
    "src/components/conversation.tsx",
    "src/components/bot-details.tsx",
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

test("signed-out users can complete login and start any agent", async () => {
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
    await assert.rejects(() => host.send("before login"), /Sign in with ChatGPT first/);
    assert.equal((await host.login()).auth.signedIn, true);
    await host.selectAgent("tweeter");
    const answered = await host.send("Launch note");
    assert.equal(answered.activeAgentId, "tweeter");
    assert.equal(
      messageText(answered.messages[1]?.message.content),
      "Tweeter handled: Launch note",
    );
    assert.ok(
      events.some((event) => event.type === "status" && event.message === "Opening test login…"),
    );
  } finally {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent settings persist and become the next harness instructions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "june-profile-"));
  const databasePath = join(directory, "sessions.db");
  const prompts = new Map<AgentId, string>();
  const dependencies = deterministicDependencies(prompts);
  const host = new JuneHost(databasePath, () => undefined, dependencies);
  const changes = {
    name: "Signal",
    role: "Launch editor",
    instructions: "Write one concise launch message using only facts supplied by the user.",
  };

  try {
    await host.initialize();
    await host.selectAgent("tweeter");
    const updated = await host.updateAgent("tweeter", changes);
    assert.deepEqual(
      updated.agents.find((agent) => agent.id === "tweeter"),
      { id: "tweeter", avatar: "blue", ...changes },
    );
    await host.send("Ship it");
    assert.equal(prompts.get("tweeter"), changes.instructions);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT name, role, instructions FROM demo_agent_profiles WHERE id = ?")
        .get("tweeter");
      assert.deepEqual({ ...row }, changes);
    } finally {
      database.close();
    }
    await assert.rejects(() => access(`${databasePath}.agents.json`));
  } finally {
    await host.close();
  }

  const restoredHost = new JuneHost(databasePath, () => undefined, dependencies);
  try {
    const restored = await restoredHost.initialize();
    assert.deepEqual(
      restored.agents.find((agent) => agent.id === "tweeter"),
      { id: "tweeter", avatar: "blue", ...changes },
    );
  } finally {
    await restoredHost.close();
    await rm(directory, { recursive: true, force: true });
  }
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
    const agent = agents.find((candidate) => candidate.id === agentId);
    assert.ok(agent, "the harness must receive a registered agent prompt");
    prompts.set(agent.id, context.systemPrompt);
    const userMessage = context.messages.findLast((message) => message.role === "user");
    const response = `${agent.name} handled: ${messageText(userMessage?.content)}`;
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

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null || !("text" in part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .join("");
}
