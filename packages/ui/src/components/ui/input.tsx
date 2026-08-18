import { Input as InputPrimitive } from "@base-ui/react/input";
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
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    height: controlVars["--june-control-height-md"],
    paddingInline: controlVars["--june-control-padding-md"],
    paddingBlock: controlVars["--june-control-padding-xs"],
    borderWidth: borderVars["--june-border-control-width"],
    borderStyle: "solid",
    borderColor: {
      default: colorVars["--june-color-border"],
      ":focus-visible": colorVars["--june-color-ring"],
      "[aria-invalid=true]": colorVars["--june-color-destructive"],
    },
    borderRadius: radiusVars["--june-radius-field"],
    backgroundColor: {
      default: colorVars["--june-color-field-background"],
      ":disabled": colorVars["--june-color-field-disabled"],
    },
    color: colorVars["--june-color-foreground"],
    fontFamily: fontVars["--june-font-family-ui"],
    fontSize: fontVars["--june-font-size-body"],
    fontWeight: fontVars["--june-font-weight-regular"],
    lineHeight: fontVars["--june-leading-body"],
    outlineColor: colorVars["--june-color-ring"],
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: controlVars["--june-control-focus-width"],
    outlineOffset: controlVars["--june-control-focus-offset"],
    opacity: { default: 1, ":disabled": controlVars["--june-control-disabled-opacity"] },
    transitionProperty: "background-color, border-color, outline-color, opacity",
    transitionDuration: {
      default: motionVars["--june-motion-fast"],
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    "::placeholder": { color: colorVars["--june-color-muted-foreground"] },
  },
});

export interface InputProps extends Omit<InputPrimitive.Props, "className" | "style"> {
  className?: string;
  style?: React.CSSProperties;
  xstyle?: XStyle;
}

export function Input({ className, style, xstyle, ...props }: InputProps) {
  return (
    <InputPrimitive
      data-slot="input"
      {...mergeStyleProps(stylex.props(styles.root, xstyle), className, style)}
      {...props}
    />
  );
}
