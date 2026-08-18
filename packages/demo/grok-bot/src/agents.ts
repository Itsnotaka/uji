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

export function parseAgentDraft(value: unknown): AgentDraft {
  if (typeof value !== "object" || value === null) throw new Error("Agent details are missing");
  const avatar = "avatar" in value ? value.avatar : undefined;
  if (!isAgentTone(avatar)) throw new Error("Choose an avatar color");
  return {
    name: requiredText("name" in value ? value.name : undefined, "Name", 80),
    role: requiredText("role" in value ? value.role : undefined, "Role", 120),
    instructions: requiredText(
      "instructions" in value ? value.instructions : undefined,
      "Instructions",
      12_000,
    ),
    avatar,
  };
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "") throw new Error(`${label} is required`);
  if (normalized.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}
