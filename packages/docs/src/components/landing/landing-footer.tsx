import Link from "next/link";
import { UjiWordmark } from "@/components/brand/mark";
import { gitConfig } from "@/lib/shared";

const source = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/*
 * Footer links are set in the mono face rather than the serif. It is the one
 * place on the page where the reader is scanning a list of addresses instead
 * of reading a sentence, and the mono face is what the CLI already uses for
 * that job.
 */
const columns = [
  {
    heading: "Core",
    links: [
      { label: "Agent loop", href: "/docs/core/agent-loop" },
      { label: "AgentHarness", href: "/docs/core/harness" },
      { label: "Session storage", href: "/docs/core/session-storage" },
      { label: "Stream function", href: "/docs/core/stream-fn" },
      { label: "Tools", href: "/docs/core/tools" },
    ],
  },
  {
    heading: "Guides",
    links: [
      { label: "Quickstart", href: "/docs/quickstart" },
      { label: "Architecture", href: "/docs/architecture" },
      { label: "Principles", href: "/docs/principles" },
      { label: "Recipes", href: "/docs/core/recipes" },
      { label: "Host and client", href: "/docs/host-sdk" },
    ],
  },
  {
    heading: "Project",
    links: [
      { label: "Roadmap", href: "/docs/roadmap" },
      { label: "Brand", href: "/branding" },
      { label: "Source", href: source, external: true },
      { label: "llms.txt", href: "/llms.txt", external: true },
    ],
  },
];

export function LandingFooter() {
  return (
    <footer className="relative z-10 mt-24 md:mt-40">
      <div className="cog-container">
        <div className="h-px w-full bg-cog-rule" />

        <div className="cog-grid gap-y-10 pt-8 pb-16 md:pb-24">
          <div className="col-span-full flex items-start md:col-span-4">
            <UjiWordmark size={17} showMark className="text-cog-ink" />
          </div>

          {columns.map((column) => (
            <div key={column.heading} className="col-span-full sm:col-span-5 md:col-span-3">
              <h2 className="cog-mono text-cog-dim">{column.heading}</h2>
              <ul className="mt-3 flex flex-col gap-1">
                {column.links.map((link) => (
                  <li key={link.label}>
                    {"external" in link && link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        className="cog-mono text-cog-ink transition-colors duration-150 hover:text-cog-accent"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="cog-mono text-cog-ink transition-colors duration-150 hover:text-cog-accent"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </footer>
  );
}
