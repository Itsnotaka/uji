import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import * as stylex from "@stylexjs/stylex";
import type * as React from "react";

import { mergeStyleProps, type XStyle } from "@uji-ai/ui/style";
import { menuStyles } from "./dropdown-menu.tsx";

type StyledProps<Props> = Omit<Props, "className" | "style"> & {
  className?: string;
  style?: React.CSSProperties;
  xstyle?: XStyle;
};

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

export interface ContextMenuContentProps extends StyledProps<ContextMenuPrimitive.Popup.Props> {
  align?: ContextMenuPrimitive.Positioner.Props["align"];
  alignOffset?: ContextMenuPrimitive.Positioner.Props["alignOffset"];
  side?: ContextMenuPrimitive.Positioner.Props["side"];
  sideOffset?: number;
}

export function ContextMenuContent({
  align = "start",
  alignOffset = 0,
  className,
  side = "bottom",
  sideOffset = 0,
  style,
  xstyle,
  ...props
}: ContextMenuContentProps) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        {...stylex.props(menuStyles.positioner)}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          {...mergeStyleProps(stylex.props(menuStyles.popup, xstyle), className, style)}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export interface ContextMenuItemProps extends StyledProps<ContextMenuPrimitive.Item.Props> {
  inset?: boolean;
}

export function ContextMenuItem({
  className,
  inset = false,
  style,
  xstyle,
  ...props
}: ContextMenuItemProps) {
  return (
    <ContextMenuPrimitive.Item
      data-inset={inset || undefined}
      data-slot="context-menu-item"
      {...mergeStyleProps(
        stylex.props(menuStyles.item, inset && menuStyles.inset, xstyle),
        className,
        style,
      )}
      {...props}
    />
  );
}

export type ContextMenuSeparatorProps = StyledProps<ContextMenuPrimitive.Separator.Props>;

export function ContextMenuSeparator({
  className,
  style,
  xstyle,
  ...props
}: ContextMenuSeparatorProps) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      {...mergeStyleProps(stylex.props(menuStyles.separator, xstyle), className, style)}
      {...props}
    />
  );
}

export type ContextMenuShortcutProps = StyledProps<React.ComponentProps<"span">>;

export function ContextMenuShortcut({
  className,
  style,
  xstyle,
  ...props
}: ContextMenuShortcutProps) {
  return (
    <span
      data-slot="context-menu-shortcut"
      {...mergeStyleProps(stylex.props(menuStyles.shortcut, xstyle), className, style)}
      {...props}
    />
  );
}
