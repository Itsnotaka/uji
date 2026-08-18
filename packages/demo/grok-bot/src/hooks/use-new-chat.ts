import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { AgentId } from "@/agents";
import { applySnapshot, errorMessage, setNotice } from "@/june-view";

export function useNewChat() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agentId: AgentId) => window.june.newChat(agentId),
    onMutate: () => setNotice(client, undefined),
    onSuccess: (snapshot) => applySnapshot(client, snapshot),
    onError: (error) => setNotice(client, errorMessage(error)),
  });
}
