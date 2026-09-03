"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UjiMark } from "@/components/brand/mark";
import { gitConfig } from "@/lib/shared";

const links = [
  { label: "Home", href: "/" },
  { label: "Design", href: "/docs/design" },
  { label: "Brand", href: "/branding" },
];

/*
 * The current page is marked twice: in the accent colour, and with a 2px bar
 * in the margin. Colour alone would carry nothing for a reader who cannot see
 * it, and the bar is what gives the rail its edge.
 */
export function RailNav() {
  const pathname = usePathname();

  return (
    <div>
      <Link
        href="/"
        aria-label="Uji, home"
        className="inline-flex text-cog-ink transition-opacity duration-150 hover:opacity-60"
      >
        <UjiMark className="size-6" />
      </Link>

      <nav aria-label="Site" className="mt-6">
        <ul className="flex flex-col">
          {links.map((link) => {
            const current = pathname === link.href;

            return (
              <li key={link.href} className="flex items-center gap-2.5 py-px">
                <span
                  aria-hidden="true"
                  className="flex size-2 shrink-0 items-center justify-center"
                >
                  <span
                    className={`block h-3 w-0.5 translate-x-1 ${
                      current ? "bg-cog-accent" : "bg-transparent"
                    }`}
                  />
                </span>
                <Link
                  href={link.href}
                  aria-current={current ? "page" : undefined}
                  className={`cog-ui transition-colors duration-150 ${
                    current ? "text-cog-accent" : "text-cog-ink hover:text-cog-accent"
                  }`}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <a
          href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
          target="_blank"
          rel="noreferrer"
          className="cog-btn cog-ui mt-4 ml-[18px] text-cog-ink"
        >
          Source
        </a>
      </nav>
    </div>
  );
}
