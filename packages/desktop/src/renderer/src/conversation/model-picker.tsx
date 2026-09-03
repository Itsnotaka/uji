/**
 * The composer's model control: one menu with the thinking level on top and
 * the catalog below it, so changing either is a single click and the chip
 * never becomes a settings form. Rows show the provider glyph, the model
 * name, and the context size in one column, so a larger-context variant of a
 * model reads as its own row the moment the catalog lists it.
 */
import * as stylex from "@stylexjs/stylex";
import { useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { ThinkingLevel } from "@uji-ai/core";
import { Icon, type IconName } from "../components/icons.tsx";
import {
  Menu,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../components/menu.tsx";
import { focus } from "../components/ui.tsx";
import { useProviders } from "../queries.ts";
import { control } from "../theme/schema.stylex.ts";
import { t } from "../theme/vars.stylex.ts";
import type { DesktopModelOption, ProviderStatus } from "../uji.ts";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

const THINKING_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

const styles = stylex.create({
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    maxWidth: 220,
    height: 24,
    paddingInline: 7,
    borderStyle: "none",
    borderRadius: t.radiusBase,
    backgroundColor: {
      default: "transparent",
      ":hover": { "@media (hover: hover) and (pointer: fine)": t.fillGhostHover },
      "[data-popup-open]": t.fillGhostHover,
    },
    color: t.textSecondary,
    fontSize: t.fontSm,
    lineHeight: t.leadingSm,
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { ":disabled": 0.5 },
    flexShrink: 0,
  },
  triggerLabel: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  popup: { width: control.modelMenuWidth, maxWidth: "calc(100vw - 24px)" },
  search: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 28,
    marginInline: 2,
    marginBlock: 2,
    paddingInline: 6,
    borderRadius: t.radiusBase,
    backgroundColor: t.bgFaint,
    color: t.iconTertiary,
    boxShadow: { default: "none", ":focus-within": `inset 0 0 0 1px ${t.strokeFocused}` },
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    borderStyle: "none",
    outline: "none",
    backgroundColor: "transparent",
    color: t.textPrimary,
    fontSize: t.fontSm,
    "::placeholder": { color: t.textQuaternary },
  },
  list: { maxHeight: 264, overflowY: "auto", marginInline: -4, paddingInline: 4 },
  empty: { padding: 8, color: t.textTertiary, fontSize: t.fontSm },
});

function modelIcon(option: DesktopModelOption | undefined): IconName {
  if (option === undefined) return "model-generic";
  const id = option.id.toLowerCase();
  if (id.includes("kimi")) return "model-kimi";
  if (id.includes("glm")) return "model-zai";
  if (option.provider === "anthropic") return "model-anthropic";
  if (option.provider === "openai" || option.provider === "openai-codex") return "model-openai";
  return "model-generic";
}

interface ModelGroup {
  readonly provider: string;
  readonly label: string;
  readonly options: readonly DesktopModelOption[];
}

function providerLabel(provider: string, statuses: readonly ProviderStatus[]): string {
  return (
    statuses.find((candidate) => candidate.id === provider)?.name ??
    provider
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function groupModelOptions(
  options: readonly DesktopModelOption[],
  statuses: readonly ProviderStatus[],
  search: string,
): readonly ModelGroup[] {
  const needle = search.trim().toLowerCase();
  const groups = new Map<string, DesktopModelOption[]>();
  for (const option of options) {
    const label = providerLabel(option.provider, statuses);
    if (needle !== "" && !`${option.name}\n${option.id}\n${label}`.toLowerCase().includes(needle)) {
      continue;
    }
    const group = groups.get(option.provider);
    if (group === undefined) groups.set(option.provider, [option]);
    else group.push(option);
  }
  return [...groups].map(([provider, grouped]) => ({
    provider,
    label: providerLabel(provider, statuses),
    options: grouped,
  }));
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${String(Math.round(tokens / 100_000) / 10)}M`;
  return `${String(Math.round(tokens / 1_000))}k`;
}

function supportedThinkingLevel(
  option: DesktopModelOption | undefined,
  requested: ThinkingLevel | undefined,
): ThinkingLevel {
  const levels = option?.thinkingLevels ?? ["off"];
  if (requested !== undefined && levels.includes(requested)) return requested;
  if (levels.includes("medium")) return "medium";
  return levels[0] ?? "off";
}

export interface ModelPickerProps {
  current: DesktopModelOption | undefined;
  options: readonly DesktopModelOption[];
  thinkingLevel?: ThinkingLevel;
  disabled?: boolean;
  onModelSelect: (option: DesktopModelOption, thinkingLevel: ThinkingLevel) => void;
  onThinkingLevel: (thinkingLevel: ThinkingLevel) => void;
}

export function ModelPicker({
  current,
  options,
  thinkingLevel,
  disabled = false,
  onModelSelect,
  onThinkingLevel,
}: ModelPickerProps): ReactElement | null {
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const providers = useProviders();
  const active = current;
  const level = supportedThinkingLevel(active, thinkingLevel);
  const levels = active?.thinkingLevels ?? (["off"] as const);
  const groups = useMemo(
    () => groupModelOptions(options, providers.data ?? [], search),
    [options, providers.data, search],
  );
  const label =
    level === "off"
      ? (active?.name ?? "Model")
      : `${active?.name ?? "Model"} · ${THINKING_LABELS[level]}`;

  if (options.length === 0) return null;

  return (
    <Menu
      label="Model and thinking level"
      side="top"
      popupStyle={styles.popup}
      onOpenChangeComplete={(open) => {
        if (open) searchRef.current?.focus();
        else setSearch("");
      }}
      trigger={
        <button
          type="button"
          disabled={disabled}
          aria-label={`Model: ${label}`}
          {...stylex.props(styles.trigger, focus.ring)}
        >
          <Icon name={modelIcon(active)} size={13} />
          <span {...stylex.props(styles.triggerLabel)}>{label}</span>
          <Icon name="chevron-down" size={10} />
        </button>
      }
    >
      <MenuGroupLabel>Thinking level</MenuGroupLabel>
      <MenuRadioGroup
        value={level}
        onValueChange={(value) => {
          const next = THINKING_LEVELS.find((candidate) => candidate === value);
          if (next !== undefined) onThinkingLevel(next);
        }}
      >
        {THINKING_LEVELS.filter((candidate) => levels.includes(candidate)).map((candidate) => (
          <MenuRadioItem
            key={candidate}
            value={candidate}
            closeOnClick={false}
            meta={candidate === "off" ? "Default" : undefined}
          >
            {THINKING_LABELS[candidate]}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>

      <MenuSeparator />
      <MenuGroupLabel>Model</MenuGroupLabel>
      <label {...stylex.props(styles.search)}>
        <Icon name="search" size={12} />
        <input
          ref={searchRef}
          aria-label="Search models"
          {...stylex.props(styles.searchInput)}
          placeholder="Search models…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            // Printable keys belong to the field, not to the menu's typeahead.
            if (event.key.length === 1) event.stopPropagation();
          }}
        />
      </label>
      <div data-uji-scrollport {...stylex.props(styles.list)}>
        {groups.length === 0 && <div {...stylex.props(styles.empty)}>No matching models</div>}
        <MenuRadioGroup
          value={active?.key ?? ""}
          onValueChange={(value) => {
            const option = options.find((candidate) => candidate.key === value);
            if (option !== undefined) onModelSelect(option, supportedThinkingLevel(option, level));
          }}
        >
          {groups.map((group) => (
            <div key={group.provider} role="group" aria-label={group.label}>
              <MenuGroupLabel>{group.label}</MenuGroupLabel>
              {group.options.map((option) => (
                <MenuRadioItem
                  key={option.key}
                  value={option.key}
                  icon={modelIcon(option)}
                  meta={formatContextWindow(option.contextWindow)}
                >
                  {option.name}
                </MenuRadioItem>
              ))}
            </div>
          ))}
        </MenuRadioGroup>
      </div>
    </Menu>
  );
}
