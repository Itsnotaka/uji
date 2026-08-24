import { Input as InputPrimitive } from "@base-ui/react/input";
import * as stylex from "@stylexjs/stylex";
import type * as React from "react";

import { Button, type ButtonProps } from "@uji-ai/ui/components/ui/button";
import { mergeStyleProps, type XStyle } from "@uji-ai/ui/style";
import {
  borderVars,
  colorVars,
  controlVars,
  elevationVars,
  fontVars,
  motionVars,
  radiusVars,
} from "@uji-ai/ui/tokens.stylex";

const styles = stylex.create({
  root: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    borderWidth: borderVars["--uji-border-hairline-width"],
    borderStyle: "solid",
    borderColor: {
      default: colorVars["--uji-color-border"],
      ":hover": { "@media (hover: hover)": colorVars["--uji-color-border-strong"] },
      ":focus-within": colorVars["--uji-color-border-strong"],
    },
    backgroundColor: colorVars["--uji-color-field-background"],
    boxShadow: elevationVars["--uji-elevation-field"],
    // Fields never ring; :focus-within border emphasis above is the focus indicator.
    outlineStyle: "none",
    transitionProperty: "border-color",
    transitionDuration: {
      default: motionVars["--uji-motion-fast"],
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    transitionTimingFunction: motionVars["--uji-motion-ease-out"],
  },
  md: { minHeight: controlVars["--uji-control-height-md"] },
  xl: { minHeight: controlVars["--uji-control-height-xl"] },
  rounded: { borderRadius: radiusVars["--uji-radius-field"] },
  pill: { borderRadius: radiusVars["--uji-radius-pill"] },
  addon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    gap: controlVars["--uji-control-gap-sm"],
    color: colorVars["--uji-color-muted-foreground"],
    fontFamily: fontVars["--uji-font-family-ui"],
    fontSize: fontVars["--uji-font-size-body"],
    fontWeight: fontVars["--uji-font-weight-medium"],
    userSelect: "none",
  },
  inlineStart: {
    order: -1,
    paddingInlineStart: controlVars["--uji-control-padding-sm"],
  },
  inlineEnd: {
    order: 1,
    paddingInlineEnd: controlVars["--uji-control-padding-sm"],
  },
  blockStart: {
    width: "100%",
    alignSelf: "stretch",
    justifyContent: "flex-start",
    paddingInline: controlVars["--uji-control-padding-md"],
    paddingBlockStart: controlVars["--uji-control-padding-sm"],
  },
  blockEnd: {
    width: "100%",
    alignSelf: "stretch",
    justifyContent: "flex-start",
    paddingInline: controlVars["--uji-control-padding-md"],
    paddingBlockEnd: controlVars["--uji-control-padding-sm"],
  },
  withBlockStart: { flexDirection: "column" },
  text: {
    display: "flex",
    alignItems: "center",
    gap: controlVars["--uji-control-gap-sm"],
    color: colorVars["--uji-color-muted-foreground"],
    fontFamily: fontVars["--uji-font-family-ui"],
    fontSize: fontVars["--uji-font-size-body"],
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
    color: colorVars["--uji-color-foreground"],
    fontFamily: fontVars["--uji-font-family-ui"],
    fontSize: fontVars["--uji-font-size-body"],
    fontWeight: fontVars["--uji-font-weight-regular"],
    lineHeight: fontVars["--uji-leading-body"],
    outline: "none",
    "::placeholder": { color: colorVars["--uji-color-muted-foreground"] },
  },
  input: {
    alignSelf: "stretch",
    paddingInline: controlVars["--uji-control-padding-md"],
    paddingBlock: 0,
  },
  textarea: {
    minHeight: fontVars["--uji-leading-body"],
    maxHeight: controlVars["--uji-control-textarea-max-height"],
    paddingInline: controlVars["--uji-control-padding-lg"],
    paddingBlock: controlVars["--uji-control-textarea-compact-padding"],
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
        if (event.defaultPrevented) return;
        if (event.target instanceof Element && event.target.closest("button")) return;
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
