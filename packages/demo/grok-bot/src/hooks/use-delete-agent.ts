import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { AgentId } from "@/agents";
import { applySnapshot } from "@/june-view";

// Errors surface inline in the delete confirmation through mutateAsync rejections; this does
// not write the global notice.
export function useDeleteAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agentId: AgentId) => window.june.deleteAgent(agentId),
    onSuccess: (snapshot) => applySnapshot(client, snapshot),
  });
}
