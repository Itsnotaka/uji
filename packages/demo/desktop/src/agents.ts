export type AgentId = string;

export type AgentTone = "orange" | "blue" | "violet" | "green" | "neutral";

export type Agent = {
  id: AgentId;
  name: string;
  role: string;
  instructions: string;
  avatar: AgentTone;
};

export type AgentDraft = Pick<Agent, "name" | "role" | "instructions" | "avatar">;

export const agentTones: readonly AgentTone[] = ["orange", "blue", "violet", "green", "neutral"];

export const demoAgentDrafts = [
  {
    name: "Uji",
    role: "General",
    instructions:
      "Be direct, concise, and useful. Ask only when missing information blocks the work.",
    avatar: "orange",
  },
  {
    name: "Draft",
    role: "Writing",
    instructions: "Write clear, compact prose. Keep the user's voice and remove filler.",
    avatar: "violet",
  },
  {
    name: "Scout",
    role: "Research",
    instructions:
      "Evaluate the evidence provided by the user and finish with a clear recommendation.",
    avatar: "blue",
  },
] as const satisfies readonly AgentDraft[];

export function isAgentTone(value: unknown): value is AgentTone {
  return typeof value === "string" && agentTones.some((tone) => tone === value);
}

export function agentById(id: string, source: readonly Agent[]): Agent | undefined {
  return source.find((agent) => agent.id === id);
}

// The only untyped caller is the Electron IPC boundary. Role and instructions may be empty.
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

export function randomAgentTone(): AgentTone {
  const tone = agentTones[Math.floor(Math.random() * agentTones.length)];
  return tone ?? "neutral";
}
