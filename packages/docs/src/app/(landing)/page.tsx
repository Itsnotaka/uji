import Link from "next/link";
import { DocRail, type DocCard } from "@/components/landing/doc-rail";

/*
 * Twelve packages, three of which are names with no directory behind them.
 * They are on the same wall on purpose: the reserved rows are the most useful
 * thing on this page, and holding them back for the roadmap would let the
 * front page claim more than the repository does.
 */
const packages = [
  { name: "@uji-ai/schema", built: true },
  { name: "@uji-ai/ai", built: true },
  { name: "@uji-ai/core", built: true },
  { name: "@uji-ai/ui", built: true },
  { name: "@uji-ai/plugin", built: true },
  { name: "@uji-ai/telemetry", built: true },
  { name: "@uji-ai/tui", built: true },
  { name: "@uji-ai/desktop", built: true },
  { name: "@uji-ai/protocol", built: false },
  { name: "@uji-ai/server", built: false },
  { name: "@uji-ai/client", built: false },
];

const documents: DocCard[] = [
  { title: "Design", meta: "The whole shape", kind: "seam", href: "/docs/design" },
  { title: "The log", meta: "Entries, records, heads, facts", kind: "log", href: "/docs/design#the-log" },
  {
    title: "Heads",
    meta: "Named pointers, moves, stacks",
    kind: "lattice",
    href: "/docs/design#heads-are-named-pointers",
  },
  { title: "The turn", meta: "runAgentTurn", kind: "flow", href: "/docs/design#the-turn" },
  { title: "Runs", meta: "Claims, steps, recovery", kind: "stack", href: "/docs/design#runs" },
  { title: "Admission", meta: "Send never errors", kind: "flow", href: "/docs/design#admission-is-open" },
  { title: "Deployment", meta: "Embedded, server, serverless", kind: "seam", href: "/docs/design#deployment" },
  { title: "The SDK", meta: "createUji", kind: "flow", href: "/docs/design#the-sdk" },
  { title: "Plugins", meta: "What the model sees", kind: "lattice", href: "/docs/design#plugins" },
  { title: "Invariants", meta: "The numbered contract", kind: "log", href: "/docs/design#invariants" },
];

/*
 * Sections are addressed by number in the first content column. The numbers
 * are not decoration and not a sequence you are meant to follow in order —
 * they are how a section gets cited ("see 02") from anywhere else.
 */
function SectionNumber({ children }: { children: string }) {
  return <p className="cog-num col-span-full mb-3 md:col-span-1 md:mb-0">{children}</p>;
}

export default function LandingPage() {
  return (
    <>
      {/* ------------------------------------------------------------- 01 */}
      <section className="cog-subgrid pt-10 md:pt-(--cog-section)">
        <SectionNumber>01</SectionNumber>

        <div className="cog-copy col-span-full md:col-span-7">
          <h1 className="cog-display">Uji is a small core for cross-platform agentic UI.</h1>

          <p className="cog-prose mt-6">
            You should be able to read the code that runs your agents. Uji keeps the agent loop, the
            durable harness, session storage, five coding tools, and the provider blocks in one
            workspace, written here rather than imported. Nothing calls back up the stack: a client
            talks to createUji, that object admits into a store, an attached host runs the loop, and
            the loop reaches a provider through a function it was handed.{" "}
            <Link href="/docs/design#the-model-in-git-terms" className="cog-cite">
              The seam only flows one way
            </Link>
            .
          </p>

          <p className="cog-prose">
            Two product hosts exist now: a terminal CLI and an Electron app. A leftover demo desktop
            still talks to the harness directly. A browser client needs the three reserved packages
            below. They sit on the wall as a promise of what comes next.
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------------- 02 */}
      <section className="cog-subgrid pt-16 md:pt-(--cog-section)">
        <SectionNumber>02</SectionNumber>

        <ul className="col-span-full grid grid-cols-2 bg-cog-wash sm:grid-cols-3 md:col-span-10 md:grid-cols-5">
          {packages.map((entry) => (
            <li
              key={entry.name}
              className="flex flex-col items-center justify-center gap-1.5 px-3 py-10"
            >
              <span className={`cog-mono ${entry.built ? "text-cog-ink" : "text-cog-dim"}`}>
                {entry.name}
              </span>
              <span className={`cog-num ${entry.built ? "text-cog-accent" : ""}`}>
                {entry.built ? "built" : "reserved"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* ------------------------------------------------------------- 03 */}
      <section className="cog-subgrid pt-16 md:pt-(--cog-section)">
        <SectionNumber>03</SectionNumber>

        <div className="col-span-full md:col-span-7">
          <h2 className="cog-heading">Documentation from the source</h2>

          <p className="cog-prose mt-3">
            Every command, flag, and type signature is extracted from the code, not maintained
            separately. An audit script fails the build when docs and code disagree. The fastest way
            to learn what Uji does is to read what Uji is.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link href="/docs/design" className="cog-btn-solid cog-ui">
              Open the docs
            </Link>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- 04 */}
      <section className="cog-bleed-left pt-16 md:pt-(--cog-section)">
        <DocRail cards={documents} />
      </section>
    </>
  );
}
