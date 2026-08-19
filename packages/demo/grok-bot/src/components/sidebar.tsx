import {
  IconArrowBoxRight,
  IconChatBubble7,
  IconChevronGrabberVertical,
  IconContrast,
  IconMagnifyingGlass,
  IconMoon,
  IconPencil,
  IconPlusMedium,
  IconSun,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconBox,
  cn,
} from "@june/ui";
import {
  avatarVars,
  borderVars,
  colorVars,
  controlVars,
  fontVars,
  radiusVars,
  spaceVars,
} from "@june/ui/tokens.stylex";
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";
import type { Agent, AgentId } from "@/agents";
import type { AuthStatus } from "@/desktop-api";
import type { ThemePreference } from "@/theme";
import { blankAgentDraft, useCreateAgent } from "@/hooks/use-create-agent";
import { useLogin } from "@/hooks/use-login";
import { strings } from "@/strings";
import { AgentAvatar } from "./agent";
import { commandPaletteHandle } from "./search-palette";
import { grokControlVars } from "../theme.stylex";

export type SidebarProps = {
  agents: readonly Agent[];
  auth: AuthStatus;
  className?: string;
  collapsed: boolean;
  running: boolean;
  selectedId: AgentId | null;
  themePreference: ThemePreference;
  onEdit: (id: AgentId) => void;
  onNewChat: (id: AgentId | null) => void;
  onResize: (width: number) => void;
  onSelect: (id: AgentId) => void;
  onThemeChange: (preference: ThemePreference) => void;
};

type AppearanceOption = {
  value: ThemePreference;
  label: string;
  icon: ReactElement<{ size?: number }>;
};

const appearanceOptions: readonly AppearanceOption[] = [
  { value: "system", label: strings.account.themeSystem, icon: <IconContrast /> },
  { value: "light", label: strings.account.themeLight, icon: <IconSun /> },
  { value: "dark", label: strings.account.themeDark, icon: <IconMoon /> },
];

const railSlot = `calc(${avatarVars["--june-avatar-size-md"]} + ${spaceVars["--june-space-2"]})`;
const hairline = `inset 0 0 0 ${borderVars["--june-border-hairline-width"]}`;

const styles = stylex.create({
  aside: {
    borderRightWidth: borderVars["--june-border-hairline-width"],
    borderRightStyle: "solid",
    borderRightColor: colorVars["--june-color-border"],
  },
  search: {
    width: "100%",
    height: grokControlVars["--grok-control-search-height"],
    justifyContent: "flex-start",
    gap: controlVars["--june-control-gap-md"],
    paddingInline: controlVars["--june-control-padding-sm"],
    borderWidth: 0,
    borderRadius: radiusVars["--june-radius-control"],
    backgroundColor: {
      default: colorVars["--june-color-muted"],
      ":hover": { "@media (hover: hover)": colorVars["--june-color-muted-hover"] },
    },
    boxShadow: `${hairline} ${colorVars["--june-color-border-weak"]}`,
    color: colorVars["--june-color-muted-foreground"],
    fontSize: fontVars["--june-font-size-label"],
    fontWeight: fontVars["--june-font-weight-regular"],
    lineHeight: fontVars["--june-leading-label"],
  },
  searchCollapsed: {
    width: controlVars["--june-control-height-md"],
    justifyContent: "center",
    paddingInline: 0,
  },
  keycap: {
    marginInlineStart: "auto",
    paddingInline: spaceVars["--june-space-1"],
    borderRadius: radiusVars["--june-radius-control"],
    boxShadow: `${hairline} ${colorVars["--june-color-border"]}`,
    color: colorVars["--june-color-tertiary-foreground"],
    fontFamily: fontVars["--june-font-family-ui"],
    fontSize: fontVars["--june-font-size-caption"],
    lineHeight: fontVars["--june-leading-detail"],
  },
  grid: {
    display: "grid",
    width: "100%",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: spaceVars["--june-space-1"],
    alignContent: "start",
  },
  gridCollapsed: {
    width: railSlot,
    gridTemplateColumns: "minmax(0, 1fr)",
  },
  tile: {
    width: "100%",
    height: "auto",
    flexDirection: "column",
    justifyContent: "flex-start",
    gap: spaceVars["--june-space-1"],
    paddingInline: spaceVars["--june-space-1"],
    paddingBlock: spaceVars["--june-space-2"],
    borderWidth: 0,
    borderRadius: grokControlVars["--grok-control-agent-radius"],
    backgroundColor: {
      default: "transparent",
      ":hover": { "@media (hover: hover)": colorVars["--june-color-muted"] },
    },
  },
  tileCollapsed: {
    paddingInline: 0,
    paddingBlock: spaceVars["--june-space-1"],
  },
  tileSelected: {
    backgroundColor: {
      default: colorVars["--june-color-muted-hover"],
      ":hover": { "@media (hover: hover)": colorVars["--june-color-muted-hover"] },
    },
  },
  role: {
    maxWidth: "100%",
    overflow: "hidden",
    paddingInline: controlVars["--june-control-padding-xs"],
    borderRadius: radiusVars["--june-radius-control"],
    backgroundColor: colorVars["--june-color-muted"],
    // Opaque, not muted-foreground: the chip wash stacks on the tile wash, and two
    // translucent layers drop 12px muted text under 4.5:1 on a selected tile in light mode.
    color: colorVars["--june-color-foreground"],
    fontSize: fontVars["--june-font-size-detail"],
    fontWeight: fontVars["--june-font-weight-regular"],
    lineHeight: fontVars["--june-leading-detail"],
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  newTile: {
    color: {
      default: colorVars["--june-color-muted-foreground"],
      ":hover": { "@media (hover: hover)": colorVars["--june-color-foreground"] },
    },
  },
  // An empty avatar slot: same footprint and squircle as a real agent avatar.
  newGlyph: {
    display: "grid",
    width: avatarVars["--june-avatar-size-lg"],
    height: avatarVars["--june-avatar-size-lg"],
    placeItems: "center",
    borderRadius: radiusVars["--june-radius-avatar"],
    boxShadow: `${hairline} ${colorVars["--june-color-border"]}`,
  },
  newGlyphCollapsed: {
    width: avatarVars["--june-avatar-size-md"],
    height: avatarVars["--june-avatar-size-md"],
  },
  row: {
    width: "100%",
    justifyContent: "flex-start",
    gap: spaceVars["--june-space-2"],
    paddingInline: spaceVars["--june-space-2"],
    borderWidth: 0,
    borderRadius: grokControlVars["--grok-control-agent-radius"],
  },
  rowCollapsed: {
    width: railSlot,
    justifyContent: "center",
    paddingInline: 0,
  },
  divider: {
    width: "100%",
    height: borderVars["--june-border-hairline-width"],
    flexShrink: 0,
    backgroundColor: colorVars["--june-color-border-weak"],
  },
  account: {
    height: grokControlVars["--grok-control-account-height"],
    color: colorVars["--june-color-foreground"],
  },
  accountCollapsed: { width: grokControlVars["--grok-control-account-collapsed-width"] },
  accountMenu: { minWidth: "232px" },
  affordance: {
    marginInlineStart: "auto",
    color: colorVars["--june-color-tertiary-foreground"],
  },
});

export function Sidebar({
  agents,
  auth,
  className,
  collapsed,
  running,
  selectedId,
  themePreference,
  onEdit,
  onNewChat,
  onResize,
  onSelect,
  onThemeChange,
}: SidebarProps) {
  const login = useLogin();
  const createAgent = useCreateAgent();

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

  function changeAppearance(value: unknown) {
    if (typeof value !== "string") return;
    const option = appearanceOptions.find((entry) => entry.value === value);
    if (option) onThemeChange(option.value);
  }

  const newChatButton = (
    <Button
      aria-label={strings.sidebar.newChat}
      className="[-webkit-app-region:no-drag]"
      disabled={running}
      onClick={() => onNewChat(selectedId)}
      size="icon"
      variant="ghost"
    >
      <IconBox>
        <IconPlusMedium />
      </IconBox>
    </Button>
  );

  return (
    <aside
      className={cn(
        "bg-sidebar text-foreground relative flex min-w-0 flex-col",
        collapsed && "items-center",
        className,
        stylex.props(styles.aside).className,
      )}
    >
      <div
        className={cn(
          "flex h-11 w-full shrink-0 items-center justify-end px-2 [-webkit-app-region:drag]",
          collapsed && "justify-center",
        )}
      >
        {!collapsed && newChatButton}
      </div>

      <div className={cn("flex w-full shrink-0 flex-col gap-1 px-2", collapsed && "items-center")}>
        {collapsed && newChatButton}
        <DialogTrigger
          handle={commandPaletteHandle}
          render={
            <Button
              aria-label={strings.palette.inputLabel}
              variant="ghost"
              xstyle={[styles.search, collapsed && styles.searchCollapsed]}
            />
          }
        >
          <IconBox>
            <IconMagnifyingGlass />
          </IconBox>
          {!collapsed && (
            <>
              <span>{strings.sidebar.search}</span>
              <kbd {...stylex.props(styles.keycap)}>{strings.sidebar.commandsShortcut}</kbd>
            </>
          )}
        </DialogTrigger>
      </div>

      <nav
        aria-label={strings.sidebar.botList}
        className={cn(
          "mt-3 flex min-h-0 w-full flex-1 flex-col overflow-x-hidden overflow-y-auto px-2 pb-2",
          collapsed && "items-center",
        )}
      >
        <div {...stylex.props(styles.grid, collapsed && styles.gridCollapsed)}>
          {agents.map((agent) => (
            <ContextMenu key={agent.id}>
              <ContextMenuTrigger
                render={
                  <Button
                    aria-current={agent.id === selectedId ? "true" : undefined}
                    aria-label={agent.name}
                    className="min-w-0"
                    disabled={running && agent.id !== selectedId}
                    onClick={() => onSelect(agent.id)}
                    variant="ghost"
                    xstyle={[
                      styles.tile,
                      collapsed && styles.tileCollapsed,
                      agent.id === selectedId && styles.tileSelected,
                    ]}
                  />
                }
              >
                <AgentAvatar agent={agent} size={collapsed ? "md" : "lg"} />
                {!collapsed && (
                  <span className="flex min-w-0 max-w-full flex-col items-center gap-0.5">
                    <strong className="text-label max-w-full truncate font-medium">
                      {agent.name}
                    </strong>
                    {agent.role.trim() !== "" && (
                      <small {...stylex.props(styles.role)}>{agent.role}</small>
                    )}
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
                  {strings.contextMenu.open}
                </ContextMenuItem>
                <ContextMenuItem disabled={running} onClick={() => onNewChat(agent.id)}>
                  <IconBox>
                    <IconPlusMedium />
                  </IconBox>
                  {strings.contextMenu.newChat}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem disabled={running} onClick={() => onEdit(agent.id)}>
                  <IconBox>
                    <IconPencil />
                  </IconBox>
                  {strings.contextMenu.editAgent}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}

          <Button
            aria-label={strings.sidebar.newAgent}
            className="min-w-0"
            disabled={createAgent.isPending}
            onClick={() => createAgent.mutate(blankAgentDraft())}
            variant="ghost"
            xstyle={[styles.tile, styles.newTile, collapsed && styles.tileCollapsed]}
          >
            <span {...stylex.props(styles.newGlyph, collapsed && styles.newGlyphCollapsed)}>
              <IconBox>
                <IconPlusMedium />
              </IconBox>
            </span>
            {!collapsed && (
              <span className="text-label max-w-full truncate">{strings.sidebar.newAgent}</span>
            )}
          </Button>
        </div>
      </nav>

      <div {...stylex.props(styles.divider)} />

      <div className={cn("flex w-full shrink-0 justify-center p-2", collapsed && "px-0")}>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={strings.account.menuLabel}
                className="min-w-0"
                variant="ghost"
                xstyle={[
                  styles.row,
                  styles.account,
                  collapsed && styles.rowCollapsed,
                  collapsed && styles.accountCollapsed,
                ]}
              />
            }
          >
            <Avatar size="sm">
              <AvatarFallback>
                <IconBox glyphSize={12}>
                  <IconUser />
                </IconBox>
              </AvatarFallback>
            </Avatar>
            {!collapsed && (
              <>
                <strong className="text-label min-w-0 flex-1 truncate text-left font-medium">
                  {auth.signedIn
                    ? strings.account.signedIn
                    : login.isPending
                      ? strings.account.signingIn
                      : strings.account.signedOut}
                </strong>
                <IconBox glyphSize={12} xstyle={styles.affordance}>
                  <IconChevronGrabberVertical />
                </IconBox>
              </>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" xstyle={styles.accountMenu}>
            <DropdownMenuGroup>
              <DropdownMenuLabel>{strings.account.menuLabel}</DropdownMenuLabel>
              <DropdownMenuItem disabled>{auth.label}</DropdownMenuItem>
              {!auth.signedIn && (
                <DropdownMenuItem
                  disabled={login.isPending}
                  onClick={() => login.mutate(undefined)}
                >
                  <IconBox>
                    <IconArrowBoxRight />
                  </IconBox>
                  {login.isPending ? strings.account.signInPending : strings.account.signIn}
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup onValueChange={changeAppearance} value={themePreference}>
              <DropdownMenuLabel>{strings.account.appearance}</DropdownMenuLabel>
              {appearanceOptions.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  <IconBox>{option.icon}</IconBox>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {!collapsed && (
        <div
          aria-label={strings.sidebar.resize}
          className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none"
          onPointerDown={beginResize}
          role="separator"
        />
      )}
    </aside>
  );
}
