import { Avatar, AvatarFallback, type AvatarSize } from "@june/ui";
import type { Agent } from "@/agents";

export type AgentAvatarProps = {
  agent: Agent;
  className?: string;
  size?: AvatarSize;
};

export function AgentAvatar({ agent, className, size = "md" }: AgentAvatarProps) {
  return (
    <Avatar className={className} shape="rounded" size={size} tone={agent.avatar}>
      <AvatarFallback>{agent.name.trim().charAt(0).toLocaleUpperCase() || "?"}</AvatarFallback>
    </Avatar>
  );
}
