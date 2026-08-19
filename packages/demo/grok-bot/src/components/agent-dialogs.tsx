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
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Textarea,
} from "@june/ui";
import { agentTones, type Agent, type AgentDraft } from "@/agents";
import { useCreateAgent } from "@/hooks/use-create-agent";
import { useDeleteAgent } from "@/hooks/use-delete-agent";
import { strings } from "@/strings";

const fieldStyle = "grid gap-2";
const labelStyle = "text-detail font-medium text-muted-foreground";

export type AgentCreateDialogProps = {
  trigger: ReactElement;
};

export function AgentCreateDialog({ trigger }: AgentCreateDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{strings.createDialog.title}</DialogTitle>
          <DialogDescription>{strings.createDialog.description}</DialogDescription>
        </DialogHeader>
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
  const submitting = createAgent.isPending;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setStatus(undefined);
    try {
      await createAgent.mutateAsync(draft);
      onCreated();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <form className="grid gap-5" onSubmit={(event) => void submit(event)}>
      <div className={fieldStyle}>
        <label className={labelStyle} htmlFor="new-agent-name">
          {strings.agentForm.nameLabel}
        </label>
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
      </div>

      <div className={fieldStyle}>
        <label className={labelStyle} htmlFor="new-agent-role">
          {strings.agentForm.roleLabel}
        </label>
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
      </div>

      <div className={fieldStyle}>
        <label className={labelStyle} htmlFor="new-agent-instructions">
          {strings.agentForm.instructionsLabel}
        </label>
        <Textarea
          aria-describedby="new-agent-instructions-hint"
          id="new-agent-instructions"
          maxLength={12_000}
          onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
          required
          rows={5}
          value={draft.instructions}
        />
        <span className="text-detail text-muted-foreground" id="new-agent-instructions-hint">
          {strings.agentForm.instructionsPlaceholder}
        </span>
      </div>

      <TonePicker
        initial={draft.name.trim().charAt(0).toLocaleUpperCase()}
        onChange={(avatar) => setDraft({ ...draft, avatar })}
        value={draft.avatar}
      />

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

type TonePickerProps = {
  initial: string;
  value: AgentDraft["avatar"];
  onChange: (tone: AgentDraft["avatar"]) => void;
};

// Native radios rather than buttons: arrow-key roving, the group name, and the
// checked state all come from the platform instead of aria-pressed bookkeeping.
function TonePicker({ initial, value, onChange }: TonePickerProps) {
  return (
    // A legend is not a flow child of its fieldset, so a container gap never reaches it.
    // The label spacing has to be the legend's own margin.
    <fieldset>
      <legend className={`${labelStyle} mb-2`}>{strings.agentForm.toneLabel}</legend>
      <div className="flex gap-3">
        {agentTones.map((tone) => (
          <label
            className="grid cursor-default place-items-center rounded-xl outline-offset-2 outline-foreground has-[:checked]:outline-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
            key={tone}
          >
            <input
              checked={value === tone}
              className="sr-only"
              name="new-agent-tone"
              onChange={() => onChange(tone)}
              type="radio"
              value={tone}
            />
            <Avatar shape="rounded" tone={tone}>
              <AvatarFallback>{initial}</AvatarFallback>
            </Avatar>
            <span className="sr-only">{tone}</span>
          </label>
        ))}
      </div>
    </fieldset>
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
      <Button onClick={onCancel} variant="outline">
        {strings.deleteDialog.cancel}
      </Button>
      <Button disabled={deleting} onClick={() => void confirm()} variant="destructive">
        {strings.deleteDialog.confirm}
      </Button>
    </AlertDialogFooter>
  );
}
