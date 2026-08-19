import { useMemo, type ReactElement, type ReactNode } from "react";
import { IconMagnifyingGlass, IconPencil, IconPlusMedium } from "central-icons";
import * as stylex from "@stylexjs/stylex";

import {
  createDialogHandle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  IconBox,
} from "@june/ui";
import {
  Command,
  CommandCollection,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandInputGroup,
  CommandItem,
  CommandList,
  useCommandFilter,
} from "@june/ui/components/ui/command";
import type { Agent, AgentId } from "@/agents";
import { strings } from "@/strings";
import { AgentAvatar } from "./agent";

// Detached-trigger handle: the palette opens from the sidebar button and the ⌘K shortcut,
// neither of which lives next to this dialog.
export const commandPaletteHandle = createDialogHandle();

window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (commandPaletteHandle.isOpen) commandPaletteHandle.close();
    else commandPaletteHandle.open(null);
  }
});

// A palette belongs near the top of the window, not centred, so it overrides the
// kit dialog's placement. Everything else about the surface stays the kit's.
const styles = stylex.create({
  popup: {
    top: "12vh",
    display: "flex",
    flexDirection: "column",
    width: "560px",
    maxWidth: "calc(100vw - 32px)",
    maxHeight: "min(480px, calc(100dvh - 22vh))",
    gap: 0,
    overflow: "hidden",
    padding: 0,
    transform: "translateX(-50%)",
    transformOrigin: "top center",
  },
  list: { flex: 1, minHeight: 0 },
});

export type SearchPaletteProps = {
  agents: readonly Agent[];
  running: boolean;
  selectedId: AgentId | null;
  onEdit: (id: AgentId) => void;
  onNewChat: (id: AgentId) => void;
  onSelect: (id: AgentId) => void;
};

type PaletteActions = Pick<SearchPaletteProps, "onEdit" | "onNewChat" | "onSelect">;

type PaletteKind = "open" | "newChat" | "edit";

type PaletteCommand = {
  id: string;
  kind: PaletteKind;
  agent: Agent;
  label: string;
  detail: string;
};

type PaletteGroup = {
  value: string;
  items: readonly PaletteCommand[];
};

// One row per kind keeps the item markup and the dispatch uniform: the list renders
// every command the same way and looks its behaviour up here instead of branching.
const paletteKinds: Record<
  PaletteKind,
  { glyph: (agent: Agent) => ReactNode; run: (actions: PaletteActions, agent: Agent) => void }
> = {
  open: {
    glyph: (agent) => <AgentAvatar agent={agent} size="sm" />,
    run: (actions, agent) => actions.onSelect(agent.id),
  },
  newChat: {
    glyph: () => <CommandGlyph icon={<IconPlusMedium />} />,
    run: (actions, agent) => actions.onNewChat(agent.id),
  },
  edit: {
    glyph: () => <CommandGlyph icon={<IconPencil />} />,
    run: (actions, agent) => actions.onEdit(agent.id),
  },
};

export function SearchPalette(props: SearchPaletteProps) {
  return (
    <Dialog handle={commandPaletteHandle}>
      <DialogContent showCloseButton={false} xstyle={styles.popup}>
        <DialogTitle className="sr-only">{strings.palette.title}</DialogTitle>
        <DialogDescription className="sr-only">{strings.palette.description}</DialogDescription>
        <PaletteCommands {...props} />
      </DialogContent>
    </Dialog>
  );
}

// Remounted with the dialog, so the query, the highlight, and the scroll position
// all reset on close without any of them being state this component owns.
function PaletteCommands({ agents, running, selectedId, ...actions }: SearchPaletteProps) {
  const { contains } = useCommandFilter();
  const groups = useMemo(() => buildGroups(agents, selectedId), [agents, selectedId]);

  return (
    <Command
      autoHighlight="always"
      filter={(command: PaletteCommand, query) => contains(command, query, searchText)}
      inline
      items={groups}
      keepHighlight
      open
    >
      <CommandInputGroup>
        <IconBox>
          <IconMagnifyingGlass />
        </IconBox>
        <CommandInput
          aria-label={strings.palette.inputLabel}
          autoFocus
          placeholder={strings.palette.placeholder}
        />
      </CommandInputGroup>

      <CommandEmpty>
        <p className="text-detail text-muted-foreground flex min-h-24 items-center px-3">
          {strings.palette.empty}
        </p>
      </CommandEmpty>

      <CommandList xstyle={styles.list}>
        {(group: PaletteGroup) => (
          <CommandGroup items={group.items} key={group.value}>
            <CommandGroupLabel>{group.value}</CommandGroupLabel>
            <CommandCollection>
              {(command: PaletteCommand) => (
                <CommandItem
                  disabled={isBlocked(command, running, selectedId)}
                  key={command.id}
                  onClick={() => {
                    paletteKinds[command.kind].run(actions, command.agent);
                    commandPaletteHandle.close();
                  }}
                  value={command}
                >
                  {paletteKinds[command.kind].glyph(command.agent)}
                  <span className="min-w-0 flex-1 truncate">{command.label}</span>
                  <span className="text-detail text-muted-foreground max-w-1/2 min-w-0 truncate">
                    {command.detail}
                  </span>
                </CommandItem>
              )}
            </CommandCollection>
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );
}

function CommandGlyph({ icon }: { icon: ReactElement<{ size?: number }> }) {
  return (
    <span className="bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-lg">
      <IconBox glyphSize={12}>{icon}</IconBox>
    </span>
  );
}

// App.tsx short-circuits a select on the already-selected agent before its running
// guard, so those rows stay live mid-response like the sidebar's. Starting a chat
// does not, and it hits the guard.
function isBlocked(command: PaletteCommand, running: boolean, selectedId: AgentId | null): boolean {
  if (!running) return false;
  return command.kind === "newChat" || command.agent.id !== selectedId;
}

function searchText(command: PaletteCommand): string {
  return `${command.label} ${command.detail} ${command.agent.name} ${command.agent.role}`;
}

function buildGroups(agents: readonly Agent[], selectedId: AgentId | null): PaletteGroup[] {
  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0];
  const actions: PaletteCommand[] =
    selected === undefined
      ? []
      : [
          {
            id: `newChat:${selected.id}`,
            kind: "newChat",
            agent: selected,
            label: strings.palette.newChat,
            detail: selected.name,
          },
          {
            id: `edit:${selected.id}`,
            kind: "edit",
            agent: selected,
            label: strings.palette.editAgent,
            detail: selected.name,
          },
        ];
  const opens = agents.map((agent): PaletteCommand => ({
    id: `open:${agent.id}`,
    kind: "open",
    agent,
    label: agent.name,
    detail: agent.role,
  }));
  return [
    { value: strings.palette.sectionActions, items: actions },
    { value: strings.palette.sectionAgents, items: opens },
  ].filter((group) => group.items.length > 0);
}
