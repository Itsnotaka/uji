/** Small shared controls, styled on the palette. */
import * as stylex from "@stylexjs/stylex";
import type { JSX, ReactElement, ReactNode } from "react";
import { t } from "../theme/vars.stylex.ts";
import { Icon, type IconName } from "./icons";

/**
 * Keyboard focus must be visible to navigate at all: `ring` for standalone
 * controls, `ringInset` for rows and menu items that sit flush inside a
 * scroll container or popover, where an outset ring would clip.
 */
export const focus = stylex.create({
  ring: {
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
    outlineColor: t.strokeFocused,
    outlineOffset: 1,
  },
  ringInset: {
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
    outlineColor: t.strokeFocused,
    outlineOffset: -2,
  },
});

const styles = stylex.create({
  buttonBase: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 28,
    paddingInline: 10,
    borderRadius: t.radiusLg,
    borderStyle: "none",
    fontSize: t.fontBase,
    fontWeight: 500,
    lineHeight: t.leadingBase,
    cursor: { default: "pointer", ":disabled": "default" },
    whiteSpace: "nowrap",
    userSelect: "none",
    transitionProperty: "background-color, color, opacity",
    transitionDuration: t.durationFast,
    transitionTimingFunction: t.easeOut,
  },
  primary: {
    color: t.textOnPrimary,
    backgroundColor: {
      default: t.fillPrimary,
      ":hover:not(:disabled)": t.fillPrimaryHover,
      ":disabled": t.fillPrimaryDisabled,
    },
  },
  secondary: {
    color: t.textPrimary,
    backgroundColor: {
      default: t.fillSecondary,
      ":hover:not(:disabled)": t.fillSecondaryHover,
    },
    opacity: { ":disabled": 0.5 },
  },
  ghost: {
    color: t.textSecondary,
    backgroundColor: {
      default: "transparent",
      ":hover:not(:disabled)": t.fillGhostHover,
    },
    opacity: { ":disabled": 0.5 },
  },
  danger: {
    color: t.textOnPrimary,
    backgroundColor: {
      default: t.fillDanger,
      ":hover:not(:disabled)": t.fillDangerHover,
    },
  },
  iconButton: {
    width: 28,
    paddingInline: 0,
    flexShrink: 0,
    color: t.iconSecondary,
  },
  statusDot: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 8,
    height: 8,
    borderRadius: t.radiusFull,
    flexShrink: 0,
    pointerEvents: "none",
  },
  statusWorking: {
    backgroundColor: t.fillAccent,
    animationName: stylex.keyframes({
      "0%": { opacity: 1 },
      "50%": { opacity: 0.35 },
      "100%": { opacity: 1 },
    }),
    animationDuration: "1.6s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
  statusIdle: { backgroundColor: t.borderStrong },
  kbd: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 17,
    height: 17,
    paddingInline: 4,
    borderRadius: t.radiusSm,
    backgroundColor: t.fillSecondary,
    color: t.textTertiary,
    fontSize: t.fontXs,
    fontFamily: t.fontSans,
  },
});

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends Omit<JSX.IntrinsicElements["button"], "className" | "style"> {
  variant?: ButtonVariant;
  icon?: IconName;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  icon,
  children,
  type = "button",
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button type={type} {...stylex.props(styles.buttonBase, focus.ring, styles[variant])} {...rest}>
      {icon !== undefined && <Icon name={icon} size={14} />}
      {children}
    </button>
  );
}

interface IconButtonProps extends Omit<JSX.IntrinsicElements["button"], "className" | "style"> {
  icon: IconName;
  label: string;
  size?: number;
}

export function IconButton({ icon, label, size = 15, ...rest }: IconButtonProps): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...stylex.props(styles.buttonBase, focus.ring, styles.ghost, styles.iconButton)}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

export function StatusDot({ working }: { working: boolean }): ReactElement {
  return (
    <span {...stylex.props(styles.statusDot, working ? styles.statusWorking : styles.statusIdle)} />
  );
}

export function Kbd({ children }: { children: ReactNode }): ReactElement {
  return <kbd {...stylex.props(styles.kbd)}>{children}</kbd>;
}

/** "2m ago" for lists; bare clock time within today. */
export function formatTimeAgo(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${String(days)}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
