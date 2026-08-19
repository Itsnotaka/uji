import { useMutation, useQueryClient } from "@tanstack/react-query";

import { randomAgentTone, type AgentDraft } from "@/agents";
import { applySnapshot } from "@/june-view";
import { strings } from "@/strings";

// Agents are created instantly with defaults and configured afterwards in the
// details panel, mirroring the reference app.
export function blankAgentDraft(): AgentDraft {
  return {
    name: strings.agents.defaultName,
    role: "",
    instructions: "",
    avatar: randomAgentTone(),
  };
}

// Errors surface inline in the create dialog through mutateAsync rejections; this does not
// write the global notice.
export function useCreateAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draft: AgentDraft) => window.june.createAgent(draft),
    onSuccess: (snapshot) => applySnapshot(client, snapshot),
  });
}
