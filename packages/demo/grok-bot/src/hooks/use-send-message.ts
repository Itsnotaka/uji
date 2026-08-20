import { useMutation, useQueryClient } from "@tanstack/react-query";

import { applySnapshot, errorMessage, juneViewKey, setNotice, updateView } from "@/june-view";

export function useSendMessage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => window.june.send(text),
    onMutate: (text) => {
      setNotice(client, undefined);
      updateView(client, (view) => {
        if (view.activeAgentId === null) return view;
        return {
          ...view,
          messages: [
            ...view.messages,
            {
              type: "message",
              id: `${view.activeAgentId}-${Date.now()}`,
              seq: Number.MAX_SAFE_INTEGER,
              parentId: null,
              timestamp: Date.now(),
              message: { role: "user", content: text, timestamp: Date.now() },
            },
          ],
          agentPreviews: { ...view.agentPreviews, [view.activeAgentId]: text },
        };
      });
    },
    onSuccess: (snapshot) => applySnapshot(client, snapshot),
    onError: async (error) => {
      setNotice(client, errorMessage(error));
      await client.invalidateQueries({ queryKey: juneViewKey });
    },
  });
}
