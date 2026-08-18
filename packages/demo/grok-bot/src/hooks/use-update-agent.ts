import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { AgentDraft, AgentId } from "@/agents";
import { applySnapshot } from "@/june-view";

// Errors surface inline in the details panel through mutateAsync rejections; this does not
// write the global notice.
export function useUpdateAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentId: AgentId; changes: AgentDraft }) =>
      window.june.updateAgent(input.agentId, input.changes),
    onSuccess: (snapshot) => applySnapshot(client, snapshot),
  });
}
