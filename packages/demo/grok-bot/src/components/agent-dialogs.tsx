import { useState, type FormEvent, type ReactElement } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
  Avatar,
  AvatarFallback,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
  Input,
  Textarea,
  cn,
} from "@june/ui";
import { agentTones, type Agent, type AgentDraft } from "@/agents";
import { useCreateAgent } from "@/hooks/use-create-agent";
import { useDeleteAgent } from "@/hooks/use-delete-agent";
import { strings } from "@/strings";

export type AgentCreateDialogProps = {
  trigger: ReactElement;
};

export function AgentCreateDialog({ trigger }: AgentCreateDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogTitle>{strings.createDialog.title}</DialogTitle>
        <DialogDescription>{strings.createDialog.description}</DialogDescription>
        <CreateAgentForm onCreated={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CreateAgentForm({ onCreated }: { onCreated: () => void }) {
  const createAgent = useCreateAgent();
  const [draft, setDraft] = useState<AgentDraft>({
    name: "",
    role: "",
    instructions: "",
    avatar: "orange",
  });
  const [status, setStatus] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createAgent.isPending) return;
    setStatus(undefined);
    try {
      await createAgent.mutateAsync(draft);
      onCreated();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }
  const submitting = createAgent.isPending;

  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
      <label className="grid gap-1.5 text-detail font-medium" htmlFor="new-agent-name">
        {strings.agentForm.nameLabel}
        <Input
          autoComplete="off"
          autoFocus
          id="new-agent-name"
          maxLength={80}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder={strings.agentForm.namePlaceholder}
          required
          spellCheck={false}
          value={draft.name}
        />
      </label>
      <label className="grid gap-1.5 text-detail font-medium" htmlFor="new-agent-role">
        {strings.agentForm.roleLabel}
        <Input
          autoComplete="off"
          id="new-agent-role"
          maxLength={120}
          onChange={(event) => setDraft({ ...draft, role: event.target.value })}
          placeholder={strings.agentForm.rolePlaceholder}
          required
          spellCheck={false}
          value={draft.role}
        />
      </label>
      <label className="grid gap-1.5 text-detail font-medium" htmlFor="new-agent-instructions">
        {strings.agentForm.instructionsLabel}
        <Textarea
          id="new-agent-instructions"
          maxLength={12_000}
          onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
          placeholder={strings.agentForm.instructionsPlaceholder}
          required
          rows={5}
          value={draft.instructions}
        />
      </label>
      <fieldset className="grid gap-1.5 text-detail font-medium">
        <legend>{strings.agentForm.toneLabel}</legend>
        <div className="flex gap-2">
          {agentTones.map((tone) => (
            <button
              aria-label={tone}
              aria-pressed={draft.avatar === tone}
              className={cn(
                "rounded-full",
                draft.avatar === tone && "outline-2 outline-offset-2 outline-ring",
              )}
              key={tone}
              onClick={() => setDraft({ ...draft, avatar: tone })}
              type="button"
            >
              <Avatar size="sm" tone={tone}>
                <AvatarFallback>{draft.name.trim().charAt(0).toUpperCase()}</AvatarFallback>
              </Avatar>
            </button>
          ))}
        </div>
      </fieldset>
      <DialogFooter>
        {status && (
          <span className="mr-auto text-detail text-destructive" role="status">
            {status}
          </span>
        )}
        <Button disabled={submitting} type="submit">
          {submitting ? strings.createDialog.submitting : strings.createDialog.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

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
        <span className="mr-auto text-detail text-destructive" role="status">
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
