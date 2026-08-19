import { useState, type ReactElement } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
} from "@june/ui";
import type { Agent } from "@/agents";
import { useDeleteAgent } from "@/hooks/use-delete-agent";
import { strings } from "@/strings";

export type AgentDeleteDialogProps = {
  agent: Agent;
  trigger: ReactElement;
  onDeleted?: () => void;
};

export function AgentDeleteDialog({ agent, trigger, onDeleted }: AgentDeleteDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={trigger} />
      <AlertDialogContent>
        <AlertDialogTitle>{strings.deleteDialog.title(agent.name)}</AlertDialogTitle>
        <AlertDialogDescription>{strings.deleteDialog.body}</AlertDialogDescription>
        <DeleteAgentActions
          agent={agent}
          onCancel={() => setOpen(false)}
          onDeleted={() => {
            setOpen(false);
            onDeleted?.();
          }}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteAgentActions({
  agent,
  onCancel,
  onDeleted,
}: {
  agent: Agent;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const deleteAgent = useDeleteAgent();
  const [status, setStatus] = useState<string>();
  const deleting = deleteAgent.isPending;

  async function confirm() {
    if (deleting) return;
    setStatus(undefined);
    try {
      await deleteAgent.mutateAsync(agent.id);
      onDeleted();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <AlertDialogFooter>
      {status && (
        <span className="text-detail text-destructive mr-auto" role="status">
          {status}
        </span>
      )}
      <Button onClick={onCancel} variant="ghost">
        {strings.deleteDialog.cancel}
      </Button>
      <Button disabled={deleting} onClick={() => void confirm()} variant="destructive">
        {strings.deleteDialog.confirm}
      </Button>
    </AlertDialogFooter>
  );
}
