import { Input as InputPrimitive } from "@base-ui/react/input";
import * as stylex from "@stylexjs/stylex";
import type * as React from "react";

import { Button, type ButtonProps } from "@june/ui/components/ui/button";
import { mergeStyleProps, type XStyle } from "@june/ui/style";
import {
  borderVars,
  colorVars,
  controlVars,
  elevationVars,
  fontVars,
  radiusVars,
} from "@june/ui/tokens.stylex";

const styles = stylex.create({
  root: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    borderWidth: borderVars["--june-border-hairline-width"],
    borderStyle: "solid",
    borderColor: colorVars["--june-color-input"],
    backgroundColor: colorVars["--june-color-field-background"],
    boxShadow: elevationVars["--june-elevation-field"],
    outlineColor: colorVars["--june-color-ring"],
    outlineStyle: { default: "none", ":focus-within": "solid" },
    outlineWidth: controlVars["--june-control-focus-width"],
    outlineOffset: controlVars["--june-control-focus-offset"],
  },
  md: { minHeight: controlVars["--june-control-height-md"] },
  xl: { minHeight: controlVars["--june-control-height-xl"] },
  rounded: { borderRadius: radiusVars["--june-radius-field"] },
  pill: { borderRadius: radiusVars["--june-radius-pill"] },
  addon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    gap: controlVars["--june-control-gap-sm"],
    color: colorVars["--june-color-muted-foreground"],
    fontFamily: fontVars["--june-font-family-ui"],
    fontSize: fontVars["--june-font-size-body"],
    fontWeight: fontVars["--june-font-weight-medium"],
    userSelect: "none",
  },
  inlineStart: {
    order: -1,
    paddingInlineStart: controlVars["--june-control-padding-sm"],
  },
  inlineEnd: {
    order: 1,
    paddingInlineEnd: controlVars["--june-control-padding-sm"],
  },
  blockStart: {
    width: "100%",
    alignSelf: "stretch",
    justifyContent: "flex-start",
    paddingInline: controlVars["--june-control-padding-md"],
    paddingBlockStart: controlVars["--june-control-padding-sm"],
  },
  blockEnd: {
    width: "100%",
    alignSelf: "stretch",
    justifyContent: "flex-start",
    paddingInline: controlVars["--june-control-padding-md"],
    paddingBlockEnd: controlVars["--june-control-padding-sm"],
  },
  withBlockStart: { flexDirection: "column" },
  text: {
    display: "flex",
    alignItems: "center",
    gap: controlVars["--june-control-gap-sm"],
    color: colorVars["--june-color-muted-foreground"],
    fontFamily: fontVars["--june-font-family-ui"],
    fontSize: fontVars["--june-font-size-body"],
  },
  control: {
    boxSizing: "border-box",
    flex: 1,
    width: "100%",
    minWidth: 0,
    borderWidth: 0,
    borderStyle: "none",
    borderRadius: "inherit",
    backgroundColor: "transparent",
    color: colorVars["--june-color-foreground"],
    fontFamily: fontVars["--june-font-family-ui"],
    fontSize: fontVars["--june-font-size-body"],
    fontWeight: fontVars["--june-font-weight-regular"],
    lineHeight: fontVars["--june-leading-body"],
    outline: "none",
    "::placeholder": { color: colorVars["--june-color-muted-foreground"] },
  },
  input: {
    alignSelf: "stretch",
    paddingInline: controlVars["--june-control-padding-md"],
    paddingBlock: 0,
  },
  textarea: {
    minHeight: fontVars["--june-leading-body"],
    maxHeight: controlVars["--june-control-textarea-max-height"],
    paddingInline: controlVars["--june-control-padding-lg"],
    paddingBlock: controlVars["--june-control-textarea-compact-padding"],
    resize: "none",
  },
});

const sizeStyles = { md: styles.md, xl: styles.xl } as const;
const shapeStyles = { rounded: styles.rounded, pill: styles.pill } as const;
const addonStyles = {
  "inline-start": styles.inlineStart,
  "inline-end": styles.inlineEnd,
  "block-start": styles.blockStart,
  "block-end": styles.blockEnd,
} as const;

export type InputGroupSize = keyof typeof sizeStyles;
export type InputGroupShape = keyof typeof shapeStyles;
export type InputGroupAddonAlign = keyof typeof addonStyles;

export interface InputGroupProps extends Omit<React.ComponentProps<"div">, "className" | "style"> {
  className?: string;
  shape?: InputGroupShape;
  size?: InputGroupSize;
  style?: React.CSSProperties;
  xstyle?: XStyle;
}

export function InputGroup({
  className,
  shape = "rounded",
  size = "md",
  style,
  xstyle,
  ...props
}: InputGroupProps) {
  return (
    <div
      data-slot="input-group"
      data-size={size}
      data-shape={shape}
      role="group"
      {...mergeStyleProps(
        stylex.props(styles.root, sizeStyles[size], shapeStyles[shape], xstyle),
        className,
        style,
      )}
      {...props}
    />
  );
}

export interface InputGroupAddonProps extends Omit<
  React.ComponentProps<"div">,
  "className" | "style"
> {
  align?: InputGroupAddonAlign;
  className?: string;
  style?: React.CSSProperties;
  xstyle?: XStyle;
}

export function InputGroupAddon({
  align = "inline-start",
  className,
  onClick,
  style,
  xstyle,
  ...props
}: InputGroupAddonProps) {
  return (
    <div
      data-align={align}
      data-slot="input-group-addon"
      role="group"
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || (event.target as HTMLElement).closest("button")) return;
        event.currentTarget.parentElement
          ?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")
          ?.focus();
      }}
      {...mergeStyleProps(stylex.props(styles.addon, addonStyles[align], xstyle), className, style)}
      {...props}
    />
  );
}

export type InputGroupButtonSize = "xs" | "sm" | "icon-xs" | "icon-sm";

export interface InputGroupButtonProps extends Omit<ButtonProps, "size"> {
  size?: InputGroupButtonSize;
}

export function InputGroupButton({
  size = "xs",
  type = "button",
  variant = "ghost",
  ...props
}: InputGroupButtonProps) {
  return (
    <Button data-slot="input-group-button" size={size} type={type} variant={variant} {...props} />
  );
}

export interface InputGroupTextProps extends Omit<
  React.ComponentProps<"span">,
  "className" | "style"
> {
  className?: string;
  style?: React.CSSProperties;
  xstyle?: XStyle;
}

export function InputGroupText({ className, style, xstyle, ...props }: InputGroupTextProps) {
  return (
    <span
      data-slot="input-group-text"
      {...mergeStyleProps(stylex.props(styles.text, xstyle), className, style)}
      {...props}
    />
  );
}

export interface InputGroupInputProps extends Omit<InputPrimitive.Props, "className" | "style"> {
  className?: string;
  style?: React.CSSProperties;
  xstyle?: XStyle;
}

export function InputGroupInput({ className, style, xstyle, ...props }: InputGroupInputProps) {
  return (
    <InputPrimitive
      data-slot="input-group-control"
      {...mergeStyleProps(stylex.props(styles.control, styles.input, xstyle), className, style)}
      {...props}
    />
  );
}

export interface InputGroupTextareaProps extends Omit<
  React.ComponentProps<"textarea">,
  "className" | "style"
> {
  className?: string;
  style?: React.CSSProperties;
  xstyle?: XStyle;
}

export function InputGroupTextarea({
  className,
  style,
  xstyle,
  ...props
}: InputGroupTextareaProps) {
  return (
    <textarea
      data-slot="input-group-control"
      {...mergeStyleProps(stylex.props(styles.control, styles.textarea, xstyle), className, style)}
      {...props}
    />
  );
}
