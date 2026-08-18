import Link from "next/link";
import { JuneMark } from "@/components/brand/mark";
import { gitConfig } from "@/lib/shared";

const columns = [
  {
    heading: "Docs",
    links: [
      { label: "Overview", href: "/docs" },
      { label: "Quickstart", href: "/docs/quickstart" },
      { label: "Architecture", href: "/docs/architecture" },
      { label: "Principles", href: "/docs/principles" },
    ],
  },
  {
    heading: "Core",
    links: [
      { label: "Agent loop", href: "/docs/core/agent-loop" },
      { label: "AgentHarness", href: "/docs/core/harness" },
      { label: "Session storage", href: "/docs/core/session-storage" },
      { label: "Tools", href: "/docs/core/tools" },
    ],
  },
  {
    heading: "Project",
    links: [
      { label: "Roadmap", href: "/docs/roadmap" },
      { label: "Brand", href: "/branding" },
      {
        label: "Source",
        href: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
        external: true,
      },
      {
        label: "llms.txt",
        href: "/llms.txt",
        external: true,
      },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-32">
      <div className="mx-auto max-w-(--june-page) px-(--june-gutter) pb-16">
        <div className="h-px w-full bg-june-rule" />

        <div className="grid gap-10 pt-12 sm:grid-cols-2 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div>
            <JuneMark className="h-6 w-6 text-june-ink" />
            <p className="mt-4 max-w-[34ch] text-[13px] leading-relaxed text-june-muted">
              An independent, handwritten core for cross-platform agentic UI. Every package in the
              workspace is private and unpublished.
            </p>
          </div>

          {columns.map((column) => (
            <div key={column.heading}>
              <h2 className="june-label text-june-muted">{column.heading}</h2>
              <ul className="mt-4 space-y-2.5 text-[13px]">
                {column.links.map((link) => (
                  <li key={link.label}>
                    {"external" in link && link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-june-muted transition-colors duration-150 hover:text-june-ink"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-june-muted transition-colors duration-150 hover:text-june-ink"
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
