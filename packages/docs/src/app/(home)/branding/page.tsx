import type { Metadata } from "next";
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
import { UjiMark, UjiMarkField, UjiWordmark } from "@/components/brand/mark";
import { CopyValue } from "@/components/brand/copy-value";
import { iconSystem, palette, typefaces, typeScale, voice } from "@/lib/brand";

export const metadata: Metadata = {
  title: "Brand",
  description: "Uji's mark, wordmark, palette, type scale, icon set, and voice.",
};

const sections = [
  { id: "mark", title: "Mark" },
  { id: "wordmark", title: "Wordmark" },
  { id: "colour", title: "Colour" },
  { id: "typography", title: "Typography" },
  { id: "icons", title: "Icons" },
  { id: "voice", title: "Voice" },
];

const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
  <g stroke="currentColor" stroke-width="2.8" stroke-linecap="butt">
    <path d="M16.5 4.2V11.4"/>
    <path d="M16.5 12.7V14.2A4.5 4.5 0 0 1 7.5 14.2"/>
  </g>
</svg>`;

const wordmarkCss = `font-family: Inter, sans-serif;
font-weight: 600;
letter-spacing: -0.04em;`;

const previewIcons = [
  { name: "IconAgent", Icon: IconAgent },
  { name: "IconRocket", Icon: IconRocket },
  { name: "IconLayersThree", Icon: IconLayersThree },
  { name: "IconShieldCheck", Icon: IconShieldCheck },
  { name: "IconCodeBrackets", Icon: IconCodeBrackets },
  { name: "IconSparkle", Icon: IconSparkle },
  { name: "IconPackage", Icon: IconPackage },
  { name: "IconPlugin1", Icon: IconPlugin1 },
  { name: "IconChart1", Icon: IconChart1 },
  { name: "IconComponents", Icon: IconComponents },
  { name: "IconConsole", Icon: IconConsole },
  { name: "IconBridge", Icon: IconBridge },
  { name: "IconPlan", Icon: IconPlan },
  { name: "IconArrowsRepeat", Icon: IconArrowsRepeat },
  { name: "IconSettingsGear1", Icon: IconSettingsGear1 },
  { name: "IconStorage", Icon: IconStorage },
  { name: "IconHammer", Icon: IconHammer },
  { name: "IconStreaming", Icon: IconStreaming },
  { name: "IconBookSimple", Icon: IconBookSimple },
];

const actionClass =
  "inline-flex min-h-11 touch-manipulation items-center rounded-md border border-fd-border bg-fd-secondary px-3 text-sm text-fd-foreground hover:bg-fd-accent";

const ghostClass =
  "inline-flex min-h-11 touch-manipulation items-center rounded-md px-3 text-sm text-fd-muted-foreground hover:bg-fd-secondary hover:text-fd-foreground";

const panelClass = "rounded-lg border border-fd-border bg-fd-secondary";

const baseSwatch = palette.find((swatch) => swatch.name === "Base");

export default function BrandingPage() {
  return (
    <div className="mx-auto w-full max-w-(--fd-layout-width) px-4 py-12 md:px-6 md:py-16">
      <Opening />

      <div className="lg:grid lg:grid-cols-[10rem_minmax(0,1fr)] lg:gap-16">
        <SectionIndex />

        <div>
          <Mark />
          <Wordmark />
          <Colour />
          <Typography />
          <Icons />
          <Voice />
        </div>
      </div>
    </div>
  );
}

function Opening() {
  return (
    <header className="pb-12">
      <h1 className="text-balance text-3xl font-semibold tracking-tight text-fd-foreground">
        Brand
      </h1>
      <p className="mt-3 max-w-prose text-fd-muted-foreground">
        Mark, wordmark, palette, type, icons, and voice. Values come from{" "}
        <code className="font-mono text-sm text-fd-foreground">src/lib/brand.ts</code>.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-2">
        <a href="/brand/uji-mark.svg" download className={actionClass}>
          Download the mark
        </a>
        <CopyValue value={markSvg} label="Copy SVG" />
      </div>
    </header>
  );
}

function SectionIndex() {
  return (
    <nav aria-label="Brand sections" className="hidden lg:block">
      <ul role="list" className="sticky top-20 space-y-1">
        {sections.map((section) => (
          <li key={section.id}>
            <a href={`#${section.id}`} className={ghostClass}>
              {section.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Section({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-fd-border pt-8 pb-16">
      <h2 className="text-2xl font-semibold tracking-tight text-fd-foreground">{title}</h2>
      <p className="mt-3 max-w-prose text-fd-muted-foreground">{lede}</p>
      <div className="mt-8">{children}</div>
    </section>
  );
}

function Mark() {
  return (
    <Section
      id="mark"
      title="Mark"
      lede="A J drawn as one descending stroke with a single seam cut into it."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <figure className={`flex aspect-video items-center justify-center ${panelClass}`}>
          <UjiMark className="h-28 w-28 text-fd-foreground" />
        </figure>
        <figure
          className="flex aspect-video items-center justify-center rounded-lg"
          style={{ backgroundColor: baseSwatch?.dark }}
        >
          <UjiMark className="h-28 w-28" style={{ color: baseSwatch?.light }} />
        </figure>
      </div>

      <p className="mt-8 max-w-prose text-sm leading-relaxed text-fd-muted-foreground">
        Reproduce the mark in full ink on light or full paper on dark. It has no accent, no fill,
        and no second colour.
      </p>

      <div className="mt-10 flex flex-wrap items-end gap-10 border-t border-fd-border pt-8">
        {[16, 24, 40, 96].map((size) => (
          <div key={size} className="flex flex-col items-center gap-3">
            <UjiMark style={{ width: size, height: size }} className="text-fd-foreground" />
            <span className="font-mono text-xs text-fd-muted-foreground">{size}px</span>
          </div>
        ))}
        <div className="flex flex-col items-center gap-3">
          <UjiMarkField className="size-10 text-fd-foreground" />
          <span className="font-mono text-xs text-fd-muted-foreground">app icon</span>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap gap-2">
        <CopyValue value={markSvg} label="Copy SVG" />
        <a href="/brand/uji-mark.svg" download className={ghostClass}>
          Mark SVG
        </a>
        <a href="/brand/uji-mark-inverse.svg" download className={ghostClass}>
          Mark, inverse SVG
        </a>
        <a href="/brand/uji-icon.svg" download className={ghostClass}>
          App icon SVG
        </a>
      </div>
    </Section>
  );
}

function Wordmark() {
  return (
    <Section id="wordmark" title="Wordmark" lede="Live type, never outlines.">
      <figure className={`flex min-h-56 items-center justify-center px-6 ${panelClass}`}>
        <UjiWordmark size={88} className="text-fd-foreground" />
      </figure>

      <p className="mt-8 max-w-prose text-sm leading-relaxed text-fd-muted-foreground">
        The wordmark is Inter at weight 600, tracked in. Keeping it as text rather than a traced
        path means it inherits colour, antialiasing, and the reader&apos;s own rendering, and it
        stays one recipe instead of a file to re-export. Set it alone. The mark is a U, so locking
        the two together stutters.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <div className={`${panelClass} p-5`}>
          <p className="font-mono text-xs text-fd-muted-foreground">Recipe</p>
          <pre className="mt-4 font-mono text-xs leading-relaxed text-fd-foreground">
            {wordmarkCss}
          </pre>
          <CopyValue value={wordmarkCss} label="Copy CSS" className="-ml-3 mt-2" />
        </div>
        <div className={`${panelClass} p-5`}>
          <p className="font-mono text-xs text-fd-muted-foreground">Clear space</p>
          <p className="mt-4 text-sm leading-relaxed text-fd-muted-foreground">
            Keep a margin of one cap height on every side. In a header that resolves to 19px type
            with 12px of padding, which is why the wordmark&apos;s hit area extends past its ink.
          </p>
        </div>
      </div>
    </Section>
  );
}

function Colour() {
  return (
    <Section
      id="colour"
      title="Colour"
      lede="Neutral surfaces and text, plus one accent for work that is built."
    >
      <p className="max-w-prose text-sm leading-relaxed text-fd-muted-foreground">
        Base, subtle, elevated, fill, border, and text roles come from Uji&apos;s shared interface
        palette. Signal marks a thing that exists in the workspace and runs. Anything
        reserved-but-unwritten stays secondary and never gets the accent.
      </p>

      <div className="mt-10 space-y-10">
        <SwatchRow mode="light" />
        <SwatchRow mode="dark" />
      </div>
    </Section>
  );
}

function SwatchRow({ mode }: { mode: "light" | "dark" }) {
  return (
    <div>
      <p className="font-mono text-xs text-fd-muted-foreground">{mode}</p>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {palette.map((swatch) => {
          const hex = mode === "light" ? swatch.light : swatch.dark;

          return (
            <div
              key={swatch.name}
              className="flex flex-col overflow-hidden rounded-lg border border-fd-border"
            >
              <div className="h-24 w-full" style={{ backgroundColor: hex }} aria-hidden />
              <div className="flex flex-1 flex-col p-3.5">
                <p className="text-sm text-fd-foreground">{swatch.name}</p>
                <p className="mt-1 text-xs leading-snug text-fd-muted-foreground">{swatch.role}</p>
                <p className="mt-3 font-mono text-xs text-fd-foreground">{hex}</p>
                <p className="mt-1 font-mono text-[11px] leading-snug text-fd-muted-foreground">
                  {swatch.source}
                </p>
                <CopyValue value={hex} label="Copy hex" className="-ml-3 mt-auto pt-1" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Typography() {
  return (
    <Section
      id="typography"
      title="Typography"
      lede="Two faces, split by what the text is rather than how big it is."
    >
      <p className="max-w-prose text-sm leading-relaxed text-fd-muted-foreground">
        Inter sets anything a person wrote as prose. Berkeley Mono sets anything a machine produced
        or a person will copy: code, data columns, diagrams, labels.
      </p>

      <div className="mt-10 grid gap-4 lg:grid-cols-2">
        {typefaces.map((face) => (
          <div key={face.name} className={`${panelClass} p-6`}>
            <p className="font-mono text-xs text-fd-muted-foreground">{face.role}</p>

            <p
              className="mt-6 text-[44px] leading-none text-fd-foreground"
              style={{
                fontFamily: face.name === "Inter" ? "var(--font-sans)" : "var(--font-mono)",
                fontWeight: face.name === "Inter" ? 600 : 400,
                letterSpacing: face.name === "Inter" ? "-0.03em" : "-0.01em",
              }}
            >
              {face.name}
            </p>

            <p
              className="mt-5 text-sm leading-relaxed text-fd-muted-foreground"
              style={{
                fontFamily: face.name === "Inter" ? "var(--font-sans)" : "var(--font-mono)",
              }}
            >
              {face.name === "Inter"
                ? "A client drives the harness and never runs the loop itself."
                : 'runAgentLoopContinue(ctx, { model: "gpt-5.1-codex" }) // 0123456789'}
            </p>

            <dl className="mt-6 space-y-2 border-t border-fd-border pt-4 text-sm">
              <div className="flex gap-3">
                <dt className="w-16 shrink-0 font-mono text-xs text-fd-muted-foreground">
                  Licence
                </dt>
                <dd className="text-fd-muted-foreground">{face.licence}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-16 shrink-0 font-mono text-xs text-fd-muted-foreground">Notes</dt>
                <dd className="text-fd-muted-foreground">{face.note}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>

      <div className="mt-12 overflow-x-auto">
        <table className="w-full min-w-[46rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-fd-border">
              {["Token", "Usage", "Face", "Size", "Line height", "Weight", "Tracking"].map(
                (heading) => (
                  <th
                    key={heading}
                    className="pb-3 pr-6 font-mono text-xs text-fd-muted-foreground"
                  >
                    {heading}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="font-mono text-xs">
            {typeScale.map((step) => (
              <tr key={step.token} className="border-b border-fd-border last:border-b-0">
                <td className="py-3.5 pr-6 text-fd-foreground">{step.token}</td>
                <td className="py-3.5 pr-6 text-fd-muted-foreground">{step.usage}</td>
                <td className="py-3.5 pr-6 text-fd-muted-foreground">{step.face}</td>
                <td className="py-3.5 pr-6 text-fd-foreground">{step.size}</td>
                <td className="py-3.5 pr-6 text-fd-muted-foreground">{step.lineHeight}</td>
                <td className="py-3.5 pr-6 text-fd-muted-foreground">{step.weight}</td>
                <td className="py-3.5 text-fd-muted-foreground">{step.tracking}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Icons() {
  return (
    <Section
      id="icons"
      title="Icons"
      lede="Central Icons, the same set the desktop client draws with."
    >
      <p className="max-w-prose text-sm leading-relaxed text-fd-muted-foreground">
        {iconSystem.note}
      </p>

      <dl className="mt-8 max-w-prose space-y-3 text-sm leading-relaxed">
        <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
          <dt className="shrink-0 pt-1 font-mono text-xs text-fd-muted-foreground sm:w-24">
            Package
          </dt>
          <dd className="font-mono text-xs text-fd-foreground">{iconSystem.package}</dd>
        </div>
        <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
          <dt className="shrink-0 pt-1 font-mono text-xs text-fd-muted-foreground sm:w-24">
            Names
          </dt>
          <dd className="text-fd-muted-foreground">{iconSystem.resolver}</dd>
        </div>
        <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
          <dt className="shrink-0 pt-1 font-mono text-xs text-fd-muted-foreground sm:w-24">
            Exception
          </dt>
          <dd className="text-fd-muted-foreground">{iconSystem.fumadocs}</dd>
        </div>
      </dl>

      <div className="mt-10 flex flex-wrap items-end gap-10 border-y border-fd-border py-8">
        {iconSystem.sizes.map((size) => (
          <div key={size} className="flex flex-col items-center gap-3">
            <IconConsole size={size} className="text-fd-foreground" ariaHidden />
            <span className="font-mono text-xs text-fd-muted-foreground">{size}px</span>
          </div>
        ))}
      </div>

      <ul role="list" className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        {previewIcons.map(({ name, Icon }) => (
          <li
            key={name}
            className="flex flex-col items-center gap-3 rounded-lg border border-fd-border px-2 py-6 text-center"
          >
            <Icon size={20} className="text-fd-foreground" ariaHidden />
            <span className="font-mono text-[10.5px] leading-tight text-fd-muted-foreground">
              {name}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-8 max-w-prose text-sm leading-relaxed text-fd-muted-foreground">
        Icons are set at 20px in body contexts and 16px in dense rows. Stroke comes from the package
        variant, so there is nothing to pass and nothing to get wrong. An icon-only control always
        carries an aria-label. An icon never carries meaning on its own.
      </p>
    </Section>
  );
}

function Voice() {
  return (
    <Section id="voice" title="Voice" lede="How the docs already read, written down.">
      <div className="grid gap-x-16 gap-y-10 sm:grid-cols-2">
        {voice.map((principle) => (
          <div key={principle.name}>
            <h3 className="text-lg font-medium text-fd-foreground">{principle.name}</h3>
            <p className="mt-3 max-w-prose text-sm leading-relaxed text-fd-muted-foreground">
              {principle.body}
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}
