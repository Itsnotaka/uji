import Link from "next/link";
import { DocRail, type DocCard } from "@/components/landing/doc-rail";

/*
 * Eleven packages, three of which are names with no directory behind them.
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
  { name: "@uji-ai/protocol", built: false },
  { name: "@uji-ai/server", built: false },
  { name: "@uji-ai/client", built: false },
];

const documents: DocCard[] = [
  { title: "Quickstart", meta: "Get a working agent", kind: "flow", href: "/docs/quickstart" },
  {
    title: "Architecture",
    meta: "Boundaries and direction",
    kind: "seam",
    href: "/docs/architecture",
  },
  { title: "Schema", meta: "@uji-ai/schema", kind: "seam", href: "/docs/schema" },
  { title: "Providers", meta: "@uji-ai/ai", kind: "flow", href: "/docs/ai" },
  { title: "Agent loop", meta: "@uji-ai/core", kind: "flow", href: "/docs/core/agent-loop" },
  { title: "AgentHarness", meta: "@uji-ai/core", kind: "stack", href: "/docs/core/harness" },
  {
    title: "Session storage",
    meta: "@uji-ai/core",
    kind: "log",
    href: "/docs/core/session-storage",
  },
  { title: "Tools", meta: "@uji-ai/core", kind: "lattice", href: "/docs/core/tools" },
  { title: "Plugins", meta: "@uji-ai/plugin", kind: "lattice", href: "/docs/plugin" },
  { title: "Telemetry", meta: "@uji-ai/telemetry", kind: "log", href: "/docs/telemetry" },
  { title: "UI", meta: "@uji-ai/ui", kind: "stack", href: "/docs/ui" },
  { title: "CLI", meta: "@uji-ai/tui", kind: "flow", href: "/docs/tui" },
  { title: "Host and client", meta: "The contract", kind: "seam", href: "/docs/host-sdk" },
  { title: "Roadmap", meta: "What we are building", kind: "log", href: "/docs/roadmap" },
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
            durable harness, session storage, seven coding tools, and the provider blocks in one
            workspace, written here rather than imported. Nothing calls back up the stack: a client
            drives a harness, the harness drives the loop, the loop reaches a provider through a
            function it was handed.{" "}
            <Link href="/docs/architecture" className="cog-cite">
              The seam only flows one way
            </Link>
            .
          </p>

          <p className="cog-prose">
            Two clients exist now: a terminal CLI and an Electron desktop chat. A browser client
            needs the three reserved packages below. They sit on the wall as a promise of what comes
            next.
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
            <Link href="/docs" className="cog-btn-solid cog-ui">
              Open the docs
            </Link>
            <Link
              href="/docs/quickstart"
              className="cog-ui text-cog-ink underline underline-offset-4 transition-colors duration-150 hover:text-cog-accent"
            >
              Or run an agent
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
