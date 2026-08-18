import type { ComponentProps } from "react";

export function SiteHeader({ className }: Pick<ComponentProps<"header">, "className">) {
  return (
    <header
      className={`mx-auto flex h-20 w-full max-w-[1440px] items-center justify-between px-5 md:px-10 ${className ?? ""}`}
    >
      <a
        className="text-[15px] font-semibold tracking-[-0.03em]"
        href="#top"
        aria-label="June home"
      >
        June
      </a>
      <nav className="flex items-center gap-5 text-xs text-ink-foreground/60" aria-label="Primary">
        <a className="hover:text-ink-foreground" href="#core">
          Core
        </a>
        <a
          className="rounded-lg bg-ink-foreground px-3 py-2 font-medium text-ink hover:bg-ink-foreground/85"
          href="https://github.com/Itsnotaka/june"
          rel="noreferrer"
          target="_blank"
        >
          GitHub
        </a>
      </nav>
    </header>
  );
}
