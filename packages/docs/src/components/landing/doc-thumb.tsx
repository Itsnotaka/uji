export type ThumbKind = "flow" | "seam" | "stack" | "log" | "lattice";

/*
 * Card thumbnails are drawn, not photographed: each kind is the smallest
 * diagram that says what the document is about. Hairlines stay hairline at
 * any card width via non-scaling strokes.
 */

const STROKE = { vectorEffect: "non-scaling-stroke" } as const;

export function DocThumb({ kind }: { kind: ThumbKind }) {
  return (
    <svg
      viewBox="0 0 160 96"
      fill="none"
      aria-hidden="true"
      className="pointer-events-none w-full text-cog-dim select-none"
    >
      {THUMBS[kind]}
    </svg>
  );
}

const THUMBS: Record<ThumbKind, React.ReactNode> = {
  /* Three nodes on a path; the middle one is where you are. */
  flow: (
    <g strokeLinecap="square" stroke="currentColor">
      <path d="M38 48H62M98 48h24" strokeWidth={1} {...STROKE} />
      <path d="M118 44l6 4-6 4" strokeWidth={1} {...STROKE} />
      <rect x={22} y={40} width={16} height={16} strokeWidth={1} {...STROKE} />
      <rect
        x={72}
        y={40}
        width={16}
        height={16}
        className="fill-cog-wash text-cog-ink"
        strokeWidth={1}
        {...STROKE}
      />
      <rect x={122} y={40} width={16} height={16} strokeWidth={1} {...STROKE} />
    </g>
  ),

  /* Two regions and the rule between them; the seam is the subject. */
  seam: (
    <g strokeLinecap="square" stroke="currentColor">
      <path
        d="M80 20v56"
        className="text-cog-ink"
        strokeWidth={1}
        strokeDasharray="4 3"
        {...STROKE}
      />
      <rect x={28} y={36} width={32} height={24} strokeWidth={1} {...STROKE} />
      <rect x={100} y={30} width={32} height={12} strokeWidth={1} {...STROKE} />
      <rect x={100} y={54} width={32} height={12} strokeWidth={1} {...STROKE} />
    </g>
  ),

  /* Three planes seen edge-on; the top one is the interface. */
  stack: (
    <g strokeLinecap="square" stroke="currentColor">
      <rect x={44} y={58} width={72} height={14} strokeWidth={1} {...STROKE} />
      <rect x={52} y={41} width={72} height={14} strokeWidth={1} {...STROKE} />
      <rect
        x={60}
        y={24}
        width={72}
        height={14}
        className="fill-cog-wash text-cog-ink"
        strokeWidth={1}
        {...STROKE}
      />
    </g>
  ),

  /* Transcript rows; the last line is still being written. */
  log: (
    <g strokeLinecap="square" stroke="currentColor">
      <path d="M28 30h64M28 42h88M28 54h48" strokeWidth={1} {...STROKE} />
      <path d="M28 66h72" className="text-cog-ink" strokeWidth={1} {...STROKE} />
      <path d="M104 61v10" className="text-cog-ink" strokeWidth={1} {...STROKE} />
    </g>
  ),

  /* A grid of tools with the paths between them; one node selected. */
  lattice: (
    <g stroke="currentColor">
      <path d="M50 34h24v28h24M74 62v18M98 34h12" strokeWidth={1} {...STROKE} />
      {[
        [50, 34],
        [74, 34],
        [110, 34],
        [50, 62],
        [74, 62],
        [98, 62],
        [74, 80],
      ].map(([cx, cy]) => (
        <circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r={2.5}
          className={cx === 74 && cy === 62 ? "fill-cog-ink" : "fill-cog-bg stroke-cog-dim"}
          strokeWidth={1}
          {...STROKE}
        />
      ))}
    </g>
  ),
};
