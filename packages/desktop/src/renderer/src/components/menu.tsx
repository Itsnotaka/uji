/**
 * The desktop's menu, over Base UI's Menu: positioning, focus, typeahead,
 * dismissal, and roving tab index are the library's job. This file decides
 * geometry and colour once, so the pane header, the sidebar filter, and the
 * model chip all open the same surface.
 *
 * Every item reserves the leading icon slot and the trailing meta column
 * whether or not it uses them, so labels start and end on the same edges in
 * every menu.
 */
import { Menu as Base } from "@base-ui/react/menu";
import * as stylex from "@stylexjs/stylex";
import type { ReactElement, ReactNode } from "react";
import type { StyleXStyles } from "@stylexjs/stylex";
import { control } from "../theme/schema.stylex.ts";
import { t } from "../theme/vars.stylex.ts";
import { Icon, type IconName } from "./icons.tsx";

const styles = stylex.create({
  positioner: { zIndex: 60, outline: "none" },
  popup: {
    display: "flex",
    flexDirection: "column",
    minWidth: control.menuWidth,
    maxWidth: 320,
    padding: 4,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: t.borderWeak,
    borderRadius: t.radiusLg,
    outline: "none",
    backgroundColor: t.bgElevated,
    boxShadow: t.shadowPopover,
    color: t.textPrimary,
    transformOrigin: "var(--transform-origin)",
    opacity: { default: 1, "[data-starting-style]": 0, "[data-ending-style]": 0 },
    scale: {
      default: 1,
      "[data-starting-style]": 0.96,
      "[data-ending-style]": 0.96,
      "@media (prefers-reduced-motion: reduce)": 1,
    },
    transitionProperty: "opacity, scale",
    transitionDuration: {
      default: t.durationFast,
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    transitionTimingFunction: t.easeOut,
  },
  item: {
    display: "grid",
    gridTemplateColumns: "16px minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: 8,
    minHeight: control.compactHeight,
    paddingInline: 6,
    borderRadius: t.radiusBase,
    outline: "none",
    backgroundColor: { default: "transparent", "[data-highlighted]": t.fillGhostHover },
    color: { default: t.textPrimary, "[data-disabled]": t.textDisabled },
    fontSize: t.fontBase,
    lineHeight: t.leadingBase,
    cursor: { default: "default", "[data-disabled]": "default" },
    userSelect: "none",
  },
  itemDanger: { color: { default: t.textDanger, "[data-disabled]": t.textDisabled } },
  icon: { display: "inline-flex", justifyContent: "center", opacity: 0.8 },
  label: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta: {
    display: "inline-flex",
    justifyContent: "flex-end",
    minWidth: 32,
    color: t.textTertiary,
    fontSize: t.fontXs,
    lineHeight: t.leadingXs,
    whiteSpace: "nowrap",
  },
  separator: { height: 1, marginBlock: 3, marginInline: -4, backgroundColor: t.borderWeak },
  groupLabel: {
    paddingInline: 6,
    paddingBlock: 3,
    color: t.textTertiary,
    fontSize: t.fontXs,
    lineHeight: t.leadingXs,
    userSelect: "none",
  },
});

export type MenuSide = Base.Positioner.Props["side"];
export type MenuAlign = Base.Positioner.Props["align"];

export interface MenuProps {
  readonly label: string;
  /** The element that opens the menu; Base UI merges the trigger props into it. */
  readonly trigger: ReactElement;
  readonly side?: MenuSide;
  readonly align?: MenuAlign;
  /** Popup overrides such as a wider surface for long lists. */
  readonly popupStyle?: StyleXStyles;
  readonly onOpenChangeComplete?: (open: boolean) => void;
  readonly children: ReactNode;
}

export function Menu({
  label,
  trigger,
  side = "bottom",
  align = "start",
  popupStyle,
  onOpenChangeComplete,
  children,
}: MenuProps): ReactElement {
  return (
    <Base.Root onOpenChangeComplete={onOpenChangeComplete}>
      <Base.Trigger render={trigger} />
      <Base.Portal>
        <Base.Positioner
          side={side}
          align={align}
          sideOffset={4}
          {...stylex.props(styles.positioner)}
        >
          <Base.Popup aria-label={label} {...stylex.props(styles.popup, popupStyle)}>
            {children}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

interface ItemBodyProps {
  readonly icon?: IconName;
  /** Right column: a shortcut, a count, a provider name. */
  readonly meta?: ReactNode;
  readonly children: ReactNode;
}

function ItemBody({ icon, meta, children }: ItemBodyProps): ReactElement {
  return (
    <>
      <span aria-hidden="true" {...stylex.props(styles.icon)}>
        {icon !== undefined && <Icon name={icon} size={14} />}
      </span>
      <span {...stylex.props(styles.label)}>{children}</span>
      <span {...stylex.props(styles.meta)}>{meta}</span>
    </>
  );
}

export interface MenuItemProps extends ItemBodyProps {
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

export function MenuItem({
  icon,
  meta,
  disabled = false,
  danger = false,
  onSelect,
  children,
}: MenuItemProps): ReactElement {
  return (
    <Base.Item
      disabled={disabled}
      {...stylex.props(styles.item, danger && styles.itemDanger)}
      onClick={onSelect}
    >
      <ItemBody icon={icon} meta={meta}>
        {children}
      </ItemBody>
    </Base.Item>
  );
}

export const MenuRadioGroup = Base.RadioGroup;

export interface MenuRadioItemProps extends ItemBodyProps {
  readonly value: string;
  readonly disabled?: boolean;
  readonly closeOnClick?: boolean;
}

export function MenuRadioItem({
  value,
  icon,
  meta,
  disabled = false,
  closeOnClick = true,
  children,
}: MenuRadioItemProps): ReactElement {
  return (
    <Base.RadioItem
      value={value}
      disabled={disabled}
      closeOnClick={closeOnClick}
      {...stylex.props(styles.item)}
    >
      <ItemBody
        icon={icon}
        meta={
          <>
            {meta}
            <Base.RadioItemIndicator>
              <Icon name="checkmark" size={11} />
            </Base.RadioItemIndicator>
          </>
        }
      >
        {children}
      </ItemBody>
    </Base.RadioItem>
  );
}

export function MenuSeparator(): ReactElement {
  return <Base.Separator {...stylex.props(styles.separator)} />;
}

export function MenuGroupLabel({ children }: { readonly children: ReactNode }): ReactElement {
  return <Base.GroupLabel {...stylex.props(styles.groupLabel)}>{children}</Base.GroupLabel>;
}
