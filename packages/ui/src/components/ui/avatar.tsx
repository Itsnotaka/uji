import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import * as stylex from "@stylexjs/stylex";
import type * as React from "react";

import { mergeStyleProps, type XStyle } from "@june/ui/style";
import { avatarVars, colorVars, fontVars, radiusVars } from "@june/ui/tokens.stylex";

const styles = stylex.create({
  root: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    overflow: "hidden",
    boxSizing: "border-box",
    borderWidth: avatarVars["--june-avatar-ring-width"],
    borderStyle: "solid",
    borderColor: colorVars["--june-color-border"],
    backgroundColor: colorVars["--june-color-avatar-background"],
    color: colorVars["--june-color-avatar-foreground"],
    fontFamily: fontVars["--june-font-family-ui"],
    fontWeight: fontVars["--june-font-weight-semibold"],
    lineHeight: 1,
    userSelect: "none",
  },
  image: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    borderRadius: "inherit",
  },
  fallback: {
    display: "flex",
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "inherit",
    backgroundColor: "inherit",
    color: "inherit",
    font: "inherit",
  },
});

const sizeStyles = stylex.create({
  xs: {
    width: avatarVars["--june-avatar-size-xs"],
    height: avatarVars["--june-avatar-size-xs"],
    fontSize: avatarVars["--june-avatar-font-xs"],
  },
  sm: {
    width: avatarVars["--june-avatar-size-sm"],
    height: avatarVars["--june-avatar-size-sm"],
    fontSize: avatarVars["--june-avatar-font-sm"],
  },
  md: {
    width: avatarVars["--june-avatar-size-md"],
    height: avatarVars["--june-avatar-size-md"],
    fontSize: avatarVars["--june-avatar-font-md"],
  },
  lg: {
    width: avatarVars["--june-avatar-size-lg"],
    height: avatarVars["--june-avatar-size-lg"],
    fontSize: avatarVars["--june-avatar-font-lg"],
  },
});

const shapeStyles = stylex.create({
  circle: { borderRadius: radiusVars["--june-radius-pill"] },
  rounded: { borderRadius: radiusVars["--june-radius-avatar"] },
});

const toneStyles = stylex.create({
  neutral: {
    backgroundColor: colorVars["--june-color-avatar-background"],
    color: colorVars["--june-color-avatar-foreground"],
  },
  orange: {
    backgroundColor: colorVars["--june-color-avatar-orange-background"],
    color: colorVars["--june-color-avatar-orange-foreground"],
  },
  blue: {
    backgroundColor: colorVars["--june-color-avatar-blue-background"],
    color: colorVars["--june-color-avatar-blue-foreground"],
  },
  violet: {
    backgroundColor: colorVars["--june-color-avatar-violet-background"],
    color: colorVars["--june-color-avatar-violet-foreground"],
  },
  green: {
    backgroundColor: colorVars["--june-color-avatar-green-background"],
    color: colorVars["--june-color-avatar-green-foreground"],
  },
});

export type AvatarSize = keyof typeof sizeStyles;
export type AvatarShape = keyof typeof shapeStyles;
export type AvatarTone = keyof typeof toneStyles;

export interface AvatarProps extends Omit<AvatarPrimitive.Root.Props, "className" | "style"> {
  className?: string;
  shape?: AvatarShape;
  size?: AvatarSize;
  tone?: AvatarTone;
  style?: React.CSSProperties;
  xstyle?: XStyle;
}

export function Avatar({
  className,
  shape = "circle",
  size = "md",
  tone = "neutral",
  style,
  xstyle,
  ...props
}: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      {...mergeStyleProps(
        stylex.props(styles.root, sizeStyles[size], shapeStyles[shape], toneStyles[tone], xstyle),
        className,
        style,
      )}
      {...props}
    />
  );
}

export interface AvatarImageProps extends Omit<AvatarPrimitive.Image.Props, "className" | "style"> {
  className?: string;
  style?: React.CSSProperties;
  xstyle?: XStyle;
}

export function AvatarImage({ className, style, xstyle, ...props }: AvatarImageProps) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      {...mergeStyleProps(stylex.props(styles.image, xstyle), className, style)}
      {...props}
    />
  );
}

export interface AvatarFallbackProps extends Omit<
  AvatarPrimitive.Fallback.Props,
  "className" | "style"
> {
  className?: string;
  style?: React.CSSProperties;
  xstyle?: XStyle;
}

export function AvatarFallback({ className, style, xstyle, ...props }: AvatarFallbackProps) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      {...mergeStyleProps(stylex.props(styles.fallback, xstyle), className, style)}
      {...props}
    />
  );
}
