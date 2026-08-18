import { useMemo, useState, type KeyboardEvent } from "react";
import { IconMagnifyingGlass, IconPencil, IconPlusMedium } from "central-icons";
import * as stylex from "@stylexjs/stylex";

import {
  Button,
  createDialogHandle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  IconBox,
  Input,
} from "@june/ui";
import { mergeStyleProps } from "@june/ui/style";
import { colorVars, elevationVars, fontVars, spaceVars } from "@june/ui/tokens.stylex";
import type { Agent, AgentId } from "@/agents";
import type { SearchPaletteProps } from "@/view-model";
import { strings } from "@/strings";
import { AgentAvatar } from "./agent";
import { grokControlVars, grokPrimitiveStyles } from "../theme.stylex";

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

const styles = stylex.create({
  input: {
    height: fontVars["--june-leading-body"],
    flex: 1,
    paddingBlock: 0,
    paddingInline: 0,
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    outline: "none",
  },
  result: {
    width: "100%",
    minHeight: grokControlVars["--grok-control-agent-height"],
    justifyContent: "flex-start",
    gap: spaceVars["--june-space-2"],
    paddingBlock: spaceVars["--june-space-2"],
    paddingInline: spaceVars["--june-space-2"],
    borderWidth: 0,
    borderRadius: grokControlVars["--grok-control-agent-radius"],
  },
  activeResult: { backgroundColor: colorVars["--june-color-muted-hover"] },
  dialog: {
    borderColor: colorVars["--june-color-border"],
    backgroundColor: colorVars["--june-color-popover"],
    boxShadow: elevationVars["--june-elevation-menu"],
  },
  overlay: { backgroundColor: colorVars["--june-color-scrim"] },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    paddingTop: "14px",
    paddingRight: "10px",
    paddingBottom: "14px",
    paddingLeft: "14px",
    borderBottomColor: colorVars["--june-color-border-weak"],
  },
  list: {
    display: "flex",
    height: "360px",
    flexDirection: "column",
    rowGap: "2px",
    overflowY: "auto",
    padding: "8px",
  },
});

type Command = {
  id: string;
  kind: "open" | "new" | "edit";
  agent: Agent;
  label: string;
  detail: string;
};

export function SearchPalette({
  agents,
  running,
  selectedId,
  onEdit,
  onNewChat,
  onSelect,
}: SearchPaletteProps) {
  return (
    <Dialog handle={commandPaletteHandle}>
      <DialogContent
        motionDuration="0ms"
        overlayXstyle={styles.overlay}
        style={{ width: 560, maxWidth: "92vw", gap: 0, overflow: "hidden", padding: 0 }}
        showCloseButton={false}
        xstyle={styles.dialog}
      >
        <DialogTitle className="sr-only">{strings.palette.title}</DialogTitle>
        <DialogDescription className="sr-only">{strings.palette.description}</DialogDescription>
        <PaletteContent
          agents={agents}
          running={running}
          selectedId={selectedId}
          onEdit={onEdit}
          onNewChat={onNewChat}
          onSelect={onSelect}
        />
      </DialogContent>
    </Dialog>
  );
}

function PaletteContent({
  agents,
  running,
  selectedId,
  onEdit,
  onNewChat,
  onSelect,
}: SearchPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const commands = useMemo(() => buildCommands(agents, selectedId), [agents, selectedId]);
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.detail} ${command.agent.name} ${command.agent.role}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [commands, query]);
  const highlightedIndex = Math.min(activeIndex, Math.max(0, results.length - 1));

  function run(command: Command) {
    if (running) return;
    if (command.kind === "open") onSelect(command.agent.id);
    if (command.kind === "new") onNewChat(command.agent.id);
    if (command.kind === "edit") onEdit(command.agent.id);
    commandPaletteHandle.close();
  }

  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(Math.min(highlightedIndex + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(Math.max(highlightedIndex - 1, 0));
    } else if (event.key === "Enter" && results[highlightedIndex]) {
      event.preventDefault();
      run(results[highlightedIndex]);
    }
  }

  return (
    <>
      <div {...mergeStyleProps(stylex.props(styles.header), "border-b")}>
        <IconBox className="text-muted-foreground">
          <IconMagnifyingGlass />
        </IconBox>
        <Input
          aria-label={strings.palette.inputLabel}
          autoFocus
          xstyle={[styles.input, grokPrimitiveStyles.noFocusRing]}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={navigate}
          placeholder={strings.palette.placeholder}
          value={query}
        />
      </div>
      <div {...stylex.props(styles.list)} role="listbox">
        {results.map((command, index) => (
          <Button
            aria-selected={index === highlightedIndex}
            className="text-left"
            disabled={running}
            key={command.id}
            onClick={() => run(command)}
            onMouseEnter={() => setActiveIndex(index)}
            role="option"
            variant="ghost"
            xstyle={[
              styles.result,
              grokPrimitiveStyles.noFocusRing,
              index === highlightedIndex && styles.activeResult,
            ]}
          >
            {command.kind === "open" ? (
              <AgentAvatar agent={command.agent} />
            ) : (
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <IconBox>{command.kind === "new" ? <IconPlusMedium /> : <IconPencil />}</IconBox>
              </span>
            )}
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-sm leading-5 font-medium">
                {command.label}
              </strong>
              <small className="block truncate text-label font-normal text-muted-foreground">
                {command.detail}
              </small>
            </span>
          </Button>
        ))}
        {results.length === 0 && (
          <p className="grid flex-1 place-items-center text-sm text-muted-foreground">
            {strings.palette.empty}
          </p>
        )}
      </div>
    </>
  );
}

function buildCommands(agents: readonly Agent[], selectedId: AgentId | null): Command[] {
  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0];
  if (selected === undefined) return [];
  return [
    {
      id: `new:${selected.id}`,
      kind: "new",
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
    ...agents.map((agent): Command => ({
      id: `open:${agent.id}`,
      kind: "open",
      agent,
      label: agent.name,
      detail: agent.role,
    })),
  ];
}
