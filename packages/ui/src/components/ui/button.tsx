import { Button as ButtonPrimitive } from "@base-ui/react/button";
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
} from "@june/ui/tokens.stylex";

const styles = stylex.create({
  root: {
    appearance: "none",
    boxSizing: "border-box",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    gap: controlVars["--june-control-gap-md"],
    borderWidth: borderVars["--june-border-control-width"],
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radiusVars["--june-radius-control"],
    fontFamily: fontVars["--june-font-family-ui"],
    fontWeight: fontVars["--june-font-weight-medium"],
    lineHeight: 1,
    whiteSpace: "nowrap",
    textDecoration: "none",
    userSelect: "none",
    outlineColor: colorVars["--june-color-ring"],
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: controlVars["--june-control-focus-width"],
    outlineOffset: controlVars["--june-control-focus-offset"],
    opacity: {
      default: 1,
      ":disabled": controlVars["--june-control-disabled-opacity"],
      "[data-disabled]": controlVars["--june-control-disabled-opacity"],
    },
    pointerEvents: { default: "auto", ":disabled": "none", "[data-disabled]": "none" },
    transitionProperty: "background-color, border-color, color, opacity",
    transitionDuration: {
      default: motionVars["--june-motion-fast"],
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    transitionTimingFunction: motionVars["--june-motion-ease-out"],
  },
  default: {
    backgroundColor: {
      default: colorVars["--june-color-primary"],
      ":hover": { "@media (hover: hover)": colorVars["--june-color-primary-hover"] },
      "[data-popup-open]": colorVars["--june-color-primary-hover"],
    },
    color: colorVars["--june-color-primary-foreground"],
  },
  outline: {
    borderColor: {
      default: colorVars["--june-color-border"],
      ":hover": { "@media (hover: hover)": colorVars["--june-color-border-strong"] },
    },
    backgroundColor: {
      default: "transparent",
      ":hover": { "@media (hover: hover)": colorVars["--june-color-muted"] },
      "[data-popup-open]": colorVars["--june-color-muted"],
    },
    color: colorVars["--june-color-foreground"],
  },
  secondary: {
    backgroundColor: {
      default: colorVars["--june-color-muted"],
      ":hover": { "@media (hover: hover)": colorVars["--june-color-muted-hover"] },
      "[data-popup-open]": colorVars["--june-color-muted-hover"],
    },
    color: colorVars["--june-color-foreground"],
  },
  ghost: {
    backgroundColor: {
      default: "transparent",
      ":hover": { "@media (hover: hover)": colorVars["--june-color-muted-hover"] },
      "[data-popup-open]": colorVars["--june-color-muted-hover"],
    },
    color: colorVars["--june-color-foreground"],
  },
  destructive: {
    backgroundColor: {
      default: colorVars["--june-color-destructive-muted"],
      ":hover": { "@media (hover: hover)": colorVars["--june-color-destructive-hover"] },
      "[data-popup-open]": colorVars["--june-color-destructive-hover"],
    },
    color: colorVars["--june-color-destructive"],
  },
  link: {
    borderColor: "transparent",
    backgroundColor: "transparent",
    color: colorVars["--june-color-primary"],
    textDecorationLine: { default: "none", ":hover": "underline" },
    textUnderlineOffset: "4px",
  },
  defaultSize: {
    height: controlVars["--june-control-height-md"],
    paddingInline: controlVars["--june-control-padding-md"],
    fontSize: fontVars["--june-font-size-body"],
  },
  xs: {
    height: controlVars["--june-control-height-xs"],
    paddingInline: controlVars["--june-control-padding-sm"],
    gap: controlVars["--june-control-gap-sm"],
    fontSize: fontVars["--june-font-size-detail"],
  },
  sm: {
    height: controlVars["--june-control-height-sm"],
    paddingInline: controlVars["--june-control-padding-md"],
    gap: controlVars["--june-control-gap-sm"],
    fontSize: fontVars["--june-font-size-detail"],
  },
  lg: {
    height: controlVars["--june-control-height-lg"],
    paddingInline: controlVars["--june-control-padding-lg"],
    fontSize: fontVars["--june-font-size-body"],
  },
  icon: {
    width: controlVars["--june-control-height-md"],
    height: controlVars["--june-control-height-md"],
    paddingInline: 0,
  },
  iconXs: {
    width: controlVars["--june-control-height-xs"],
    height: controlVars["--june-control-height-xs"],
    paddingInline: 0,
  },
  iconSm: {
    width: controlVars["--june-control-height-sm"],
    height: controlVars["--june-control-height-sm"],
    paddingInline: 0,
  },
  iconLg: {
    width: controlVars["--june-control-height-lg"],
    height: controlVars["--june-control-height-lg"],
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
