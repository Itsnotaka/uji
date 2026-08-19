import { useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { IconSidebarHiddenRightWide } from "central-icons";

import { Button, IconBox, Input, Textarea, cn } from "@june/ui";
import type { Agent } from "@/agents";
import { useUpdateAgent } from "@/hooks/use-update-agent";
import { strings } from "@/strings";
import { AgentAvatar } from "./agent";
import { AgentDeleteDialog } from "./agent-dialogs";

const fieldStyle = "grid gap-2";
const labelStyle = "text-detail font-medium text-muted-foreground";

export type BotDetailsProps = {
  agent: Agent;
  className?: string;
  overlay: boolean;
  width: number;
  onClose: () => void;
  onResize: (width: number) => void;
};

// The host keys this panel by agent id, so field state re-initializes per agent.
export function BotDetails({
  agent,
  className,
  overlay,
  width,
  onClose,
  onResize,
}: BotDetailsProps) {
  const updateAgent = useUpdateAgent();
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [status, setStatus] = useState<string>();
  const saving = updateAgent.isPending;

  const changed =
    name.trim() !== agent.name ||
    role.trim() !== agent.role ||
    instructions.trim() !== agent.instructions;

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    const right = event.currentTarget.parentElement?.getBoundingClientRect().right ?? innerWidth;
    event.currentTarget.setPointerCapture(event.pointerId);

    function resize(moveEvent: PointerEvent) {
      onResize(right - moveEvent.clientX);
    }

    function finish() {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
    }

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish, { once: true });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || saving) return;
    setStatus(undefined);
    try {
      await updateAgent.mutateAsync({
        agentId: agent.id,
        changes: { name, role, instructions, avatar: agent.avatar },
      });
      setStatus(strings.details.saved);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <aside
      aria-label={strings.details.title}
      className={cn(
        "bg-background border-border relative flex shrink-0 flex-col border-l",
        overlay && "absolute inset-y-0 right-0 z-20",
        className,
      )}
      style={{ width }}
    >
      <header className="border-border flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <AgentAvatar agent={{ ...agent, name }} size="sm" />
        <strong className="text-label min-w-0 flex-1 truncate font-medium">
          {strings.details.title}
        </strong>
        <Button aria-label={strings.details.close} onClick={onClose} size="icon-sm" variant="ghost">
          <IconBox glyphSize={12}>
            <IconSidebarHiddenRightWide />
          </IconBox>
        </Button>
      </header>

      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void submit(event)}>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-5">
          <div className={fieldStyle}>
            <label className={labelStyle} htmlFor={`${agent.id}-name`}>
              {strings.details.nameLabel}
            </label>
            <Input
              autoComplete="off"
              id={`${agent.id}-name`}
              maxLength={80}
              onChange={(event) => {
                setName(event.target.value);
                setStatus(undefined);
              }}
              required
              spellCheck={false}
              value={name}
            />
          </div>

          <div className={fieldStyle}>
            <label className={labelStyle} htmlFor={`${agent.id}-role`}>
              {strings.details.roleLabel}
            </label>
            <Input
              autoComplete="off"
              id={`${agent.id}-role`}
              maxLength={120}
              onChange={(event) => {
                setRole(event.target.value);
                setStatus(undefined);
              }}
              spellCheck={false}
              value={role}
            />
          </div>

          <div className={cn(fieldStyle, "min-h-0 flex-1 grid-rows-[auto_minmax(160px,1fr)]")}>
            <label className={labelStyle} htmlFor={`${agent.id}-instructions`}>
              {strings.details.instructionsLabel}
            </label>
            <Textarea
              className="resize-none"
              id={`${agent.id}-instructions`}
              maxLength={12_000}
              onChange={(event) => {
                setInstructions(event.target.value);
                setStatus(undefined);
              }}
              value={instructions}
            />
          </div>
        </div>

        <div className="border-border flex min-h-14 shrink-0 items-center gap-3 border-t px-4">
          {status && (
            <span
              className="text-detail text-muted-foreground min-w-0 flex-1 truncate"
              role="status"
            >
              {status}
            </span>
          )}
          <Button className="ml-auto" disabled={!changed || saving} size="sm" type="submit">
            {saving ? strings.details.saving : strings.details.save}
          </Button>
        </div>
      </form>

      <div className="border-border flex shrink-0 items-center border-t px-4 py-3">
        <AgentDeleteDialog
          agent={agent}
          onDeleted={onClose}
          trigger={
            <Button size="sm" variant="destructive">
              {strings.contextMenu.deleteAgent}
            </Button>
          }
        />
      </div>

      {!overlay && (
        <div
          aria-label={strings.details.resize}
          className="absolute inset-y-0 -left-0.5 z-20 w-1.5 cursor-col-resize touch-none"
          onPointerDown={beginResize}
          role="separator"
        />
      )}
    </aside>
  );
}
