/**
 * One leaf owns the desktop's icon family. Feature components choose a
 * semantic name; they never sketch SVG paths or import individual glyphs.
 *
 * Based on https://github.com/interfaces-lab/honk/blob/main/packages/ui/src/icon.tsx
 */
import * as stylex from "@stylexjs/stylex";
import {
  IconArrowLeft,
  IconArrowRotateClockwise,
  IconArrowUp,
  IconBranch,
  IconChanges,
  IconCheckmark1,
  IconClipboard,
  IconChevronDownMedium,
  IconChevronRightMedium,
  IconClawd,
  IconCrossSmall,
  IconDotGrid1x3Horizontal,
  IconFolder1,
  IconFolderOpen,
  IconGithub,
  IconGlobe,
  IconKimi,
  IconLayoutLeftRight,
  IconLayoutTopBottom,
  IconLoader,
  IconMagnifyingGlass,
  IconOngoing,
  IconOpenaiCodex,
  IconPencilLine,
  IconPlusSmall,
  IconSettingsGear2,
  IconSidebarSimpleLeftWide,
  IconSidebarSimpleRightWide,
  IconSparklesSoft,
  IconStop,
  IconTrashCan,
  IconUser,
  IconZai,
} from "central-icons";
import type { CentralIconBaseProps } from "central-icons/CentralIconBase";
import type { ComponentType, ReactElement } from "react";

type Glyph = ComponentType<CentralIconBaseProps>;

const GLYPHS = {
  "arrow-left": IconArrowLeft,
  "arrow-up": IconArrowUp,
  checkmark: IconCheckmark1,
  copy: IconClipboard,
  "chevron-down": IconChevronDownMedium,
  "chevron-right": IconChevronRightMedium,
  clock: IconOngoing,
  file: IconChanges,
  folder: IconFolder1,
  "folder-open": IconFolderOpen,
  "git-branch": IconBranch,
  github: IconGithub,
  globe: IconGlobe,
  loader: IconLoader,
  "model-anthropic": IconClawd,
  "model-generic": IconGlobe,
  "model-kimi": IconKimi,
  "model-openai": IconOpenaiCodex,
  "model-zai": IconZai,
  more: IconDotGrid1x3Horizontal,
  "panel-left": IconSidebarSimpleLeftWide,
  "panel-right": IconSidebarSimpleRightWide,
  pencil: IconPencilLine,
  plus: IconPlusSmall,
  refresh: IconArrowRotateClockwise,
  search: IconMagnifyingGlass,
  settings: IconSettingsGear2,
  sparkle: IconSparklesSoft,
  "split-down": IconLayoutTopBottom,
  "split-right": IconLayoutLeftRight,
  square: IconStop,
  trash: IconTrashCan,
  user: IconUser,
  x: IconCrossSmall,
} satisfies Readonly<Record<string, Glyph>>;

export type IconName = keyof typeof GLYPHS;

const styles = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    lineHeight: 0,
  },
});

interface IconProps extends Omit<CentralIconBaseProps, "ariaHidden" | "mode" | "size"> {
  name: IconName;
  size?: number;
  label?: string;
}

export function Icon({ name, size = 16, label, ...rest }: IconProps): ReactElement {
  const Glyph = GLYPHS[name];
  return (
    <span
      role={label === undefined ? undefined : "img"}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      {...stylex.props(styles.root)}
    >
      <Glyph size={size} mode="raw" ariaHidden={true} {...rest} />
    </span>
  );
}
