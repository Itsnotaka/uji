/**
 * Typed handles on the palette in `tokens.css`. A real `defineVars` in a
 * `.stylex.ts` file, because StyleX only statically evaluates imports that
 * follow its theming convention; each generated var simply points at the
 * hand-authored palette var, so `data-theme` switching stays in tokens.css
 * and a token rename here is a compile error in every rule that names it.
 */
import * as stylex from "@stylexjs/stylex";

export const t = stylex.defineVars({
  // text
  textPrimary: "var(--cursor-text-primary)",
  textSecondary: "var(--cursor-text-secondary)",
  textTertiary: "var(--cursor-text-tertiary)",
  textQuaternary: "var(--cursor-text-quaternary)",
  textInvert: "var(--cursor-text-invert)",
  textAccent: "var(--sand-text-accent)",
  textSuccess: "var(--sand-text-success)",
  textWarning: "var(--sand-text-warning)",
  textDanger: "var(--sand-text-danger)",
  textOnPrimary: "var(--sand-text-on-primary)",
  textOnColor: "var(--sand-text-on-color)",
  textDisabled: "var(--sand-text-disabled)",
  shimmerBase: "var(--sand-text-shimmer-base)",
  shimmerHighlight: "var(--sand-text-shimmer-highlight)",

  // icons
  iconPrimary: "var(--cursor-icon-primary)",
  iconSecondary: "var(--cursor-icon-secondary)",
  iconTertiary: "var(--cursor-icon-tertiary)",

  // surfaces
  bgBase: "var(--sand-bg-base)",
  bgSubtle: "var(--sand-bg-subtle)",
  bgElevated: "var(--sand-bg-elevated)",
  bgScrim: "var(--sand-bg-scrim)",
  bgChrome: "var(--cursor-bg-chrome)",
  bgEditor: "var(--cursor-bg-editor)",
  bgCard: "var(--cursor-bg-card)",
  bgHover: "var(--cursor-bg-tertiary)",
  bgActive: "var(--cursor-bg-secondary)",
  bgFaint: "var(--cursor-bg-quinary)",

  // fills
  fillPrimary: "var(--sand-fill-primary)",
  fillPrimaryHover: "var(--sand-fill-primary-hover)",
  fillPrimaryDisabled: "var(--sand-fill-primary-disabled)",
  fillSecondary: "var(--sand-fill-secondary)",
  fillSecondaryHover: "var(--sand-fill-secondary-hover)",
  fillGhostHover: "var(--sand-fill-ghost-hover)",
  fillGhostSelected: "var(--sand-fill-ghost-selected)",
  fillElevated: "var(--sand-fill-elevated)",
  fillBubbleAgent: "var(--sand-fill-bubble-agent)",
  fillBubbleUser: "var(--sand-fill-bubble-user)",
  fillAccent: "var(--sand-fill-accent)",
  fillAccentHover: "var(--sand-fill-accent-hover)",
  fillAccentSubtle: "var(--sand-fill-accent-subtle)",
  fillSuccess: "var(--sand-fill-success)",
  fillSuccessSubtle: "var(--sand-fill-success-subtle)",
  fillWarning: "var(--sand-fill-warning)",
  fillWarningSubtle: "var(--sand-fill-warning-subtle)",
  fillDanger: "var(--sand-fill-danger)",
  fillDangerHover: "var(--sand-fill-danger-hover)",
  fillDangerSubtle: "var(--sand-fill-danger-subtle)",

  // borders
  borderSubtle: "var(--sand-border-subtle)",
  borderWeak: "var(--sand-border-weak)",
  borderDefault: "var(--sand-border-default)",
  borderStrong: "var(--sand-border-strong)",
  borderFocus: "var(--sand-border-focus)",
  borderAccent: "var(--sand-border-accent)",
  strokePrimary: "var(--cursor-stroke-primary)",
  strokeSecondary: "var(--cursor-stroke-secondary)",
  strokeTertiary: "var(--cursor-stroke-tertiary)",
  strokeFocused: "var(--cursor-stroke-focused)",

  // status colors
  accent: "var(--cursor-accent)",
  success: "var(--cursor-success)",
  warn: "var(--cursor-warn)",
  danger: "var(--cursor-danger)",
  added: "var(--cursor-added)",
  removed: "var(--cursor-removed)",
  red: "var(--cursor-red)",
  green: "var(--cursor-green)",
  yellow: "var(--cursor-yellow)",
  orange: "var(--cursor-orange)",
  purple: "var(--cursor-purple)",
  cyan: "var(--cursor-cyan)",
  magenta: "var(--cursor-magenta)",
  diffAddedLineBg: "var(--cursor-diff-added-line-background)",
  diffAddedTextBg: "var(--cursor-diff-added-text-background)",
  diffRemovedLineBg: "var(--cursor-diff-removed-line-background)",
  diffRemovedTextBg: "var(--cursor-diff-removed-text-background)",

  // conversation
  conversationUserBg: "var(--uji-conversation-user-background)",
  conversationUserRing: "var(--uji-conversation-user-ring)",
  conversationTechnicalBg: "var(--uji-conversation-technical-background)",
  conversationTechnicalRing: "var(--uji-conversation-technical-ring)",
  conversationGuide: "var(--uji-conversation-guide)",
  conversationErrorBg: "var(--uji-conversation-error-background)",
  conversationErrorRing: "var(--uji-conversation-error-ring)",
  composerBg: "var(--uji-composer-background)",
  composerRing: "var(--uji-composer-ring)",
  composerRingActive: "var(--uji-composer-ring-active)",
  composerShadow: "var(--uji-composer-shadow)",

  // shadows
  shadowControlColor: "var(--sand-shadow-control)",
  shadowPopover: "var(--sand-shadow-popover)",
  shadowModal: "var(--sand-shadow-modal)",

  // type
  fontSans: "var(--cursor-font-family-sans)",
  fontMono: "var(--cursor-font-family-mono)",
  fontXs: "var(--cursor-font-size-xs)",
  fontSm: "var(--cursor-font-size-sm)",
  fontBase: "var(--cursor-font-size-base)",
  fontLg: "var(--cursor-font-size-lg)",
  fontCode: "var(--cursor-font-size-code)",
  leadingXs: "var(--cursor-line-height-xs)",
  leadingSm: "var(--cursor-line-height-sm)",
  leadingBase: "var(--cursor-line-height-base)",
  leadingLg: "var(--cursor-line-height-lg)",

  // geometry
  radiusXs: "var(--cursor-radius-xs)",
  radiusSm: "var(--cursor-radius-sm)",
  radiusBase: "var(--cursor-radius-base)",
  radiusLg: "var(--cursor-radius-lg)",
  radiusXl: "var(--cursor-radius-xl)",
  radius2xl: "var(--cursor-radius-2xl)",
  radius3xl: "var(--cursor-radius-3xl)",
  radiusFull: "var(--cursor-radius-full)",

  // motion
  durationInstant: "var(--cursor-duration-instant)",
  durationFast: "var(--cursor-duration-fast)",
  durationNormal: "var(--cursor-duration-normal)",
  durationSlow: "var(--cursor-duration-slow)",
  easeOut: "var(--cursor-easing-out)",
  easeOutQuint: "var(--cursor-easing-out-quint)",

  // scrollbar
  scrollbarThumb: "var(--cursor-scrollbar-thumb)",
  scrollbarThumbHover: "var(--cursor-scrollbar-thumb-hover)",
});
