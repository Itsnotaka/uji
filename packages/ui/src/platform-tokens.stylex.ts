import * as stylex from "@stylexjs/stylex";

export const colorDefaults = {
  "--june-color-background": "light-dark(#fdfdfc, #090a0b)",
  "--june-color-foreground": "light-dark(#141414, #fcfcfc)",
  "--june-color-popover": "light-dark(#ffffff, #24272e)",
  "--june-color-popover-foreground": "light-dark(#141414, #fcfcfc)",
  "--june-color-primary": "light-dark(#0a0a0a, #fafafa)",
  "--june-color-primary-hover": "light-dark(#2f2f2f, #d5d5d5)",
  "--june-color-primary-foreground": "light-dark(#fcfcfc, #141414)",
  "--june-color-muted": "light-dark(#77777717, #7777772c)",
  "--june-color-muted-hover": "light-dark(#7777772b, #77777752)",
  "--june-color-muted-foreground": "light-dark(#14141499, #fcfcfc99)",
  "--june-color-tertiary-foreground": "light-dark(#14141496, #fcfcfc7c)",
  "--june-color-destructive": "light-dark(#c21d2e, #ff8c98)",
  "--june-color-destructive-muted": "light-dark(#ff263c17, #ff263c2c)",
  "--june-color-destructive-hover": "light-dark(#ff263c2b, #ff263c52)",
  "--june-color-warning": "light-dark(#c27400, #ffc878)",
  "--june-color-border-weak": "light-dark(#1414141a, #fcfcfc1a)",
  "--june-color-border": "light-dark(#14141426, #fcfcfc26)",
  "--june-color-border-strong": "light-dark(#14141440, #fcfcfc40)",
  "--june-color-field-background": "light-dark(#ffffff, #191c1f)",
  "--june-color-field-disabled": "light-dark(#f4f3f0, #121416)",
  "--june-color-ring": "light-dark(#1414148c, #fcfcfc80)",
  "--june-color-scrim": "light-dark(#14141459, #05070ab3)",
  "--june-color-sidebar": "light-dark(#f8f7f5, #121417)",
  "--june-color-bubble-agent": "light-dark(#f2f1ee, #1b1d22)",
  "--june-color-bubble-user": "light-dark(#0a0a0a, #3d444c)",
  "--june-color-bubble-user-foreground": "light-dark(#fcfcfc, #fcfcfc)",
  "--june-color-avatar-background": "light-dark(#77777717, #7777772c)",
  "--june-color-avatar-foreground": "light-dark(#3d3d3d, #b7b7b7)",
  "--june-color-avatar-solid-foreground": "light-dark(#fcfcfc, #0a0a0a)",
  "--june-color-avatar-neutral-solid": "light-dark(#141414, #fafafa)",
  "--june-color-avatar-orange-background": "light-dark(#ff670017, #ff67002c)",
  "--june-color-avatar-orange-foreground": "light-dark(#b34800, #ffae78)",
  "--june-color-avatar-orange-solid": "light-dark(#b84a00, #ff9450)",
  "--june-color-avatar-blue-background": "light-dark(#1084fe17, #1084fe2c)",
  "--june-color-avatar-blue-foreground": "light-dark(#0c64c1, #80befe)",
  "--june-color-avatar-blue-solid": "light-dark(#0c64c1, #5fadfe)",
  "--june-color-avatar-violet-background": "light-dark(#9159fe17, #9159fe2c)",
  "--june-color-avatar-violet-foreground": "light-dark(#6e44c1, #c5a7fe)",
  "--june-color-avatar-violet-solid": "light-dark(#7b4ed6, #bb9bfe)",
  "--june-color-avatar-green-background": "light-dark(#00c97217, #00c9722c)",
  "--june-color-avatar-green-foreground": "light-dark(#007a46, #78e2b4)",
  "--june-color-avatar-green-solid": "light-dark(#007a46, #00c972)",
} as const;

export const fontDefaults = {
  "--june-font-family-ui": '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "--june-font-size-caption": "10px",
  "--june-font-size-detail": "12px",
  "--june-font-size-label": "13px",
  "--june-font-size-body": "14px",
  "--june-font-size-title": "16px",
  "--june-font-weight-regular": 420,
  "--june-font-weight-medium": 500,
  "--june-font-weight-semibold": 600,
  "--june-leading-caption": "14px",
  "--june-leading-detail": "16px",
  "--june-leading-label": "18px",
  "--june-leading-body": "20px",
  "--june-leading-title": "22px",
} as const;

export const radiusDefaults = {
  "--june-radius-control": "8px",
  "--june-radius-field": "8px",
  "--june-radius-menu": "10px",
  "--june-radius-dialog": "14px",
  "--june-radius-avatar": "42%",
  "--june-radius-pill": "9999px",
} as const;

export const controlDefaults = {
  "--june-control-height-xs": "24px",
  "--june-control-height-sm": "28px",
  "--june-control-height-md": "32px",
  "--june-control-height-lg": "36px",
  "--june-control-height-xl": "44px",
  "--june-control-textarea-min-height": "64px",
  "--june-control-textarea-max-height": "120px",
  "--june-control-textarea-compact-padding": "11px",
  "--june-control-padding-xs": "6px",
  "--june-control-padding-sm": "8px",
  "--june-control-padding-md": "10px",
  "--june-control-padding-lg": "12px",
  "--june-control-menu-inset": "28px",
  "--june-control-gap-sm": "4px",
  "--june-control-gap-md": "6px",
  "--june-control-disabled-opacity": 0.5,
  "--june-control-focus-width": "2px",
  "--june-control-focus-offset": "2px",
} as const;

export const borderDefaults = {
  "--june-border-control-width": "1px",
  "--june-border-hairline-width": ".5px",
} as const;

export const avatarDefaults = {
  "--june-avatar-size-xs": "20px",
  "--june-avatar-size-sm": "24px",
  "--june-avatar-size-md": "36px",
  "--june-avatar-size-lg": "72px",
  "--june-avatar-font-xs": "9px",
  "--june-avatar-font-sm": "10px",
  "--june-avatar-font-md": "14px",
  "--june-avatar-font-lg": "24px",
  "--june-avatar-ring-width": ".5px",
} as const;

export const spaceDefaults = {
  "--june-space-1": "4px",
  "--june-space-2": "8px",
  "--june-space-3": "12px",
  "--june-space-4": "16px",
} as const;

export const motionDefaults = {
  "--june-motion-fast": "100ms",
  "--june-motion-normal": "160ms",
  "--june-motion-ease-out": "cubic-bezier(.2,.8,.2,1)",
} as const;

export const elevationDefaults = {
  "--june-elevation-field":
    "0 1px 2px light-dark(#1414140a, #00000040), 0 4px 12px -6px light-dark(#14141414, #00000059)",
  "--june-elevation-menu":
    "0 2px 6px -2px light-dark(#14141414, #0000006b), 0 10px 28px -8px light-dark(#14141426, #000000a6)",
  "--june-elevation-dialog":
    "0 4px 10px -4px light-dark(#1414141f, #0000008f), 0 24px 56px -16px light-dark(#14141433, #000000cc)",
} as const;

export const overlayDefaults = {
  "--june-dialog-width": "calc(100% - 32px)",
  "--june-dialog-max-width": "384px",
  "--june-dialog-max-height": "calc(100dvh - 32px)",
  "--june-menu-min-width": "128px",
  "--june-menu-max-width": "var(--available-width)",
  "--june-menu-max-height": "var(--available-height)",
  "--june-layer-dialog": 50,
  "--june-layer-menu": 60,
} as const;

export const colorVars = stylex.defineVars(colorDefaults);
export const fontVars = stylex.defineVars(fontDefaults);
export const radiusVars = stylex.defineVars(radiusDefaults);
export const controlVars = stylex.defineVars(controlDefaults);
export const borderVars = stylex.defineVars(borderDefaults);
export const avatarVars = stylex.defineVars(avatarDefaults);
export const spaceVars = stylex.defineVars(spaceDefaults);
export const motionVars = stylex.defineVars(motionDefaults);
export const elevationVars = stylex.defineVars(elevationDefaults);
export const overlayVars = stylex.defineVars(overlayDefaults);

export type ColorVarName = keyof typeof colorDefaults;
export type FontVarName = keyof typeof fontDefaults;
export type RadiusVarName = keyof typeof radiusDefaults;
export type ControlVarName = keyof typeof controlDefaults;
export type BorderVarName = keyof typeof borderDefaults;
export type AvatarVarName = keyof typeof avatarDefaults;
export type SpaceVarName = keyof typeof spaceDefaults;
export type MotionVarName = keyof typeof motionDefaults;
export type ElevationVarName = keyof typeof elevationDefaults;
export type OverlayVarName = keyof typeof overlayDefaults;
