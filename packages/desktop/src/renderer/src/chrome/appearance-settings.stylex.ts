/**
 * Settings dialog feature styles.
 * Based on https://github.com/interfaces-lab/honk/blob/main/packages/app/src/settings-appearance.tsx
 */
import * as stylex from "@stylexjs/stylex";
import { control } from "../theme/schema.stylex.ts";
import { t } from "../theme/vars.stylex.ts";

export const appearanceSettingsStyles = stylex.create({
  dialog: {
    width: "min(860px, calc(100vw - 48px))",
    height: "min(680px, calc(100vh - 48px))",
    maxWidth: "none",
    maxHeight: "none",
    padding: 0,
    overflow: "hidden",
    borderRadius: t.radiusXl,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: t.borderWeak,
    backgroundColor: t.bgElevated,
    color: t.textPrimary,
    boxShadow: t.shadowModal,
    WebkitAppRegion: "no-drag",
    "::backdrop": { backgroundColor: t.bgScrim },
  },
  dialogInner: { display: "flex", width: "100%", height: "100%", minHeight: 0 },
  navigation: {
    width: 174,
    flexShrink: 0,
    padding: 14,
    backgroundColor: t.bgSubtle,
    "@media (max-width: 700px)": { width: 142 },
  },
  navTitle: {
    paddingInline: 8,
    marginBottom: 14,
    color: t.textPrimary,
    fontSize: t.fontLg,
    fontWeight: 600,
  },
  navList: { display: "flex", flexDirection: "column", gap: 1 },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    height: control.regularHeight,
    paddingInline: 8,
    borderRadius: t.radiusLg,
    borderStyle: "none",
    backgroundColor: { default: "transparent", ":hover": t.fillGhostHover },
    color: t.textSecondary,
    fontSize: t.fontBase,
    fontWeight: 500,
    cursor: "pointer",
  },
  navItemActive: { backgroundColor: t.fillGhostSelected, color: t.textPrimary },
  content: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 },
  header: {
    display: "flex",
    alignItems: "center",
    minHeight: 52,
    paddingInline: 22,
    flexShrink: 0,
  },
  title: { flex: 1, color: t.textPrimary, fontSize: 16, fontWeight: 600 },
  scroll: { flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 22px 28px" },
  section: { paddingBlock: 18 },
  segmentedTwo: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
});
