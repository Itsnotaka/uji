"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { DocThumb, type ThumbKind } from "@/components/landing/doc-thumb";

export interface DocCard {
  title: string;
  kind: ThumbKind;
  meta: string;
  href: string;
}

/*
 * A horizontal rail rather than a grid: the documentation is a set of entry
 * points, not a ranked list, and cutting the last card at the page edge says
 * "there is more here" without a label that says so.
 *
 * The arrows page by one card. They disable at each end rather than wrapping,
 * because wrapping hides where the set stops.
 */
export function DocRail({ cards }: { cards: DocCard[] }) {
  const railRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const sync = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const max = rail.scrollWidth - rail.clientWidth;
    setAtStart(rail.scrollLeft <= 1);
    setAtEnd(rail.scrollLeft >= max - 1);
  }, []);

  useEffect(() => {
    sync();
    const rail = railRef.current;
    if (!rail) return;
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [sync]);

  const page = (direction: 1 | -1) => {
    const rail = railRef.current;
    if (!rail) return;
    const card = rail.firstElementChild;
    const step = card instanceof HTMLElement ? card.offsetWidth + 8 : rail.clientWidth;
    rail.scrollBy({ left: step * direction });
  };

  return (
    <>
      <div className="col-span-full flex items-end justify-between pb-4">
        <p className="cog-num">04. Documentation</p>

        <div className="flex gap-1">
          <RailButton label="Previous documents" disabled={atStart} onClick={() => page(-1)}>
            <Chevron direction="left" />
          </RailButton>
          <RailButton label="Next documents" disabled={atEnd} onClick={() => page(1)}>
            <Chevron direction="right" />
          </RailButton>
        </div>
      </div>

      <div ref={railRef} onScroll={sync} className="cog-rail col-span-full">
        {cards.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="cog-rail-card group flex flex-col gap-3"
          >
            <DocThumb kind={card.kind} />
            <div>
              <p className="cog-prose text-cog-ink transition-colors duration-150 group-hover:text-cog-accent">
                {card.title}
              </p>
              <p className="cog-prose text-cog-dim">{card.meta}</p>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}

function RailButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 items-center justify-center border border-cog-ink text-cog-ink transition-colors duration-150 hover:bg-cog-ink hover:text-cog-bg disabled:border-cog-rule disabled:text-cog-dim disabled:hover:bg-transparent disabled:hover:text-cog-dim"
    >
      {children}
    </button>
  );
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
      <path
        d={direction === "left" ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5"}
        stroke="currentColor"
        strokeWidth={1.25}
      />
    </svg>
  );
}
