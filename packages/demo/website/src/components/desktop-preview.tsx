import type { ComponentProps } from "react";
import {
  IconArrowUp,
  IconMagnifyingGlass,
  IconPlusMedium,
  IconSidebarHiddenRightWide,
  IconUser,
} from "central-icons";
import { Avatar, AvatarFallback } from "@uji-ai/ui";

export type DesktopPreviewScenario = "conversation" | "search" | "details";

interface DesktopPreviewProps extends Pick<ComponentProps<"div">, "className"> {
  scenario?: DesktopPreviewScenario;
}

const agents = [
  {
    name: "Uji",
    detail: "Chief of staff",
    mark: "U",
    tone: "orange",
    active: true,
  },
  {
    name: "Tweeter",
    detail: "Social editor",
    mark: "T",
    tone: "blue",
    active: false,
  },
  {
    name: "Slacker",
    detail: "Team concierge",
    mark: "S",
    tone: "violet",
    active: false,
  },
  {
    name: "Rawr",
    detail: "Research lead",
    mark: "R",
    tone: "green",
    active: false,
  },
] as const;

const scenarioLabels: Record<DesktopPreviewScenario, string> = {
  conversation: "conversation",
  search: "search palette",
  details: "bot details",
};

export function DesktopPreview({ className, scenario = "conversation" }: DesktopPreviewProps) {
  return (
    <div
      className={`overflow-hidden rounded-2xl border border-[color:var(--uji-color-border)] bg-(--uji-color-background) text-(--uji-color-foreground) [color-scheme:dark] shadow-[var(--uji-elevation-dialog)] ${className ?? ""}`}
      aria-label={`Uji desktop ${scenarioLabels[scenario]} preview`}
      data-demo-scenario={scenario}
      data-uji-surface="canvas"
    >
      <div className="relative grid aspect-[16/10] min-h-[430px] grid-cols-[minmax(180px,27%)_minmax(0,1fr)] max-[780px]:grid-cols-[76px_minmax(0,1fr)]">
        <aside
          className="flex min-w-0 flex-col border-r-[0.5px] border-[color:var(--uji-color-border)] bg-(--uji-color-sidebar) pb-2"
          data-uji-surface="sidebar"
        >
          <div className="flex h-11 shrink-0 items-center justify-between px-4 max-[780px]:justify-center max-[780px]:px-1">
            <div className="flex gap-2 max-[780px]:hidden" aria-hidden="true">
              <span className="size-2.5 rounded-full bg-macos-close" />
              <span className="size-2.5 rounded-full bg-macos-minimize" />
              <span className="size-2.5 rounded-full bg-macos-zoom" />
            </div>
            <span className="grid size-7 place-items-center rounded-lg text-(--uji-color-muted-foreground)">
              <IconPlusMedium className="size-4" />
            </span>
          </div>
          <div
            className="mx-3 my-1 flex h-8 items-center gap-2 rounded-lg bg-(--uji-color-muted) px-2 text-sm/5 text-(--uji-color-tertiary-foreground) shadow-[inset_0_0_0_.5px_var(--uji-color-border-weak)] max-[780px]:mx-auto max-[780px]:size-8 max-[780px]:justify-center"
            data-uji-surface="search"
          >
            <IconMagnifyingGlass size={14} />
            <span className="max-[780px]:hidden">Search</span>
          </div>
          <div className="mt-1 flex flex-1 flex-col px-2">
            {agents.map((agent) => (
              <div
                className={`flex h-[54px] items-center gap-2 rounded-[10px] px-2 ${
                  agent.active ? "bg-(--uji-color-muted-hover)" : ""
                } max-[780px]:justify-center`}
                data-uji-surface={agent.active ? "selected" : undefined}
                key={agent.name}
              >
                <Avatar shape="rounded" size="md" tone={agent.tone}>
                  <AvatarFallback>{agent.mark}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 max-[780px]:hidden">
                  <strong className="block truncate text-sm/5 font-medium">{agent.name}</strong>
                  <small className="block truncate text-[13px]/[18px] text-(--uji-color-tertiary-foreground)">
                    {agent.detail}
                  </small>
                </span>
              </div>
            ))}
          </div>
          <div className="mx-2 flex h-10 items-center gap-2 rounded-[10px] px-2 max-[780px]:justify-center">
            <Avatar size="sm">
              <AvatarFallback>
                <IconUser size={14} />
              </AvatarFallback>
            </Avatar>
            <strong className="min-w-0 truncate text-[13px]/[18px] font-medium max-[780px]:hidden">
              ChatGPT
            </strong>
          </div>
        </aside>

        <section
          className="relative grid min-w-0 grid-rows-[44px_minmax(0,1fr)_auto]"
          data-uji-surface="conversation"
        >
          <div className="flex items-center gap-1.5 border-b-[0.5px] border-[color:var(--uji-color-border)] px-3">
            <Avatar shape="rounded" size="xs" tone="orange">
              <AvatarFallback>U</AvatarFallback>
            </Avatar>
            <strong className="text-[13px]/[18px] font-medium">Uji</strong>
          </div>
          <div className="flex min-h-0 flex-col justify-center px-4 py-8">
            <div className="flex w-full flex-col text-sm/5">
              <div
                className="ml-auto max-w-[min(88%,640px,calc(100%-82px))] rounded-[18px] bg-(--uji-color-bubble-user) px-3 py-2 text-(--uji-color-bubble-user-foreground)"
                data-uji-surface="bubble-user"
              >
                Help me turn this idea into the smallest real product.
              </div>
              <div
                className="mt-3 max-w-[min(88%,640px,calc(100%-82px))] rounded-[18px] bg-(--uji-color-bubble-agent) px-3 py-2 text-(--uji-color-foreground)"
                data-uji-surface="bubble-agent"
              >
                Start with one honest loop: sign in, ask Uji, stream the answer, keep the session.
                Everything else can earn its way in.
              </div>
            </div>
          </div>
          <div className="px-4 pb-4">
            <div
              className="flex h-11 items-center rounded-[22px] border border-[color:var(--uji-color-border)] bg-(--uji-color-field-background) py-2 pr-2 pl-4 text-sm/5 text-(--uji-color-tertiary-foreground) shadow-[var(--uji-elevation-field)]"
              data-uji-surface="composer"
            >
              <span>Message Uji</span>
              <span className="ml-auto grid size-7 place-items-center rounded-full bg-(--uji-color-primary) text-base text-(--uji-color-primary-foreground)">
                <IconArrowUp className="size-4" />
              </span>
            </div>
          </div>
          {scenario === "details" && <DetailsPreview />}
        </section>
        {scenario === "search" && <SearchPreview />}
      </div>
    </div>
  );
}

function SearchPreview() {
  return (
    <div
      className="absolute inset-0 z-20 grid place-items-center bg-(--uji-color-scrim) p-5"
      data-uji-surface="scrim"
    >
      <div
        className="w-full max-w-[560px] overflow-hidden rounded-[14px] bg-(--uji-color-popover) text-(--uji-color-popover-foreground) shadow-[var(--uji-elevation-dialog)]"
        data-uji-surface="palette"
      >
        <div className="flex h-12 items-center gap-2 border-b border-[color:var(--uji-color-border-weak)] px-3.5 text-sm text-(--uji-color-muted-foreground)">
          <IconMagnifyingGlass size={16} />
          <span>Search</span>
        </div>
        <div className="space-y-0.5 p-2">
          {agents.map((agent, index) => (
            <div
              className={`flex h-[54px] items-center gap-2 rounded-[10px] px-2 ${
                index === 0 ? "bg-(--uji-color-muted-hover)" : ""
              }`}
              data-uji-surface={index === 0 ? "palette-selected" : undefined}
              key={agent.name}
            >
              <Avatar shape="rounded" size="md" tone={agent.tone}>
                <AvatarFallback>{agent.mark}</AvatarFallback>
              </Avatar>
              <span className="min-w-0">
                <strong className="block truncate text-sm/5 font-medium">{agent.name}</strong>
                <small className="block truncate text-[13px]/[18px] text-(--uji-color-muted-foreground)">
                  {agent.detail}
                </small>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DetailsPreview() {
  return (
    <aside
      className="absolute inset-y-0 right-0 z-10 w-[38%] min-w-[220px] border-l border-[color:var(--uji-color-border)] bg-(--uji-color-background)"
      data-uji-surface="details"
    >
      <div className="flex h-11 items-center justify-end border-b border-[color:var(--uji-color-border)] px-2 text-(--uji-color-muted-foreground)">
        <span className="grid size-8 place-items-center rounded-lg">
          <IconSidebarHiddenRightWide size={16} />
        </span>
      </div>
      <div className="p-5 text-center">
        <div className="flex flex-col items-center border-b border-[color:var(--uji-color-border)] pb-5">
          <Avatar shape="rounded" size="lg" tone="orange">
            <AvatarFallback>U</AvatarFallback>
          </Avatar>
          <strong className="mt-4 text-lg font-medium tracking-tight">Uji</strong>
          <span className="mt-1 text-xs text-(--uji-color-muted-foreground)">Chief of staff</span>
          <p className="mt-4 text-xs/5 text-(--uji-color-muted-foreground)">
            A real Uji Core session for thinking, planning, writing, and following through.
          </p>
        </div>
        <div className="pt-5 text-left">
          <span className="inline-flex rounded-full bg-(--uji-color-muted) px-2 py-1 text-[10px] font-semibold tracking-wider text-(--uji-color-muted-foreground) uppercase">
            Live
          </span>
          <p className="mt-2.5 text-xs/5 text-(--uji-color-muted-foreground)">
            ChatGPT connected. Sessions stay on this device; no workspace is required.
          </p>
        </div>
      </div>
    </aside>
  );
}
