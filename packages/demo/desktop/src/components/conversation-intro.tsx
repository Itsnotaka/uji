import { IconArrowUp } from "central-icons";

import type { Agent } from "../agents.ts";
import { AgentAvatar } from "./agent-avatar.tsx";

const WRITING_PROMPTS = [
  "Cut this paragraph in half without losing the point.",
  "Draft a release note for a fix that stops duplicate emails.",
  "Give me three titles for a post about slow builds.",
  "Rewrite my last message so it sounds less defensive.",
] as const;

const RESEARCH_PROMPTS = [
  "Compare SQLite and Postgres for a single-user desktop app.",
  "What breaks first when a chat app keeps every message in context?",
  "List the tradeoffs of streaming tokens over IPC.",
  "Give me a reading plan on retrieval for local apps.",
] as const;

const GENERAL_PROMPTS = [
  "Explain what happens between my keystroke and your first token.",
  "Think out loud through this: three switches, one bulb, one trip.",
  "Write a long answer so I can watch the text stream in.",
  "Plan my next two hours around one deep-work block.",
] as const;

export function ConversationIntro({
  agent,
  onPrompt,
  ready,
}: {
  agent: Agent;
  onPrompt: (prompt: string) => void;
  ready: boolean;
}) {
  return (
    <div className="conversation-intro">
      <AgentAvatar agent={agent} size="lg" />
      <h1>{agent.name}</h1>
      <p>{agent.role === "" ? "No role set yet." : agent.role}</p>

      <div className="starter-grid">
        {starterPrompts(agent).map((prompt) => (
          <button
            className="starter-chip"
            disabled={!ready}
            key={prompt}
            onClick={() => onPrompt(prompt)}
            type="button"
          >
            <span>{prompt}</span>
            <IconArrowUp aria-hidden="true" size={12} />
          </button>
        ))}
      </div>

      <p className="intro-hint">
        Enter sends. Shift+Enter adds a line. ⌘K searches chats, ⌘N starts a new one.
      </p>
    </div>
  );
}

function starterPrompts(agent: Agent): readonly string[] {
  const profile = `${agent.role} ${agent.instructions}`.toLocaleLowerCase();
  if (/writ|draft|edit|prose|copy/.test(profile)) return WRITING_PROMPTS;
  if (/research|evidence|analy|scout|source/.test(profile)) return RESEARCH_PROMPTS;
  return GENERAL_PROMPTS;
}
