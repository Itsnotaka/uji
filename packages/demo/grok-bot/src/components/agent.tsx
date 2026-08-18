import { Avatar, AvatarFallback } from "@june/ui";
import type { AgentAvatarProps } from "@/view-model";

export function AgentAvatar({ agent, className, size = "md" }: AgentAvatarProps) {
  return (
    <Avatar className={className} shape="rounded" size={size} tone={agent.avatar}>
      <AvatarFallback>{agent.name.trim().charAt(0).toLocaleUpperCase() || "?"}</AvatarFallback>
    </Avatar>
  );
}
