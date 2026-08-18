import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { AgentDraft } from "@/agents";
import { applySnapshot } from "@/june-view";

// Errors surface inline in the create dialog through mutateAsync rejections; this does not
// write the global notice.
export function useCreateAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draft: AgentDraft) => window.june.createAgent(draft),
    onSuccess: (snapshot) => applySnapshot(client, snapshot),
  });
}
