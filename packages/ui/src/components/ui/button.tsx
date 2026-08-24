import { Button as ButtonPrimitive } from "@base-ui/react/button";
import * as stylex from "@stylexjs/stylex";
import type * as React from "react";

import { mergeStyleProps, type XStyle } from "@uji-ai/ui/style";
import {
  borderVars,
  colorVars,
  controlVars,
  fontVars,
  motionVars,
  radiusVars,
} from "@uji-ai/ui/tokens.stylex";

const styles = stylex.create({
  root: {
    appearance: "none",
    boxSizing: "border-box",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    gap: controlVars["--uji-control-gap-sm"],
    borderWidth: borderVars["--uji-border-control-width"],
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radiusVars["--uji-radius-control"],
    fontFamily: fontVars["--uji-font-family-ui"],
    fontWeight: fontVars["--uji-font-weight-medium"],
    lineHeight: 1,
    whiteSpace: "nowrap",
    textDecoration: "none",
    userSelect: "none",
    outlineColor: colorVars["--uji-color-ring"],
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: controlVars["--uji-control-focus-width"],
    outlineOffset: controlVars["--uji-control-focus-offset"],
    opacity: {
      default: 1,
      ":disabled": controlVars["--uji-control-disabled-opacity"],
      "[data-disabled]": controlVars["--uji-control-disabled-opacity"],
    },
    pointerEvents: { default: "auto", ":disabled": "none", "[data-disabled]": "none" },
    transform: { default: "none", ":active:not(:disabled)": "translateY(1px)" },
    transitionProperty: "background-color, border-color, color, opacity",
    transitionDuration: {
      default: motionVars["--uji-motion-fast"],
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    transitionTimingFunction: motionVars["--uji-motion-ease-out"],
  },
  default: {
    backgroundColor: {
      default: colorVars["--uji-color-primary"],
      ":hover": { "@media (hover: hover)": colorVars["--uji-color-primary-hover"] },
      "[data-popup-open]": colorVars["--uji-color-primary-hover"],
    },
    color: colorVars["--uji-color-primary-foreground"],
  },
  outline: {
    borderColor: {
      default: colorVars["--uji-color-border"],
      ":hover": { "@media (hover: hover)": colorVars["--uji-color-border-strong"] },
    },
    backgroundColor: {
      default: "transparent",
      ":hover": { "@media (hover: hover)": colorVars["--uji-color-muted"] },
      "[data-popup-open]": colorVars["--uji-color-muted"],
    },
    color: colorVars["--uji-color-foreground"],
  },
  secondary: {
    backgroundColor: {
      default: colorVars["--uji-color-muted"],
      ":hover": { "@media (hover: hover)": colorVars["--uji-color-muted-hover"] },
      "[data-popup-open]": colorVars["--uji-color-muted-hover"],
    },
    color: colorVars["--uji-color-foreground"],
  },
  ghost: {
    backgroundColor: {
      default: "transparent",
      ":hover": { "@media (hover: hover)": colorVars["--uji-color-muted-hover"] },
      "[data-popup-open]": colorVars["--uji-color-muted-hover"],
    },
    color: colorVars["--uji-color-foreground"],
  },
  destructive: {
    backgroundColor: {
      default: colorVars["--uji-color-destructive-muted"],
      ":hover": { "@media (hover: hover)": colorVars["--uji-color-destructive-hover"] },
      "[data-popup-open]": colorVars["--uji-color-destructive-hover"],
    },
    color: colorVars["--uji-color-destructive"],
  },
  link: {
    borderColor: "transparent",
    backgroundColor: "transparent",
    color: colorVars["--uji-color-primary"],
    textDecorationLine: { default: "none", ":hover": "underline" },
    textUnderlineOffset: "4px",
  },
  defaultSize: {
    height: controlVars["--uji-control-height-md"],
    paddingInline: controlVars["--uji-control-padding-sm"],
    fontSize: fontVars["--uji-font-size-body"],
  },
  xs: {
    height: controlVars["--uji-control-height-xs"],
    paddingInline: controlVars["--uji-control-padding-sm"],
    gap: controlVars["--uji-control-gap-sm"],
    fontSize: fontVars["--uji-font-size-detail"],
  },
  sm: {
    height: controlVars["--uji-control-height-sm"],
    paddingInline: controlVars["--uji-control-padding-xs"],
    gap: controlVars["--uji-control-gap-sm"],
    fontSize: fontVars["--uji-font-size-detail"],
  },
  lg: {
    height: controlVars["--uji-control-height-lg"],
    paddingInline: controlVars["--uji-control-padding-lg"],
    fontSize: fontVars["--uji-font-size-body"],
  },
  icon: {
    width: controlVars["--uji-control-height-md"],
    height: controlVars["--uji-control-height-md"],
    paddingInline: 0,
  },
  iconXs: {
    width: controlVars["--uji-control-height-xs"],
    height: controlVars["--uji-control-height-xs"],
    paddingInline: 0,
  },
  iconSm: {
    width: controlVars["--uji-control-height-sm"],
    height: controlVars["--uji-control-height-sm"],
    paddingInline: 0,
  },
  iconLg: {
    width: controlVars["--uji-control-height-lg"],
    height: controlVars["--uji-control-height-lg"],
    paddingInline: 0,
  },
});

const variantStyles = {
  default: styles.default,
  outline: styles.outline,
  secondary: styles.secondary,
  ghost: styles.ghost,
  destructive: styles.destructive,
  link: styles.link,
} as const;

const sizeStyles = {
  default: styles.defaultSize,
  xs: styles.xs,
  sm: styles.sm,
  lg: styles.lg,
  icon: styles.icon,
  "icon-xs": styles.iconXs,
  "icon-sm": styles.iconSm,
  "icon-lg": styles.iconLg,
} as const;

export type ButtonVariant = keyof typeof variantStyles;
export type ButtonSize = keyof typeof sizeStyles;

export interface ButtonProps extends Omit<ButtonPrimitive.Props, "className" | "style"> {
  className?: string;
  size?: ButtonSize;
  style?: React.CSSProperties;
  variant?: ButtonVariant;
  xstyle?: XStyle;
}

export function Button({
  className,
  render,
  size = "default",
  style,
  type,
  variant = "default",
  xstyle,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-size={size}
      data-variant={variant}
      render={render}
      type={type ?? (render ? undefined : "button")}
      {...mergeStyleProps(
        stylex.props(styles.root, variantStyles[variant], sizeStyles[size], xstyle),
        className,
        style,
      )}
      {...props}
    />
  );
}
