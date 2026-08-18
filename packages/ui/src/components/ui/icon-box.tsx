import * as stylex from "@stylexjs/stylex";
import { cloneElement, type ComponentProps, type ReactElement } from "react";

import { mergeStyleProps, type XStyle } from "@june/ui/style";

const styles = stylex.create({
  root: {
    display: "inline-grid",
    width: "16px",
    height: "16px",
    flexShrink: 0,
    placeItems: "center",
    lineHeight: 0,
  },
});

export type IconGlyphSize = 12 | 14;

export interface IconBoxProps extends Omit<ComponentProps<"span">, "children"> {
  children: ReactElement<{ size?: number }>;
  glyphSize?: IconGlyphSize;
  xstyle?: XStyle;
}

export function IconBox({
  "aria-hidden": ariaHidden = true,
  children,
  className,
  glyphSize = 14,
  style,
  xstyle,
  ...props
}: IconBoxProps) {
  return (
    <span
      aria-hidden={ariaHidden}
      data-slot="icon-box"
      {...mergeStyleProps(stylex.props(styles.root, xstyle), className, style)}
      {...props}
    >
      {cloneElement(children, { size: glyphSize })}
    </span>
  );
}
