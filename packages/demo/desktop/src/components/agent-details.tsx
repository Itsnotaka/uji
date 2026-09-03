import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
} from "@uji-ai/ui";
import { IconClipboard, IconCrossSmall, IconTrashCan } from "central-icons";
import { useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";

import {
  agentTones,
  randomAgentTone,
  type Agent,
  type AgentDraft,
  type AgentTone,
} from "../agents.ts";
import type { ConversationSummary, UjiSnapshot } from "../desktop-api.ts";
import { AgentAvatar } from "./agent-avatar.tsx";

export function AgentDetails({
  agent,
  conversation,
  onClose,
  onDelete,
  onRenameConversation,
  onResize,
  onSave,
  pending,
  snapshot,
  width,
}: {
  agent: Agent;
  conversation?: ConversationSummary;
  onClose: () => void;
  onDelete: () => void;
  onRenameConversation: (name: string) => void;
  onResize: (width: number) => void;
  onSave: (draft: AgentDraft) => void;
  pending: boolean;
  snapshot: UjiSnapshot;
  width: number;
}) {
  const [draft, setDraft] = useState<AgentDraft>(draftFrom(agent));
  const [conversationName, setConversationName] = useState(
    conversation?.name ?? conversation?.preview ?? "New chat",
  );
  const [copied, setCopied] = useState(false);

  function saveDraft(next: AgentDraft): void {
    const normalized = { ...next, name: next.name.trim() };
    if (normalized.name === "") {
      setDraft(draftFrom(agent));
      return;
    }
    setDraft(normalized);
    if (!sameDraft(normalized, draftFrom(agent))) onSave(normalized);
  }

  function copySessionId(): void {
    const id = snapshot.activeSessionId;
    if (id === null) return;
    void navigator.clipboard
      .writeText(id)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_600);
      })
      .catch(() => undefined);
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const stage = event.currentTarget.closest<HTMLElement>(".workspace-stage");
    const maximum = Math.min(
      480,
      Math.max(280, (stage?.getBoundingClientRect().width ?? window.innerWidth) - 424),
    );
    const startX = event.clientX;
    const startWidth = width;
    let latestWidth = width;
    const move = (moveEvent: PointerEvent): void => {
      latestWidth = Math.min(maximum, Math.max(0, startWidth + startX - moveEvent.clientX));
      onResize(latestWidth);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      if (latestWidth < 244) {
        onResize(280);
        onClose();
      } else if (latestWidth < 280) onResize(280);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  return (
    <aside aria-label="Agent details" className="agent-details" style={{ width }}>
      <div aria-hidden="true" className="details-resize-handle" onPointerDown={beginResize} />
      <header className="details-header">
        <span aria-hidden="true" />
        <button
          aria-label="Close agent details"
          className="icon-button"
          onClick={onClose}
          type="button"
        >
          <IconCrossSmall size={13} />
        </button>
      </header>
      <div className="details-scroll">
        <div className="details-form">
          <div className="editor-identity">
            <AgentAvatar agent={{ avatar: draft.avatar, name: draft.name }} size="xl" />
            <TonePicker
              disabled={pending}
              onChange={(avatar) => saveDraft({ ...draft, avatar })}
              value={draft.avatar}
            />
          </div>
          <FormField label="Name">
            <Input
              disabled={pending}
              onBlur={(event) => saveDraft({ ...draft, name: event.currentTarget.value })}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              required
              value={draft.name}
            />
          </FormField>
          <FormField label="Title">
            <Input
              disabled={pending}
              onBlur={(event) => saveDraft({ ...draft, role: event.currentTarget.value })}
              onChange={(event) => setDraft({ ...draft, role: event.target.value })}
              placeholder="Describe what this assistant does"
              value={draft.role}
            />
          </FormField>
          <FormField label="Description">
            <Textarea
              disabled={pending}
              onBlur={(event) => saveDraft({ ...draft, instructions: event.currentTarget.value })}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
              placeholder="How should this assistant work?"
              rows={5}
              value={draft.instructions}
            />
          </FormField>
        </div>

        <section className="details-section">
          <h2>Conversation</h2>
          {snapshot.activeSessionId === null ? (
            <p className="details-muted">Start a new chat to create a session.</p>
          ) : (
            <>
              <label className="form-field">
                <span>Title</span>
                <span className="inline-field">
                  <Input
                    disabled={pending}
                    onChange={(event) => setConversationName(event.target.value)}
                    value={conversationName}
                  />
                  <Button
                    disabled={pending || conversationName.trim() === ""}
                    onClick={() => onRenameConversation(conversationName)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Rename
                  </Button>
                </span>
              </label>
              <button className="copy-id" onClick={copySessionId} type="button">
                <IconClipboard size={14} />
                <span>{copied ? "Copied" : "Copy session ID"}</span>
              </button>
            </>
          )}
        </section>

        <ContextDetails snapshot={snapshot} />

        <section className="details-section danger-section">
          <h2>Remove assistant</h2>
          <p>Conversations stay in the local database but will no longer appear in the sidebar.</p>
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button disabled={pending || snapshot.running} size="sm" variant="destructive" />
              }
            >
              <IconTrashCan size={14} />
              Delete assistant
            </AlertDialogTrigger>
            <AlertDialogContent className="confirmation-dialog">
              <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                The assistant profile will be removed. This cannot be undone from the desktop app.
              </AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                <AlertDialogClose render={<Button variant="destructive" />} onClick={onDelete}>
                  Delete assistant
                </AlertDialogClose>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </section>
      </div>
    </aside>
  );
}

export function CreateAgentDialog({
  onCreate,
  onOpenChange,
  open,
  pending,
}: {
  onCreate: (draft: AgentDraft) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  pending: boolean;
}) {
  const [draft, setDraft] = useState<AgentDraft>(() => emptyDraft());

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (draft.name.trim() === "") return;
    onCreate({ ...draft, name: draft.name.trim() });
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="agent-editor-dialog">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New assistant</DialogTitle>
            <DialogDescription className="visually-hidden">
              Name it and give it a job. The face is drawn from the name; pick a colour if you like.
              Everything can change later.
            </DialogDescription>
          </DialogHeader>

          <div className="editor-identity">
            <AgentAvatar agent={{ avatar: draft.avatar, name: draft.name }} size="xl" />
            <TonePicker
              disabled={pending}
              onChange={(avatar) => setDraft({ ...draft, avatar })}
              value={draft.avatar}
            />
          </div>

          <div className="field-group">
            <label className="field-row">
              <span>Name</span>
              <Input
                autoFocus
                disabled={pending}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Researcher"
                required
                value={draft.name}
              />
            </label>
            <label className="field-row">
              <span>Role</span>
              <Input
                disabled={pending}
                onChange={(event) => setDraft({ ...draft, role: event.target.value })}
                placeholder="What it does"
                value={draft.role}
              />
            </label>
          </div>

          <div className="field-group">
            <label className="field-row" data-multiline="true">
              <span>Instructions</span>
              <Textarea
                disabled={pending}
                onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                placeholder="How should it work? Tone, scope, what to leave alone."
                rows={4}
                value={draft.instructions}
              />
            </label>
          </div>

          <DialogFooter>
            <Button disabled={pending} onClick={() => onOpenChange(false)} variant="outline">
              Cancel
            </Button>
            <Button disabled={pending || draft.name.trim() === ""} type="submit">
              {pending ? "Creating…" : "Create assistant"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TonePicker({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange: (tone: AgentTone) => void;
  value: AgentTone;
}) {
  return (
    <fieldset className="tone-picker" disabled={disabled}>
      <legend className="visually-hidden">Colour</legend>
      {agentTones.map((tone) => (
        <button
          aria-label={tone === "neutral" ? "Colour from the name" : tone}
          aria-pressed={tone === value}
          data-tone={tone}
          key={tone}
          onClick={() => onChange(tone)}
          title={tone === "neutral" ? "From the name" : titleCase(tone)}
          type="button"
        />
      ))}
    </fieldset>
  );
}

function ContextDetails({ snapshot }: { snapshot: UjiSnapshot }) {
  const context = snapshot.context;
  if (context === null) return null;
  const percent = Math.min(100, Math.max(0, context.percent ?? 0));
  return (
    <section className="details-section context-section">
      <span className="section-title-row">
        <h2>Context</h2>
        <strong>{percent}%</strong>
      </span>
      <div
        className="context-meter"
        role="meter"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
      >
        <i style={{ width: `${percent}%` }} />
      </div>
      <dl>
        <div>
          <dt>Estimated</dt>
          <dd>{formatTokens(context.estimatedTokens)}</dd>
        </div>
        <div>
          <dt>Window</dt>
          <dd>{formatTokens(context.contextWindow)}</dd>
        </div>
        {context.lastTurnTokens !== undefined && (
          <div>
            <dt>Last turn</dt>
            <dd>{formatTokens(context.lastTurnTokens)}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function FormField({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <label className="form-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function draftFrom(agent: Agent): AgentDraft {
  return {
    name: agent.name,
    role: agent.role,
    instructions: agent.instructions,
    avatar: agent.avatar,
  };
}

function sameDraft(left: AgentDraft, right: AgentDraft): boolean {
  return (
    left.name === right.name &&
    left.role === right.role &&
    left.instructions === right.instructions &&
    left.avatar === right.avatar
  );
}

function emptyDraft(): AgentDraft {
  return { name: "", role: "", instructions: "", avatar: randomAgentTone() };
}

function titleCase(value: string): string {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}
