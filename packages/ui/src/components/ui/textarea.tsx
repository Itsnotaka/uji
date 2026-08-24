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
    boxSizing: "border-box",
    display: "block",
    width: "100%",
    minHeight: controlVars["--uji-control-textarea-min-height"],
    paddingInline: controlVars["--uji-control-padding-lg"],
    paddingBlock: controlVars["--uji-control-padding-sm"],
    resize: "vertical",
    borderWidth: borderVars["--uji-border-control-width"],
    borderStyle: "solid",
    borderColor: {
      default: colorVars["--uji-color-border"],
      ":focus-visible": colorVars["--uji-color-ring"],
      "[aria-invalid=true]": colorVars["--uji-color-destructive"],
    },
    borderRadius: radiusVars["--uji-radius-field"],
    backgroundColor: colorVars["--uji-color-field-background"],
    boxShadow: {
      default: "none",
      ":focus-visible": `0 0 0 2px ${colorVars["--uji-color-ring"]}`,
    },
    color: colorVars["--uji-color-foreground"],
    fontFamily: fontVars["--uji-font-family-ui"],
    fontSize: fontVars["--uji-font-size-body"],
    fontWeight: fontVars["--uji-font-weight-regular"],
    lineHeight: fontVars["--uji-leading-body"],
    outlineStyle: "none",
    opacity: { default: 1, ":disabled": controlVars["--uji-control-disabled-opacity"] },
    transitionProperty: "background-color, border-color, outline-color, opacity",
    transitionDuration: {
      default: motionVars["--uji-motion-fast"],
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    "::placeholder": { color: colorVars["--uji-color-muted-foreground"] },
  },
});

export interface TextareaProps extends Omit<
  React.ComponentProps<"textarea">,
  "className" | "style"
> {
  className?: string;
  style?: React.CSSProperties;
  xstyle?: XStyle;
}

export function Textarea({ className, style, xstyle, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      {...mergeStyleProps(stylex.props(styles.root, xstyle), className, style)}
      {...props}
    />
  );
}
