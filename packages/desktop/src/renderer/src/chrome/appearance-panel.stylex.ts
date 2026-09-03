/**
 * Appearance panel feature styles.
 * Based on https://github.com/interfaces-lab/honk/blob/main/packages/app/src/settings-appearance.tsx
 */
import * as stylex from "@stylexjs/stylex";
import { control } from "../theme/schema.stylex.ts";
import { t } from "../theme/vars.stylex.ts";

export const appearancePanelStyles = stylex.create({
  root: { paddingBlock: 18 },
  section: { paddingBlockEnd: 36 },
  fields: { display: "flex", flexDirection: "column", gap: 2 },
  field: {
    display: "grid",
    gridTemplateColumns: "minmax(120px, 1fr) minmax(180px, 240px)",
    alignItems: "center",
    gap: 16,
    minHeight: 42,
  },
  fieldLabel: { color: t.textSecondary, fontSize: t.fontBase },
  select: {
    width: "100%",
    height: control.regularHeight,
    paddingInline: 9,
    borderRadius: t.radiusLg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: t.borderWeak,
    backgroundColor: t.bgBase,
    color: t.textPrimary,
    fontSize: t.fontBase,
    outline: "none",
  },
  rangeWrap: { display: "flex", alignItems: "center", gap: 10 },
  range: { flex: 1, accentColor: t.accent },
  rangeValue: {
    width: 28,
    color: t.textSecondary,
    fontFamily: t.fontMono,
    fontSize: t.fontCode,
    textAlign: "right",
  },
  switchButton: {
    justifySelf: "end",
    display: "inline-flex",
    alignItems: "center",
    width: 32,
    height: 18,
    padding: 2,
    borderRadius: t.radiusFull,
    borderStyle: "none",
    backgroundColor: t.fillSecondary,
    cursor: "pointer",
  },
  switchOn: { backgroundColor: t.fillPrimary },
  switchKnob: {
    width: 14,
    height: 14,
    borderRadius: t.radiusFull,
    backgroundColor: t.bgElevated,
    boxShadow: `0 1px 2px ${t.shadowControlColor}`,
    transform: "translateX(0)",
    transitionProperty: "transform",
    transitionDuration: t.durationFast,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0s" },
  },
  switchKnobOn: { transform: "translateX(14px)" },
});
