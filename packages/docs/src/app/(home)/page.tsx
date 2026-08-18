import Link from "next/link";
import { SeamDiagram } from "@/components/seam-diagram";
import { gitConfig } from "@/lib/shared";

const packages = [
  {
    name: "@june/schema",
    built: true,
    note: "Responses wire item types, shared by core, ai, and clients",
  },
  {
    name: "@june/ai",
    built: true,
    note: "Provider blocks, credential store, OAuth, streamed Responses client",
  },
  {
    name: "@june/core",
    built: true,
    note: "The loop, AgentHarness, the SQLite session backend, seven tools",
  },
  {
    name: "@june/demo",
    built: true,
    note: "The june CLI: full-screen TUI, -p print mode, readline login",
  },
  {
    name: "@june/protocol",
    built: false,
    note: "The wire clients would bind to. No directory exists",
  },
  { name: "@june/server", built: false, note: "The HTTP+SSE host. No directory exists" },
  { name: "@june/client", built: false, note: "The typed TypeScript client. No directory exists" },
];

const rules = [
  {
    rule: "June never imports another project’s harness as its implementation.",
    body: "Pi, OpenCode v2, and Flue are read for their shapes. None is a dependency. @june/core’s dependency list is @june/ai, @june/schema, and diff.",
    href: "/docs/principles",
  },
  {
    rule: "The loop must never import the harness.",
    body: "Delete packages/core/src/harness/ and the loop still compiles. agent-loop.ts has exactly one import statement, and it is a type import.",
    href: "/docs/architecture",
  },
  {
    rule: "Every capability arrives as a parameter, never a registration.",
    body: "Session storage, the stream function, the provider, the credential store, and the tool set are each passed at the composition site. Nothing registers itself into a global.",
    href: "/docs/principles",
  },
];

export default function HomePage() {
  return (
    <div className="mx-auto max-w-(--june-page) px-(--june-gutter)">
      {/* ------------------------------------------------------------ hero */}
      <section className="pt-14 pb-20 sm:pt-20 sm:pb-24">
        <p
          className="june-rise june-label text-june-signal"
          style={{ "--stagger": 0 } as React.CSSProperties}
        >
          Handwritten core · v{"0.0.14"}
        </p>

        <h1
          className="june-rise june-display mt-6 max-w-[19ch] text-june-ink"
          style={{ "--stagger": 1 } as React.CSSProperties}
        >
          Everything here is handwritten. Including the list of what is not built.
        </h1>

        <p
          className="june-rise mt-8 max-w-[62ch] text-[17px] leading-[1.65] text-june-muted"
          style={{ "--stagger": 2 } as React.CSSProperties}
        >
          June is an independent core for cross-platform agentic UI. A standalone agent loop owns
          turns and tool batches. A durable harness composes that loop over session storage, tool
          intents, and crash recovery. A client drives the harness and never runs the loop itself.
        </p>

        <div
          className="june-rise mt-10 flex flex-wrap items-center gap-3"
          style={{ "--stagger": 3 } as React.CSSProperties}
        >
          <Link
            href="/docs"
            className="june-raised june-raised-interactive rounded-lg bg-june-signal px-4 py-2.5 text-[14px] font-medium text-june-paper"
          >
            Read the docs
          </Link>
          <a
            href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
            target="_blank"
            rel="noreferrer"
            className="june-raised june-raised-interactive rounded-lg bg-june-paper px-4 py-2.5 text-[14px] font-medium text-june-ink"
          >
            View the source
          </a>
        </div>
      </section>

      {/* ------------------------------------------------------------ seam */}
      <section className="border-t border-june-rule py-16 sm:py-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-16">
          <div>
            <h2 className="june-label text-june-muted">The seam</h2>
            <p className="june-section mt-5 text-june-ink">One direction, all the way down</p>
            <p className="mt-4 max-w-[38ch] text-[14px] leading-relaxed text-june-muted">
              A client talks to a harness. The harness drives the loop. The loop reaches a provider
              through an injected function. Nothing calls back up. The last hop is drawn dashed
              because it is named and unwritten.
            </p>
          </div>

          <SeamDiagram />
        </div>
      </section>

      {/* ---------------------------------------------------------- ledger */}
      <section className="border-t border-june-rule py-16 sm:py-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-16">
          <div>
            <h2 className="june-label text-june-muted">The ledger</h2>
            <p className="june-section mt-5 text-june-ink">What runs today</p>
            <p className="mt-4 max-w-[38ch] text-[14px] leading-relaxed text-june-muted">
              Every package is private and unpublished. Built means the source is in this workspace
              and runs, not that it is on npm.
            </p>
          </div>

          <ul className="june-mono max-w-[46rem] text-[13px]">
            {packages.map((entry) => (
              <li
                key={entry.name}
                className="grid gap-x-6 gap-y-1.5 border-b border-june-rule py-3.5 last:border-b-0 sm:grid-cols-[10.5rem_5.5rem_minmax(0,1fr)] sm:items-baseline"
              >
                <span className={entry.built ? "text-june-ink" : "text-june-muted"}>
                  {entry.name}
                </span>
                <span
                  className={`june-label ${entry.built ? "text-june-signal" : "text-june-muted"}`}
                >
                  {entry.built ? "Built" : "Reserved"}
                </span>
                <span className="text-june-muted">{entry.note}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ----------------------------------------------------------- rules */}
      <section className="border-t border-june-rule py-16 sm:py-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-16">
          <div>
            <h2 className="june-label text-june-muted">Settled</h2>
            <p className="june-section mt-5 text-june-ink">Decisions nobody re-argues</p>
            <p className="mt-4 max-w-[38ch] text-[14px] leading-relaxed text-june-muted">
              Read the bold line as a rule. Everything after it is evidence you can grep for.
            </p>
          </div>

          <div className="max-w-[46rem] divide-y divide-june-rule">
            {rules.map((item) => (
              <Link key={item.rule} href={item.href} className="group block py-7 first:pt-0">
                <p className="june-subsection max-w-[48ch] text-june-ink underline decoration-transparent decoration-1 underline-offset-[6px] transition-[text-decoration-color] duration-150 group-hover:decoration-june-signal">
                  {item.rule}
                </p>
                <p className="mt-3 max-w-[64ch] text-[14px] leading-relaxed text-june-muted">
                  {item.body}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
