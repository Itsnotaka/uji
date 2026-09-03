/** Reusable settings recipes. Palette and scale values still come from the typed theme. */
import * as stylex from "@stylexjs/stylex";
import { t } from "./vars.stylex.ts";

export const settingsPatterns = stylex.create({
  sectionTitle: {
    margin: 0,
    marginBottom: 4,
    color: t.textPrimary,
    fontSize: t.fontBase,
    fontWeight: 600,
  },
  sectionDescription: {
    margin: 0,
    marginBottom: 14,
    color: t.textTertiary,
    fontSize: t.fontSm,
    lineHeight: t.leadingSm,
  },
  choiceGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 6,
  },
  choice: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 3,
    minWidth: 0,
    minHeight: 62,
    padding: "9px 10px",
    borderRadius: t.radiusLg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: t.borderWeak, ":hover": t.borderDefault },
    backgroundColor: { default: t.bgBase, ":hover": t.bgFaint },
    color: t.textPrimary,
    textAlign: "left",
    cursor: "pointer",
  },
  choiceSelected: { borderColor: t.borderFocus, backgroundColor: t.fillGhostSelected },
  choiceLabel: { fontSize: t.fontBase, fontWeight: 500 },
  choiceDescription: { color: t.textTertiary, fontSize: t.fontXs, lineHeight: t.leadingXs },
});
