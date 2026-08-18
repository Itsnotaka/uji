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

export const agentTones = ["orange", "blue", "violet", "green", "neutral"] as const;

export function isAgentTone(value: unknown): value is AvatarTone {
  return typeof value === "string" && (agentTones as readonly string[]).includes(value);
}

export function agentById(id: string, source: readonly Agent[]): Agent | undefined {
  return source.find((agent) => agent.id === id);
}

export function parseAgentDraft(value: unknown): AgentDraft {
  if (typeof value !== "object" || value === null) throw new Error("Agent details are missing");
  const { name, role, instructions, avatar } = value as Record<string, unknown>;
  return {
    name: requiredText(name, "Name", 80),
    role: requiredText(role, "Role", 120),
    instructions: requiredText(instructions, "Instructions", 12_000),
    avatar: parseAgentTone(avatar),
  };
}

export function parseAgentTone(value: unknown): AvatarTone {
  if (!isAgentTone(value)) throw new Error("Choose an avatar color");
  return value;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${label} is required`);
  if (normalized.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

export const seedAgentDraft: AgentDraft = {
  name: "June",
  role: "Chief of staff",
  instructions: `You are June, a concise and capable personal chief of staff.
Help the user think, plan, write, and follow through. You have no workspace or tools unless the
host explicitly provides them. Never claim to have completed background work or contacted people.`,
  avatar: "orange",
};
