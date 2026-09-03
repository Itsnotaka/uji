/**
 * Desktop geometry schema. Components compose these named decisions instead
 * of growing their own almost-matching widths, insets, and row heights.
 * Runtime appearance belongs in CSS variables; structural geometry stays
 * static so StyleX can evaluate it once.
 *
 * Based on https://github.com/interfaces-lab/honk/blob/main/packages/app/src/workbench-layout.stylex.ts
 */
import * as stylex from "@stylexjs/stylex";

export const shell = stylex.defineConsts({
  titlebarHeight: "var(--uji-titlebar-height)",
});

export const conversation = stylex.defineConsts({
  measure: "var(--uji-conversation-measure)",
  proseMeasure: "var(--uji-prose-measure)",
  gutter: "var(--uji-conversation-gutter)",
  headerHeight: "var(--uji-conversation-header-height)",
  turnGap: "var(--uji-conversation-turn-gap)",
  rowGap: "var(--uji-conversation-row-gap)",
  rowMinHeight: "var(--uji-conversation-row-min-height)",
  composerInset: "var(--uji-composer-inset)",
});

export const sidebar = stylex.defineConsts({
  width: "var(--uji-sidebar-width)",
  handleWidth: "var(--uji-sidebar-handle-width)",
  rowHeight: "var(--uji-compact-row-height)",
  gutter: "var(--uji-sidebar-gutter)",
  rowPaddingInline: "var(--uji-sidebar-row-padding-inline)",
  sectionGap: "var(--uji-sidebar-section-gap)",
  listGap: "var(--uji-sidebar-list-gap)",
  iconSlot: "var(--uji-sidebar-icon-slot)",
  actionSize: "var(--uji-sidebar-action-size)",
  trailingWidth: "var(--uji-sidebar-trailing-width)",
});

export const workbench = stylex.defineConsts({
  railWidth: "var(--uji-workbench-rail-width)",
  panelWidth: "var(--uji-workbench-panel-width)",
  headerHeight: "var(--uji-workbench-header-height)",
  fileListWidth: "var(--uji-workbench-file-list-width)",
});

export const diffView = stylex.defineConsts({
  lineHeight: "var(--uji-diff-line-height)",
  previewMaxHeight: "var(--uji-diff-preview-max-height)",
});

export const control = stylex.defineConsts({
  compactHeight: "var(--uji-control-compact-height)",
  regularHeight: "var(--uji-control-regular-height)",
  menuWidth: "var(--uji-menu-width)",
  modelMenuWidth: "var(--uji-model-menu-width)",
  menuMaxHeight: "var(--uji-menu-max-height)",
  sectionGap: "var(--uji-section-gap)",
});
