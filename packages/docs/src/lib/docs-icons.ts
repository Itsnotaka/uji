import {
  IconAgent,
  IconArrowsRepeat,
  IconBookSimple,
  IconBridge,
  IconChart1,
  IconCodeBrackets,
  IconComponents,
  IconConsole,
  IconHammer,
  IconLayersThree,
  IconPackage,
  IconPlan,
  IconPlugin1,
  IconRocket,
  IconSettingsGear1,
  IconShieldCheck,
  IconSparkle,
  IconStorage,
  IconStreaming,
} from "central-icons";

/*
 * One glyph per docs page. Names are the Central Icons export, used in
 * frontmatter, meta.json, and <DocCard icon="…" />.
 */
export const docsIcons = {
  IconAgent,
  IconArrowsRepeat,
  IconBookSimple,
  IconBridge,
  IconChart1,
  IconCodeBrackets,
  IconComponents,
  IconConsole,
  IconHammer,
  IconLayersThree,
  IconPackage,
  IconPlan,
  IconPlugin1,
  IconRocket,
  IconSettingsGear1,
  IconShieldCheck,
  IconSparkle,
  IconStorage,
  IconStreaming,
};

export type DocsIconName = keyof typeof docsIcons;

export function isDocsIconName(name: string): name is DocsIconName {
  return Object.hasOwn(docsIcons, name);
}
