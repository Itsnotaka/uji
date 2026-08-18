import type { Metadata } from "next";
import {
  IconArrowDown,
  IconBranch,
  IconBug,
  IconCloud,
  IconCode,
  IconConsole,
  IconGrid,
  IconKey1,
  IconMagnifyingGlass,
  IconPackage,
  IconPlay,
  IconPlugin1,
  IconRotate,
  IconShield,
  IconSignalTower,
  IconStop,
  IconStorage,
  IconToolbox,
  IconTree,
} from "central-icons";
import { JuneMark, JuneMarkField, JuneWordmark } from "@/components/brand/mark";
import { CopyValue } from "@/components/brand/copy-value";
import { iconSystem, palette, typefaces, typeScale, voice } from "@/lib/brand";

export const metadata: Metadata = {
  title: "Brand",
  description:
    "June’s mark, wordmark, palette, type scale, icon set, and voice — the tokens the site itself renders with.",
};

const sections = [
  { id: "001-mark", number: "001", title: "Mark" },
  { id: "002-wordmark", number: "002", title: "Wordmark" },
  { id: "003-colour", number: "003", title: "Colour" },
  { id: "004-typography", number: "004", title: "Typography" },
  { id: "005-icons", number: "005", title: "Icons" },
  { id: "006-voice", number: "006", title: "Voice" },
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
  { name: "IconConsole", Icon: IconConsole },
  { name: "IconPackage", Icon: IconPackage },
  { name: "IconStorage", Icon: IconStorage },
  { name: "IconBranch", Icon: IconBranch },
  { name: "IconCode", Icon: IconCode },
  { name: "IconToolbox", Icon: IconToolbox },
  { name: "IconPlay", Icon: IconPlay },
  { name: "IconStop", Icon: IconStop },
  { name: "IconRotate", Icon: IconRotate },
  { name: "IconSignalTower", Icon: IconSignalTower },
  { name: "IconPlugin1", Icon: IconPlugin1 },
  { name: "IconKey1", Icon: IconKey1 },
  { name: "IconShield", Icon: IconShield },
  { name: "IconTree", Icon: IconTree },
  { name: "IconCloud", Icon: IconCloud },
  { name: "IconGrid", Icon: IconGrid },
  { name: "IconMagnifyingGlass", Icon: IconMagnifyingGlass },
  { name: "IconBug", Icon: IconBug },
];

export default function BrandingPage() {
  return (
    <div className="[--june-page:1440px]">
      <Opening />

      <div className="mx-auto max-w-(--june-page) px-(--june-gutter) pb-24">
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
    </div>
  );
}

/* ------------------------------------------------------------------ 000 --- */

function Opening() {
  return (
    <section className="mx-auto flex min-h-[calc(100vh-72px)] max-w-(--june-page) flex-col justify-between px-(--june-gutter) pt-10 pb-14">
      <div className="flex-1 flex flex-col justify-center">
        <p className="june-label text-june-signal">The June brand</p>
        <h1 className="june-display mt-6 max-w-[17ch] text-june-ink">
          One mark, one accent, two faces.
        </h1>
        <p className="mt-8 max-w-[58ch] text-[17px] leading-[1.65] text-june-muted">
          Every value on this page is read from{" "}
          <code className="june-mono text-[15px] text-june-ink">src/lib/brand.ts</code>, the same
          module the site renders with. If a swatch here is wrong, the site is wrong with it.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-2">
          <a
            href="/brand/june-mark.svg"
            download
            className="june-raised june-raised-interactive inline-flex min-h-11 items-center rounded-(--radius-june-control) bg-june-elevated px-3 text-[14px] font-medium text-june-ink"
          >
            Download the mark
          </a>
          <CopyValue value={markSvg} label="Copy SVG" />
        </div>
      </div>

      <div className="flex items-end justify-between gap-8">
        <JuneMark className="h-16 w-16 shrink-0 text-june-ink sm:h-24 sm:w-24" />
        <a
          href="#001-mark"
          className="june-ghost june-label inline-flex min-h-11 items-center gap-2 rounded-(--radius-june-control) px-2 text-june-muted hover:text-june-ink"
        >
          <span className="text-june-signal">001</span> Mark
          <IconArrowDown size={13} ariaHidden />
        </a>
      </div>
    </section>
  );
}

/* Numbers here are addresses, not a sequence: they let one section be cited
   ("see 003") and they are the anchor ids. */
function SectionIndex() {
  return (
    <nav aria-label="Brand sections" className="hidden lg:block">
      <ul role="list" className="sticky top-10 space-y-3 border-t border-june-rule pt-8">
        {sections.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className="june-ghost june-label flex min-h-8 items-center gap-3 rounded-(--radius-june-control) px-2 text-june-muted hover:text-june-ink"
            >
              <span className="text-june-signal">{section.number}</span>
              <span>{section.title}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Section({
  id,
  number,
  title,
  lede,
  children,
}: {
  id: string;
  number: string;
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-10 border-t border-june-rule pt-8 pb-24">
      <p className="june-label text-june-signal">{number}</p>
      <h2 className="june-section mt-5 text-june-ink">{title}</h2>
      <p className="mt-3 max-w-[42ch] text-[17px] leading-[1.5] text-june-muted">{lede}</p>
      <div className="mt-10">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ 001 --- */

function Mark() {
  return (
    <Section
      id="001-mark"
      number="001"
      title="Mark"
      lede="A J drawn as one descending stroke with a single seam cut into it."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <figure className="june-raised flex aspect-[16/9] items-center justify-center rounded-(--radius-june-panel) bg-june-elevated">
          <JuneMark className="h-28 w-28 text-june-ink" />
        </figure>
        <figure className="june-raised flex aspect-[16/9] items-center justify-center rounded-(--radius-june-panel) bg-june-ink">
          <JuneMark className="h-28 w-28 text-june-paper" />
        </figure>
      </div>

      <p className="mt-8 max-w-[62ch] text-[15px] leading-relaxed text-june-muted">
        The seam is the point where what is built stops and what is only named begins — the same cut
        the docs make between shipped packages and reserved ones. Reproduce the mark in full ink on
        light or full paper on dark. It carries no accent, no fill, and no second colour.
      </p>

      <div className="mt-10 flex flex-wrap items-end gap-10 border-t border-june-rule pt-8">
        {[16, 24, 40, 96].map((size) => (
          <div key={size} className="flex flex-col items-center gap-3">
            <JuneMark style={{ width: size, height: size }} className="text-june-ink" />
            <span className="june-mono text-[11px] text-june-muted">{size}px</span>
          </div>
        ))}
        <div className="flex flex-col items-center gap-3">
          <JuneMarkField className="size-10 text-june-ink" />
          <span className="june-mono text-[11px] text-june-muted">app icon</span>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap gap-2">
        <CopyValue value={markSvg} label="Copy SVG" />
        <a
          href="/brand/june-mark.svg"
          download
          className="june-ghost june-label inline-flex min-h-11 items-center rounded-(--radius-june-control) px-3 text-june-muted hover:text-june-ink"
        >
          Mark · SVG
        </a>
        <a
          href="/brand/june-mark-inverse.svg"
          download
          className="june-ghost june-label inline-flex min-h-11 items-center rounded-(--radius-june-control) px-3 text-june-muted hover:text-june-ink"
        >
          Mark, inverse · SVG
        </a>
        <a
          href="/brand/june-icon.svg"
          download
          className="june-ghost june-label inline-flex min-h-11 items-center rounded-(--radius-june-control) px-3 text-june-muted hover:text-june-ink"
        >
          App icon · SVG
        </a>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ 002 --- */

function Wordmark() {
  return (
    <Section id="002-wordmark" number="002" title="Wordmark" lede="Live type, never outlines.">
      <figure className="june-raised flex min-h-56 items-center justify-center rounded-(--radius-june-panel) bg-june-elevated px-6">
        <JuneWordmark size={88} className="text-june-ink" />
      </figure>

      <p className="mt-8 max-w-[62ch] text-[15px] leading-relaxed text-june-muted">
        The wordmark is Inter at weight 600, tracked in. Keeping it as text rather than a traced
        path means it inherits colour, antialiasing, and the reader’s own rendering — and it stays
        one recipe instead of a file to re-export. Set it alone. The mark is a J, so locking the two
        together stutters.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <div className="june-raised rounded-(--radius-june-panel) bg-june-elevated p-5">
          <p className="june-label text-june-muted">Recipe</p>
          <pre className="june-mono mt-4 text-[12.5px] leading-relaxed text-june-ink">
            {wordmarkCss}
          </pre>
          <CopyValue value={wordmarkCss} label="Copy CSS" className="-ml-3 mt-2" />
        </div>
        <div className="june-raised rounded-(--radius-june-panel) bg-june-elevated p-5">
          <p className="june-label text-june-muted">Clear space</p>
          <p className="mt-4 text-[14px] leading-relaxed text-june-muted">
            Keep a margin of one cap height on every side. In the site header that resolves to 19px
            type with 12px of padding, which is why the wordmark’s hit area extends past its ink.
          </p>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ 003 --- */

function Colour() {
  return (
    <Section
      id="003-colour"
      number="003"
      title="Colour"
      lede="Grok Bot’s neutral hierarchy, with one accent that means built."
    >
      <p className="max-w-[62ch] text-[15px] leading-relaxed text-june-muted">
        Base, subtle, elevated, fill, border, and text roles come from Grok Bot’s compiled StyleX
        theme. Signal marks a thing that exists in the workspace and runs. Anything
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
      <p className="june-label text-june-muted">{mode}</p>
      <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-(--radius-june-panel) bg-june-rule sm:grid-cols-3 lg:grid-cols-5">
        {palette.map((swatch) => {
          const hex = mode === "light" ? swatch.light : swatch.dark;

          return (
            <div key={swatch.name} className="flex flex-col bg-june-paper">
              <div
                className="june-outlined h-24 w-full"
                style={{ backgroundColor: hex }}
                aria-hidden
              />
              <div className="flex flex-1 flex-col p-3.5">
                <p className="text-[13px] font-medium text-june-ink">{swatch.name}</p>
                <p className="mt-1 text-[12px] leading-snug text-june-muted">{swatch.role}</p>
                <p className="june-mono mt-3 text-[11.5px] text-june-ink">{hex}</p>
                <p className="june-mono mt-1 text-[11px] leading-snug text-june-muted">
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

/* ------------------------------------------------------------------ 004 --- */

function Typography() {
  return (
    <Section
      id="004-typography"
      number="004"
      title="Typography"
      lede="Two faces, split by what the text is rather than how big it is."
    >
      <p className="max-w-[62ch] text-[15px] leading-relaxed text-june-muted">
        Inter sets anything a person wrote as prose. Berkeley Mono sets anything a machine produced
        or a person will copy — code, data columns, diagrams — and it also sets labels and section
        numbers, which is what keeps hierarchy legible without stacking Inter weights.
      </p>

      <div className="mt-10 grid gap-4 lg:grid-cols-2">
        {typefaces.map((face) => (
          <div
            key={face.name}
            className="june-raised rounded-(--radius-june-panel) bg-june-elevated p-6"
          >
            <p className="june-label text-june-muted">{face.role}</p>

            <p
              className="mt-6 text-[44px] leading-none text-june-ink"
              style={{
                fontFamily: face.name === "Inter" ? "var(--font-sans)" : "var(--font-mono)",
                fontWeight: face.name === "Inter" ? 600 : 400,
                letterSpacing: face.name === "Inter" ? "-0.03em" : "-0.01em",
              }}
            >
              {face.name}
            </p>

            <p
              className="mt-5 text-[14px] leading-relaxed text-june-muted"
              style={{
                fontFamily: face.name === "Inter" ? "var(--font-sans)" : "var(--font-mono)",
              }}
            >
              {face.name === "Inter"
                ? "A client drives the harness and never runs the loop itself."
                : 'runAgentLoopContinue(ctx, { model: "gpt-5.1-codex" }) // 0123456789'}
            </p>

            <dl className="mt-6 space-y-2 border-t border-june-rule pt-4 text-[12.5px]">
              <div className="flex gap-3">
                <dt className="june-label w-16 shrink-0 pt-0.5 text-june-muted">Licence</dt>
                <dd className="text-june-muted">{face.licence}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="june-label w-16 shrink-0 pt-0.5 text-june-muted">Notes</dt>
                <dd className="text-june-muted">{face.note}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>

      <div className="mt-12 overflow-x-auto">
        <table className="w-full min-w-[46rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-june-rule">
              {["Token", "Usage", "Face", "Size", "Line height", "Weight", "Tracking"].map(
                (heading) => (
                  <th key={heading} className="june-label pb-3 pr-6 text-june-muted">
                    {heading}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="june-mono text-[12.5px]">
            {typeScale.map((step) => (
              <tr key={step.token} className="border-b border-june-rule last:border-b-0">
                <td className="py-3.5 pr-6 text-june-ink">{step.token}</td>
                <td className="py-3.5 pr-6 text-june-muted">{step.usage}</td>
                <td className="py-3.5 pr-6 text-june-muted">{step.face}</td>
                <td className="py-3.5 pr-6 text-june-ink">{step.size}</td>
                <td className="py-3.5 pr-6 text-june-muted">{step.lineHeight}</td>
                <td className="py-3.5 pr-6 text-june-muted">{step.weight}</td>
                <td className="py-3.5 text-june-muted">{step.tracking}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ 005 --- */

function Icons() {
  return (
    <Section
      id="005-icons"
      number="005"
      title="Icons"
      lede="Central Icons, the same set the desktop client draws with."
    >
      <p className="max-w-[62ch] text-[15px] leading-relaxed text-june-muted">{iconSystem.note}</p>

      <dl className="mt-8 max-w-[62ch] space-y-3 text-[14px] leading-relaxed">
        <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
          <dt className="june-label shrink-0 pt-1 text-june-faint sm:w-24">Package</dt>
          <dd className="june-mono text-[12.5px] text-june-ink">{iconSystem.package}</dd>
        </div>
        <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
          <dt className="june-label shrink-0 pt-1 text-june-faint sm:w-24">Names</dt>
          <dd className="text-june-muted">{iconSystem.resolver}</dd>
        </div>
        <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
          <dt className="june-label shrink-0 pt-1 text-june-faint sm:w-24">Exception</dt>
          <dd className="text-june-muted">{iconSystem.fumadocs}</dd>
        </div>
      </dl>

      <div className="mt-10 flex flex-wrap items-end gap-10 border-y border-june-rule py-8">
        {iconSystem.sizes.map((size) => (
          <div key={size} className="flex flex-col items-center gap-3">
            <IconConsole size={size} className="text-june-ink" ariaHidden />
            <span className="june-mono text-[11px] text-june-muted">{size}px</span>
          </div>
        ))}
      </div>

      <ul
        role="list"
        className="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-(--radius-june-panel) bg-june-rule sm:grid-cols-4 lg:grid-cols-8"
      >
        {previewIcons.map(({ name, Icon }) => (
          <li
            key={name}
            className="flex flex-col items-center gap-3 bg-june-paper px-2 py-6 text-center"
          >
            <Icon size={20} className="text-june-ink" ariaHidden />
            <span className="june-mono text-[10.5px] leading-tight text-june-muted">{name}</span>
          </li>
        ))}
      </ul>

      <p className="mt-8 max-w-[62ch] text-[14px] leading-relaxed text-june-muted">
        Icons are set at 20px in body contexts and 16px in dense rows. Stroke comes from the package
        variant, so there is nothing to pass and nothing to get wrong. An icon-only control always
        carries an aria-label; an icon never carries meaning on its own.
      </p>
    </Section>
  );
}

/* ------------------------------------------------------------------ 006 --- */

function Voice() {
  return (
    <Section
      id="006-voice"
      number="006"
      title="Voice"
      lede="How the docs already read, written down."
    >
      <div className="grid gap-x-16 gap-y-10 sm:grid-cols-2">
        {voice.map((principle) => (
          <div key={principle.name}>
            <h3 className="june-subsection text-june-ink">{principle.name}</h3>
            <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed text-june-muted">
              {principle.body}
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}
