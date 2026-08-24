import { Avatar, AvatarFallback } from "@uji-ai/ui";

import type { Agent } from "../agents.ts";

export function AgentAvatar({
  agent,
  size = "md",
}: {
  agent: Pick<Agent, "avatar" | "name">;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  return (
    <Avatar shape="rounded" size={size} tone={agent.avatar}>
      <AvatarFallback>{agent.name.trim().charAt(0).toLocaleUpperCase() || "?"}</AvatarFallback>
    </Avatar>
  );
}
