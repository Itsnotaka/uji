import type { AvatarTone } from "@june/ui";

export type AgentId = string;

export type Agent = {
  id: AgentId;
  name: string;
  role: string;
  instructions: string;
  avatar: AvatarTone;
};

export type AgentDraft = Pick<Agent, "name" | "role" | "instructions" | "avatar">;

export const agentTones: readonly AvatarTone[] = ["orange", "blue", "violet", "green", "neutral"];

export function isAgentTone(value: unknown): value is AvatarTone {
  return typeof value === "string" && agentTones.some((tone) => tone === value);
}

export function agentById(id: string, source: readonly Agent[]): Agent | undefined {
  return source.find((agent) => agent.id === id);
}

// The only untyped caller is the Electron IPC boundary; the renderer always sends a typed
// AgentDraft. Role and instructions may be empty: agents are created instantly and
// configured later.
export function parseAgentDraft(value: unknown): AgentDraft {
  if (typeof value !== "object" || value === null) throw new Error("Agent details are missing");
  const name = "name" in value ? value.name : undefined;
  const role = "role" in value ? value.role : undefined;
  const instructions = "instructions" in value ? value.instructions : undefined;
  const avatar = "avatar" in value ? value.avatar : undefined;
  if (typeof name !== "string" || name.trim() === "") throw new Error("Name is required");
  if (typeof role !== "string" || typeof instructions !== "string") {
    throw new Error("Agent details are missing");
  }
  if (!isAgentTone(avatar)) throw new Error("Choose an avatar color");
  return { name, role, instructions, avatar };
}

export function randomAgentTone(): AvatarTone {
  const tone = agentTones[Math.floor(Math.random() * agentTones.length)];
  return tone ?? "neutral";
}
