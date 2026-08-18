import Link from "next/link";
import { ThemeSwitch } from "fumadocs-ui/layouts/shared/slots/theme-switch";
import { JuneWordmark } from "@/components/brand/mark";
import { gitConfig } from "@/lib/shared";

/*
 * Header for the marketing surfaces. It sits in normal flow rather than fixed,
 * carries no rule and no fill, and scrolls away with the page — the only
 * persistent chrome on this site is the docs sidebar.
 */
export function SiteHeader() {
  return (
    <header className="w-full">
      <div className="mx-auto flex h-[72px] max-w-(--june-page) items-center justify-between px-(--june-gutter)">
        <Link href="/" className="-mx-2 rounded-sm px-2 py-1 text-june-ink" aria-label="June, home">
          <JuneWordmark size={19} />
        </Link>

        <nav className="flex items-center gap-1 text-[13px]">
          <HeaderLink href="/docs">Docs</HeaderLink>
          <HeaderLink href="/branding">Brand</HeaderLink>
          <HeaderLink href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`} external>
            GitHub
          </HeaderLink>
          <ThemeSwitch className="ml-2" mode="light-dark" />
        </nav>
      </div>
    </header>
  );
}

function HeaderLink({
  href,
  external,
  children,
}: {
  href: string;
  external?: boolean;
  children: React.ReactNode;
}) {
  const className =
    "rounded-sm px-3 py-2 text-june-muted transition-colors duration-150 hover:text-june-ink";

  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
