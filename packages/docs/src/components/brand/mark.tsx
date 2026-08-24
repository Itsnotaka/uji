import type { ComponentProps } from "react";

/*
 * The Uji mark is a U drawn as a single rising stroke with one seam cut
 * into it — the project's own rule made into a glyph: the flow runs one way
 * (client → harness → loop → provider), and there is exactly one place where
 * what is built stops and what is only named begins.
 *
 * Drawn on a 24-unit grid with butt terminals so the seam reads as a cut, not
 * a gap between two rounded ends. It still resolves at 16px: the seam closes
 * to a hairline nick and the glyph reads as a U.
 */
export function UjiMark({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
      <g stroke="currentColor" strokeWidth="2.8" strokeLinecap="butt">
        <path d="M7.5 4.2V14.2A4.5 4.5 0 0 0 16.5 14.2V12.7" />
        <path d="M16.5 11.4V4.2" />
      </g>
    </svg>
  );
}

/** Mark in a filled field, for app icons and favicons. */
export function UjiMarkField({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={className} {...props}>
      <rect width="32" height="32" rx="7.5" fill="currentColor" />
      <g
        stroke="var(--color-fd-background, #fcfcfc)"
        strokeWidth="2.5"
        strokeLinecap="butt"
        transform="translate(4 4)"
      >
        <path d="M7.5 4.2V14.2A4.5 4.5 0 0 0 16.5 14.2V12.7" />
        <path d="M16.5 11.4V4.2" />
      </g>
    </svg>
  );
}

interface WordmarkProps extends ComponentProps<"span"> {
  /** Font size in px. The lockup's gap and mark size are derived from it. */
  size?: number;
  /**
   * Lock the mark up with the word. Off by default: the mark is a U, so
   * setting it beside "Uji" stutters. The mark stands alone instead.
   */
  showMark?: boolean;
}

/*
 * The wordmark is live type, not outlines: Inter at weight 600, tracked in.
 * Keeping it as text means it inherits the page's colour and antialiasing, and
 * the mark's optical gap can be tuned in one place.
 */
export function UjiWordmark({
  size = 18,
  showMark = false,
  className,
  style,
  ...props
}: WordmarkProps) {
  return (
    <span
      className={`inline-flex items-center text-current ${className ?? ""}`}
      style={{ gap: `${size * 0.42}px`, ...style }}
      {...props}
    >
      {showMark ? <UjiMark style={{ width: size * 1.06, height: size * 1.06 }} /> : null}
      <span
        style={{
          fontSize: size,
          fontWeight: 600,
          letterSpacing: "-0.04em",
          lineHeight: 1,
        }}
      >
        Uji
      </span>
    </span>
  );
}
