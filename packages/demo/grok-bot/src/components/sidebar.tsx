import {
  IconArrowBoxRight,
  IconChatBubble7,
  IconMagnifyingGlass,
  IconPencil,
  IconPlusMedium,
  IconUser,
} from "central-icons";
import * as stylex from "@stylexjs/stylex";
import {
  Avatar,
  AvatarFallback,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconBox,
  cn,
} from "@june/ui";
import { colorVars, controlVars, fontVars, spaceVars } from "@june/ui/tokens.stylex";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { SidebarProps } from "@/view-model";
import { useLogin } from "@/hooks/use-login";
import { strings } from "@/strings";
import { AgentAvatar } from "./agent";
import { AgentCreateDialog } from "./agent-dialogs";
import { commandPaletteHandle } from "./search-palette";
import { grokControlVars, grokPrimitiveStyles } from "../theme.stylex";

const styles = stylex.create({
  search: {
    height: grokControlVars["--grok-control-search-height"],
    justifyContent: "flex-start",
    paddingLeft: controlVars["--june-control-padding-sm"],
    paddingRight: spaceVars["--june-space-1"],
    borderWidth: 0,
    backgroundColor: {
      default: colorVars["--june-color-muted"],
      ":hover": {
        "@media (hover: hover)": colorVars["--june-color-muted-hover"],
      },
    },
    boxShadow: `inset 0 0 0 .5px ${colorVars["--june-color-border-weak"]}`,
    color: colorVars["--june-color-tertiary-foreground"],
    fontSize: fontVars["--june-font-size-body"],
    fontWeight: fontVars["--june-font-weight-regular"],
    lineHeight: fontVars["--june-leading-body"],
  },
  agent: {
    width: "100%",
    height: grokControlVars["--grok-control-agent-height"],
    justifyContent: "flex-start",
    gap: spaceVars["--june-space-2"],
    paddingBlock: spaceVars["--june-space-2"],
    paddingInline: spaceVars["--june-space-2"],
    borderWidth: 0,
    borderRadius: grokControlVars["--grok-control-agent-radius"],
  },
  agentCollapsed: { width: grokControlVars["--grok-control-agent-height"] },
  selected: {
    backgroundColor: {
      default: colorVars["--june-color-muted-hover"],
      ":hover": { "@media (hover: hover)": colorVars["--june-color-muted-hover"] },
    },
  },
  account: {
    width: "calc(100% - 16px)",
    height: grokControlVars["--grok-control-account-height"],
    justifyContent: "flex-start",
    gap: spaceVars["--june-space-2"],
    paddingBlock: grokControlVars["--grok-control-account-padding-block"],
    paddingInline: spaceVars["--june-space-2"],
    borderWidth: 0,
    borderRadius: grokControlVars["--grok-control-agent-radius"],
  },
  accountCollapsed: {
    width: grokControlVars["--grok-control-account-collapsed-width"],
    justifyContent: "center",
    paddingInline: grokControlVars["--grok-control-account-padding-block"],
  },
});

export function Sidebar({
  agents,
  auth,
  className,
  collapsed,
  previews,
  running,
  selectedId,
  onEdit,
  onNewChat,
  onResize,
  onSelect,
}: SidebarProps) {
  const login = useLogin();
  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    const sidebarLeft = event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    event.currentTarget.setPointerCapture(event.pointerId);

    function resize(moveEvent: PointerEvent) {
      onResize(moveEvent.clientX - sidebarLeft);
    }

    function finish() {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
    }

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish, { once: true });
  }

  return (
    <aside
      className={cn(
        "relative flex min-w-0 flex-col border-r-[.5px] border-border bg-sidebar pb-2 text-foreground",
        collapsed && "items-center",
        className,
      )}
      data-grok-surface="sidebar"
    >
      <div
        className={cn(
          "flex h-11 w-full shrink-0 items-center justify-end px-4 [-webkit-app-region:drag]",
          collapsed && "justify-center px-1",
        )}
      >
        <Button
          aria-label="New chat"
          className="[-webkit-app-region:no-drag]"
          disabled={running}
          onClick={() => onNewChat(selectedId)}
          size="icon-sm"
          variant="ghost"
          xstyle={grokPrimitiveStyles.noFocusRing}
        >
          <IconBox glyphSize={12}>
            <IconPlusMedium />
          </IconBox>
        </Button>
      </div>

      {!collapsed && (
        <DialogTrigger
          handle={commandPaletteHandle}
          render={
            <Button
              aria-label={strings.sidebar.openCommands}
              className="mx-3 my-1 w-[calc(100%-24px)] shrink-0"
              variant="ghost"
              xstyle={[styles.search, grokPrimitiveStyles.noFocusRing]}
            />
          }
        >
          <IconBox>
            <IconMagnifyingGlass />
          </IconBox>
          <span>{strings.sidebar.commands}</span>
          <kbd className="ml-auto text-caption font-normal text-muted-foreground">
            {strings.sidebar.commandsShortcut}
          </kbd>
        </DialogTrigger>
      )}

      <nav className="mt-1 flex min-h-0 w-full flex-1 flex-col px-2" aria-label="Bots">
        {agents.map((agent) => (
          <ContextMenu key={agent.id}>
            <ContextMenuTrigger
              render={
                <Button
                  className={cn("min-w-0 text-left", collapsed && "mx-auto")}
                  data-grok-surface={agent.id === selectedId ? "selected" : undefined}
                  disabled={running && agent.id !== selectedId}
                  onClick={() => onSelect(agent.id)}
                  variant="ghost"
                  xstyle={[
                    styles.agent,
                    grokPrimitiveStyles.noFocusRing,
                    collapsed && styles.agentCollapsed,
                    agent.id === selectedId && styles.selected,
                  ]}
                />
              }
            >
              <AgentAvatar agent={agent} />
              {!collapsed && (
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm leading-5 font-medium">
                    {agent.name}
                  </strong>
                  <small className="block truncate text-[13px] leading-[18px] font-[420] text-muted-foreground">
                    {previews[agent.id] || strings.sidebar.noMessages}
                  </small>
                </span>
              )}
            </ContextMenuTrigger>
            <ContextMenuContent sideOffset={4}>
              <ContextMenuItem
                disabled={running && agent.id !== selectedId}
                onClick={() => onSelect(agent.id)}
              >
                <IconBox>
                  <IconChatBubble7 />
                </IconBox>
                Open
              </ContextMenuItem>
              <ContextMenuItem disabled={running} onClick={() => onNewChat(agent.id)}>
                <IconBox>
                  <IconPlusMedium />
                </IconBox>
                New chat
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={running} onClick={() => onEdit(agent.id)}>
                <IconBox>
                  <IconPencil />
                </IconBox>
                Edit agent
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
        <AgentCreateDialog
          trigger={
            <Button
              className={cn(
                "min-w-0 shrink-0 text-left text-muted-foreground",
                collapsed && "mx-auto",
              )}
              variant="ghost"
              xstyle={[styles.agent, grokPrimitiveStyles.noFocusRing]}
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
                <IconBox glyphSize={12}>
                  <IconPlusMedium />
                </IconBox>
              </span>
              {!collapsed && <span className="text-label">{strings.sidebar.newAgent}</span>}
            </Button>
          }
        />
      </nav>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label="Account"
              className={cn("mx-2", collapsed && "mx-0")}
              variant="ghost"
              xstyle={[
                styles.account,
                grokPrimitiveStyles.noFocusRing,
                collapsed && styles.accountCollapsed,
              ]}
            />
          }
        >
          <Avatar size="sm">
            <AvatarFallback>
              <IconBox>
                <IconUser />
              </IconBox>
            </AvatarFallback>
          </Avatar>
          {!collapsed && (
            <strong className="min-w-0 flex-1 truncate text-left text-label font-medium">
              {auth.signedIn
                ? strings.account.signedIn
                : login.isPending
                  ? strings.account.signingIn
                  : strings.account.signedOut}
            </strong>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" style={{ minWidth: 228 }}>
          <DropdownMenuGroup>
            <DropdownMenuLabel>{strings.account.menuLabel}</DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled>{auth.label}</DropdownMenuItem>
          {!auth.signedIn && (
            <DropdownMenuItem disabled={login.isPending} onClick={() => login.mutate(undefined)}>
              <IconBox>
                <IconArrowBoxRight />
              </IconBox>
              {login.isPending ? strings.account.signInPending : strings.account.signIn}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {!collapsed && (
        <div
          aria-label="Resize sidebar"
          className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none"
          onPointerDown={beginResize}
          role="separator"
        />
      )}
    </aside>
  );
}
