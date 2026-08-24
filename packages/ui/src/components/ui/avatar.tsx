import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import * as stylex from "@stylexjs/stylex";
import type * as React from "react";

import { mergeStyleProps, type XStyle } from "@uji-ai/ui/style";
import { avatarVars, colorVars, fontVars, motionVars, radiusVars } from "@uji-ai/ui/tokens.stylex";

const styles = stylex.create({
  root: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    overflow: "hidden",
    boxSizing: "border-box",
    borderWidth: avatarVars["--uji-avatar-ring-width"],
    borderStyle: "solid",
    borderColor: colorVars["--uji-color-border"],
    backgroundColor: colorVars["--uji-color-avatar-background"],
    color: colorVars["--uji-color-avatar-foreground"],
    fontFamily: fontVars["--uji-font-family-ui"],
    fontWeight: fontVars["--uji-font-weight-semibold"],
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
    width: avatarVars["--uji-avatar-size-xs"],
    height: avatarVars["--uji-avatar-size-xs"],
    fontSize: avatarVars["--uji-avatar-font-xs"],
  },
  sm: {
    width: avatarVars["--uji-avatar-size-sm"],
    height: avatarVars["--uji-avatar-size-sm"],
    fontSize: avatarVars["--uji-avatar-font-sm"],
  },
  md: {
    width: avatarVars["--uji-avatar-size-md"],
    height: avatarVars["--uji-avatar-size-md"],
    fontSize: avatarVars["--uji-avatar-font-md"],
  },
  lg: {
    width: avatarVars["--uji-avatar-size-lg"],
    height: avatarVars["--uji-avatar-size-lg"],
    fontSize: avatarVars["--uji-avatar-font-lg"],
  },
});

const shapeStyles = stylex.create({
  circle: { borderRadius: radiusVars["--uji-radius-pill"] },
  rounded: { borderRadius: radiusVars["--uji-radius-avatar"] },
});

const toneStyles = stylex.create({
  neutral: {
    backgroundColor: colorVars["--uji-color-avatar-background"],
    color: colorVars["--uji-color-avatar-foreground"],
  },
  orange: {
    backgroundColor: colorVars["--uji-color-avatar-orange-background"],
    color: colorVars["--uji-color-avatar-orange-foreground"],
  },
  blue: {
    backgroundColor: colorVars["--uji-color-avatar-blue-background"],
    color: colorVars["--uji-color-avatar-blue-foreground"],
  },
  violet: {
    backgroundColor: colorVars["--uji-color-avatar-violet-background"],
    color: colorVars["--uji-color-avatar-violet-foreground"],
  },
  green: {
    backgroundColor: colorVars["--uji-color-avatar-green-background"],
    color: colorVars["--uji-color-avatar-green-foreground"],
  },
});

const solidToneStyles = stylex.create({
  neutral: {
    borderColor: "transparent",
    backgroundColor: colorVars["--uji-color-avatar-neutral-solid"],
    color: colorVars["--uji-color-avatar-solid-foreground"],
  },
  orange: {
    borderColor: "transparent",
    backgroundColor: colorVars["--uji-color-avatar-orange-solid"],
    color: colorVars["--uji-color-avatar-solid-foreground"],
  },
  blue: {
    borderColor: "transparent",
    backgroundColor: colorVars["--uji-color-avatar-blue-solid"],
    color: colorVars["--uji-color-avatar-solid-foreground"],
  },
  violet: {
    borderColor: "transparent",
    backgroundColor: colorVars["--uji-color-avatar-violet-solid"],
    color: colorVars["--uji-color-avatar-solid-foreground"],
  },
  green: {
    borderColor: "transparent",
    backgroundColor: colorVars["--uji-color-avatar-green-solid"],
    color: colorVars["--uji-color-avatar-solid-foreground"],
  },
});

const interactiveStyles = stylex.create({
  // Tints the fill with its own on-fill text color, so hover lifts a dark fill and
  // deepens a light one without a per-tone hover token.
  hover: {
    // The inset tint is clipped to the padding box, so a border would keep an untinted
    // 1px rim around the fill. Tone fills draw no border anyway.
    borderWidth: 0,
    boxShadow: {
      default: "none",
      ":hover": {
        "@media (hover: hover)":
          "inset 0 0 0 100vmax color-mix(in oklab, currentcolor 12%, transparent)",
      },
    },
    // Repeats Button's transition list: this style is applied last, so a bare
    // "box-shadow" would drop the host's own transitions.
    transitionProperty: "box-shadow, background-color, border-color, color, opacity",
    transitionDuration: {
      default: motionVars["--uji-motion-fast"],
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    transitionTimingFunction: motionVars["--uji-motion-ease-out"],
  },
});

export type AvatarSize = keyof typeof sizeStyles;
export type AvatarShape = keyof typeof shapeStyles;
export type AvatarTone = keyof typeof toneStyles;
export type AvatarVariant = "soft" | "solid";

const variantToneStyles = { soft: toneStyles, solid: solidToneStyles } as const;

/**
 * Tone fill plus its on-fill text color, for interactive surfaces that carry agent
 * identity (the composer send button). Static surfaces use `<Avatar variant="solid">`.
 */
export const avatarToneSolid: Record<AvatarTone, XStyle> = {
  neutral: [solidToneStyles.neutral, interactiveStyles.hover],
  orange: [solidToneStyles.orange, interactiveStyles.hover],
  blue: [solidToneStyles.blue, interactiveStyles.hover],
  violet: [solidToneStyles.violet, interactiveStyles.hover],
  green: [solidToneStyles.green, interactiveStyles.hover],
};

export interface AvatarProps extends Omit<AvatarPrimitive.Root.Props, "className" | "style"> {
  className?: string;
  shape?: AvatarShape;
  size?: AvatarSize;
  tone?: AvatarTone;
  style?: React.CSSProperties;
  variant?: AvatarVariant;
  xstyle?: XStyle;
}

export function Avatar({
  className,
  shape = "circle",
  size = "md",
  tone = "neutral",
  style,
  variant = "soft",
  xstyle,
  ...props
}: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      data-tone={tone}
      data-variant={variant}
      {...mergeStyleProps(
        stylex.props(
          styles.root,
          sizeStyles[size],
          shapeStyles[shape],
          variantToneStyles[variant][tone],
          xstyle,
        ),
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
