"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheckmark2, IconClipboard } from "central-icons";

/*
 * Copy control used throughout /branding. The icon swaps in place with a scale
 * and blur crossfade rather than a size change, so the row never reflows, and
 * the label keeps a fixed width for the same reason.
 */
export function CopyValue({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      }}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className={`june-ghost inline-flex min-h-11 items-center gap-2 rounded-(--radius-june-control) px-3 text-[12px] text-june-muted hover:text-june-ink ${className ?? ""}`}
    >
      <span className="relative inline-block size-3.5 shrink-0">
        {/* Central Icons bake the stroke into the variant, so there is no
            strokeWidth to pass — only a size. */}
        <IconClipboard
          size={14}
          ariaHidden
          className={`absolute inset-0 transition-[opacity,transform,filter] duration-200 ${
            copied ? "scale-75 opacity-0 blur-[2px]" : "scale-100 opacity-100 blur-0"
          }`}
        />
        <IconCheckmark2
          size={14}
          ariaHidden
          className={`absolute inset-0 text-june-signal transition-[opacity,transform,filter] duration-200 ${
            copied ? "scale-100 opacity-100 blur-0" : "scale-75 opacity-0 blur-[2px]"
          }`}
        />
      </span>
      {/* The label never changes text — only the icon does — so the control
          keeps its width and nothing around it reflows on copy. */}
      <span className="june-label">{label}</span>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
