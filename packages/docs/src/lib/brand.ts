/**
 * The June brand system, in one place.
 *
 * Every value here is also emitted as a CSS custom property in `global.css`.
 * This module is what /branding reads, so the page can never drift from the
 * tokens the site actually renders with.
 */

export interface Swatch {
  /** Display name. */
  name: string;
  /** Semantic token name in Grok Bot's compiled StyleX theme. */
  source: string;
  /** The role this colour plays in the interface. */
  role: string;
  light: string;
  dark: string;
}

export const palette: Swatch[] = [
  {
    name: "Base",
    source: "bg/base",
    role: "Page ground",
    light: "#FCFCFC",
    dark: "#070707",
  },
  {
    name: "Subtle",
    source: "bg/subtle",
    role: "Recessed chrome",
    light: "#F7F7F7",
    dark: "#111111",
  },
  {
    name: "Elevated",
    source: "bg/elevated",
    role: "Floating surfaces",
    light: "#FCFCFC",
    dark: "#181818",
  },
  {
    name: "Fill",
    source: "fill/secondary",
    role: "Quiet controls",
    light: "#77777717",
    dark: "#7777772C",
  },
  {
    name: "Selected",
    source: "fill/ghost-selected",
    role: "Hover and selected",
    light: "#7777772B",
    dark: "#77777752",
  },
  {
    name: "Border",
    source: "border/default",
    role: "Dividers and outlines",
    light: "#14141426",
    dark: "#FCFCFC26",
  },
  {
    name: "Secondary",
    source: "text/secondary",
    role: "Secondary text",
    light: "#14141499",
    dark: "#FCFCFC99",
  },
  {
    name: "Primary",
    source: "text/primary",
    role: "Primary text",
    light: "#141414",
    dark: "#FCFCFC",
  },
  {
    name: "Accent text",
    source: "text/accent",
    role: "Links and labels",
    light: "#0C64C1",
    dark: "#80BEFE",
  },
  {
    name: "Accent fill",
    source: "fill/accent",
    role: "Filled actions",
    light: "#1084FE",
    dark: "#1084FE",
  },
];

export interface TypeStep {
  token: string;
  usage: string;
  face: "Inter" | "Berkeley Mono";
  /** Rendered size, in px, at the desktop breakpoint. */
  size: string;
  lineHeight: string;
  weight: string;
  tracking: string;
}

/**
 * Two faces, split by what the text is rather than how big it is. Inter sets
 * anything a person wrote as prose; Berkeley Mono sets anything a machine
 * produced or a person will copy — and labels, which is what keeps hierarchy
 * legible without stacking Inter weights.
 */
export const typeScale: TypeStep[] = [
  {
    token: "display",
    usage: "Home statement",
    face: "Inter",
    size: "40 → 68",
    lineHeight: "1.03",
    weight: "600",
    tracking: "-0.035em",
  },
  {
    token: "title",
    usage: "Page title",
    face: "Inter",
    size: "32",
    lineHeight: "1.14",
    weight: "600",
    tracking: "-0.028em",
  },
  {
    token: "section",
    usage: "h2",
    face: "Inter",
    size: "24",
    lineHeight: "1.22",
    weight: "600",
    tracking: "-0.022em",
  },
  {
    token: "subsection",
    usage: "h3",
    face: "Inter",
    size: "19",
    lineHeight: "1.35",
    weight: "600",
    tracking: "-0.014em",
  },
  {
    token: "body",
    usage: "Prose",
    face: "Inter",
    size: "16",
    lineHeight: "1.72",
    weight: "400",
    tracking: "-0.006em",
  },
  {
    token: "small",
    usage: "Captions, interface text",
    face: "Inter",
    size: "13",
    lineHeight: "1.55",
    weight: "400",
    tracking: "0",
  },
  {
    token: "code",
    usage: "Code, data columns, diagrams",
    face: "Berkeley Mono",
    size: "13",
    lineHeight: "1.65",
    weight: "400",
    tracking: "0",
  },
  {
    token: "label",
    usage: "Eyebrows, section numbers",
    face: "Berkeley Mono",
    size: "11",
    lineHeight: "1",
    weight: "400",
    tracking: "0.13em",
  },
];

export interface VoicePrinciple {
  name: string;
  body: string;
}

/** Lifted from how the docs already read, not invented for the brand page. */
export const voice: VoicePrinciple[] = [
  {
    name: "Inventory, not pitch",
    body: 'Say what runs. "Reserved, not built" is a shipping state we write down, not a gap we phrase around. A reader who trusts the absent rows will trust the present ones.',
  },
  {
    name: "Name the mechanism",
    body: 'Prefer the call, the file, the type. "The harness commits a tool intent before the effect runs" beats "durable by design". A sentence that survives a grep is a sentence worth writing.',
  },
  {
    name: "One claim per sentence",
    body: "Short declaratives, no hedging stack. If something is uncertain, say which part and why, then stop. Qualifiers pile up faster than facts do.",
  },
  {
    name: "The source wins",
    body: "When a page and the code disagree, the page is wrong. Write so that is checkable: link the file, quote the signature, date the decision.",
  },
];

/**
 * Central Icons is the set June draws with, on the web and in the Electron
 * client. Lucide is still in the tree because `fumadocs-ui` depends on it
 * directly — its own chrome (search, chevrons, callouts, the theme switch) is
 * Lucide and cannot be swapped without forking the package.
 */
export const iconSystem = {
  library: "Central Icons",
  package: "@central-icons-react/round-outlined-radius-1-stroke-1.5",
  stroke: "1.5, baked into the variant",
  sizes: [16, 20, 24],
  note: "One set across the docs site and the desktop client, so a glyph means the same thing in both. The stroke is part of the package variant rather than a prop, which is why nothing here passes strokeWidth.",
  resolver:
    "src/lib/source.ts swaps Fumadocs' lucideIconsPlugin for a Central Icons resolver, so an icon name in frontmatter or meta.json is a Central name.",
  fumadocs:
    "Fumadocs' built-in chrome stays on Lucide. fumadocs-ui imports lucide-react in 46 of its own modules, so replacing it would mean forking the layouts.",
} as const;

export const typefaces = [
  {
    name: "Inter",
    role: "Prose, headings, interface",
    licence: "SIL Open Font License 1.1",
    note: "Loaded through next/font, subset to latin. Tracking is pulled in as size grows and left alone at text sizes.",
  },
  {
    name: "Berkeley Mono",
    role: "Code, data, diagrams, labels",
    licence: "Commercial — check the web-embedding tier before shipping",
    note: "Regular and Bold only, self-hosted from src/fonts. Ligatures are off everywhere so operators read as they were typed.",
  },
] as const;
