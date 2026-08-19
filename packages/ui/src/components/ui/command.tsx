import { Autocomplete } from "@base-ui/react/autocomplete";
import * as stylex from "@stylexjs/stylex";
import type * as React from "react";

import { mergeStyleProps, type XStyle } from "@june/ui/style";
import {
  borderVars,
  colorVars,
  controlVars,
  fontVars,
  motionVars,
  radiusVars,
  spaceVars,
} from "@june/ui/tokens.stylex";

const styles = stylex.create({
  inputGroup: {
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    gap: controlVars["--june-control-gap-md"],
    height: controlVars["--june-control-height-xl"],
    paddingInline: spaceVars["--june-space-3"],
    borderBottomWidth: borderVars["--june-border-hairline-width"],
    borderBottomStyle: "solid",
    borderBottomColor: colorVars["--june-color-border-weak"],
    color: colorVars["--june-color-tertiary-foreground"],
    cursor: "text",
  },
  input: {
    boxSizing: "border-box",
    flex: 1,
    minWidth: 0,
    height: "100%",
    paddingBlock: 0,
    paddingInline: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colorVars["--june-color-popover-foreground"],
    fontFamily: fontVars["--june-font-family-ui"],
    fontSize: fontVars["--june-font-size-body"],
    fontWeight: fontVars["--june-font-weight-regular"],
    lineHeight: fontVars["--june-leading-body"],
    // The palette input is the surface's only tab stop and is focused for its whole
    // lifetime, so a ring here would be permanent decoration rather than a focus cue.
    outline: "none",
    "::placeholder": { color: colorVars["--june-color-muted-foreground"] },
  },
  list: {
    padding: spaceVars["--june-space-1"],
    overflowY: "auto",
    overscrollBehavior: "contain",
    scrollPaddingBlock: spaceVars["--june-space-1"],
  },
  group: {
    marginBottom: { default: 0, ":not(:last-child)": spaceVars["--june-space-1"] },
  },
  groupLabel: {
    display: "flex",
    alignItems: "center",
    height: controlVars["--june-control-height-sm"],
    paddingInline: spaceVars["--june-space-2"],
    color: colorVars["--june-color-muted-foreground"],
    fontSize: fontVars["--june-font-size-detail"],
    fontWeight: fontVars["--june-font-weight-medium"],
    lineHeight: fontVars["--june-leading-detail"],
    userSelect: "none",
    outline: "none",
  },
  item: {
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    gap: spaceVars["--june-space-2"],
    minHeight: controlVars["--june-control-height-lg"],
    paddingInline: spaceVars["--june-space-2"],
    borderRadius: radiusVars["--june-radius-control"],
    backgroundColor: {
      default: "transparent",
      "[data-highlighted]": colorVars["--june-color-muted-hover"],
    },
    color: colorVars["--june-color-popover-foreground"],
    fontSize: fontVars["--june-font-size-body"],
    lineHeight: fontVars["--june-leading-body"],
    opacity: { default: 1, "[data-disabled]": controlVars["--june-control-disabled-opacity"] },
    cursor: "default",
    userSelect: "none",
    outline: "none",
    scrollMarginBlock: spaceVars["--june-space-1"],
    transitionProperty: "background-color",
    transitionDuration: {
      default: motionVars["--june-motion-fast"],
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    transitionTimingFunction: motionVars["--june-motion-ease-out"],
  },
});

type StyledProps<Props> = Omit<Props, "className" | "style"> & {
  className?: string;
  style?: React.CSSProperties;
  xstyle?: XStyle;
};

export const Command = Autocomplete.Root;
export const CommandCollection = Autocomplete.Collection;
export const useCommandFilter = Autocomplete.useFilter;

// Base UI keeps this element mounted so screen readers announce result-count changes,
// so it carries no box of its own; style the message passed as its child.
export const CommandEmpty = Autocomplete.Empty;

export type CommandInputGroupProps = StyledProps<Autocomplete.InputGroup.Props>;

export function CommandInputGroup({ className, style, xstyle, ...props }: CommandInputGroupProps) {
  return (
    <Autocomplete.InputGroup
      data-slot="command-input-group"
      {...mergeStyleProps(stylex.props(styles.inputGroup, xstyle), className, style)}
      {...props}
    />
  );
}

export type CommandInputProps = StyledProps<Autocomplete.Input.Props>;

export function CommandInput({ className, style, xstyle, ...props }: CommandInputProps) {
  return (
    <Autocomplete.Input
      data-slot="command-input"
      {...mergeStyleProps(stylex.props(styles.input, xstyle), className, style)}
      {...props}
    />
  );
}

export type CommandListProps = StyledProps<Autocomplete.List.Props>;

export function CommandList({ className, style, xstyle, ...props }: CommandListProps) {
  return (
    <Autocomplete.List
      data-slot="command-list"
      {...mergeStyleProps(stylex.props(styles.list, xstyle), className, style)}
      {...props}
    />
  );
}

export type CommandGroupProps = StyledProps<Autocomplete.Group.Props>;

export function CommandGroup({ className, style, xstyle, ...props }: CommandGroupProps) {
  return (
    <Autocomplete.Group
      data-slot="command-group"
      {...mergeStyleProps(stylex.props(styles.group, xstyle), className, style)}
      {...props}
    />
  );
}

export type CommandGroupLabelProps = StyledProps<Autocomplete.GroupLabel.Props>;

export function CommandGroupLabel({ className, style, xstyle, ...props }: CommandGroupLabelProps) {
  return (
    <Autocomplete.GroupLabel
      data-slot="command-group-label"
      {...mergeStyleProps(stylex.props(styles.groupLabel, xstyle), className, style)}
      {...props}
    />
  );
}

export type CommandItemProps = StyledProps<Autocomplete.Item.Props>;

export function CommandItem({ className, style, xstyle, ...props }: CommandItemProps) {
  return (
    <Autocomplete.Item
      data-slot="command-item"
      {...mergeStyleProps(stylex.props(styles.item, xstyle), className, style)}
      {...props}
    />
  );
}
