import { useEffect, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { IconSidebarHiddenRightWide } from "central-icons";

import { Button, IconBox, Input, Textarea, cn } from "@june/ui";
import type { BotDetailsProps } from "@/view-model";
import { AgentAvatar } from "./agent";
import { grokPrimitiveStyles } from "../theme.stylex";

export function BotDetails({
  agent,
  className,
  overlay,
  width,
  onClose,
  onResize,
  onSave,
}: BotDetailsProps) {
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    setName(agent.name);
    setRole(agent.role);
    setInstructions(agent.instructions);
    setStatus(undefined);
  }, [agent.id, agent.instructions, agent.name, agent.role]);

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
    setSaving(true);
    setStatus(undefined);
    try {
      await onSave({ name, role, instructions });
      setStatus("Saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside
      aria-label={`${agent.name} settings`}
      className={cn(
        "relative shrink-0 border-l border-border bg-background",
        overlay && "absolute inset-y-0 right-0 z-20",
        className,
      )}
      style={{ width }}
    >
      <header className="flex h-11 items-center gap-2 border-b border-border px-3">
        <AgentAvatar agent={{ ...agent, name }} size="sm" />
        <strong className="min-w-0 flex-1 truncate text-[13px] font-medium">Agent settings</strong>
        <Button
          aria-label="Close agent settings"
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
          xstyle={grokPrimitiveStyles.noFocusRing}
        >
          <IconBox glyphSize={12}>
            <IconSidebarHiddenRightWide />
          </IconBox>
        </Button>
      </header>

      <form
        className="flex h-[calc(100%-44px)] min-h-0 flex-col gap-4 overflow-y-auto p-5"
        onSubmit={submit}
      >
        <label className="grid gap-1.5 text-xs font-medium" htmlFor={`${agent.id}-name`}>
          Name
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
        </label>

        <label className="grid gap-1.5 text-xs font-medium" htmlFor={`${agent.id}-role`}>
          Role
          <Input
            autoComplete="off"
            id={`${agent.id}-role`}
            maxLength={120}
            onChange={(event) => {
              setRole(event.target.value);
              setStatus(undefined);
            }}
            required
            spellCheck={false}
            value={role}
          />
        </label>

        <label
          className="grid min-h-0 flex-1 grid-rows-[auto_minmax(180px,1fr)] gap-1.5 text-xs font-medium"
          htmlFor={`${agent.id}-instructions`}
        >
          Instructions
          <Textarea
            id={`${agent.id}-instructions`}
            maxLength={12_000}
            onChange={(event) => {
              setInstructions(event.target.value);
              setStatus(undefined);
            }}
            required
            value={instructions}
            xstyle={grokPrimitiveStyles.noFocusRing}
          />
        </label>

        <div className="flex min-h-8 items-center justify-end gap-3">
          {status && (
            <span className="mr-auto text-[11px] text-muted-foreground" role="status">
              {status}
            </span>
          )}
          <Button
            disabled={!changed || saving}
            size="sm"
            type="submit"
            xstyle={grokPrimitiveStyles.noFocusRing}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>

      {!overlay && (
        <div
          aria-label="Resize agent settings"
          className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none"
          onPointerDown={beginResize}
          role="separator"
        />
      )}
    </aside>
  );
}
