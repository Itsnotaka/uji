/**
 * A change receipt around a visibility-loaded Pierre renderer. The patch is
 * selectable plain text on first paint. Once a visible patch has upgraded,
 * its content identity skips that fallback when the same diff is revisited.
 */
import * as stylex from "@stylexjs/stylex";
import { memo, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { diffStyles } from "./styles.stylex.ts";
import type { ParsedDiff } from "./tool-detail.ts";

type PierrePatchRenderer = typeof import("./pierre-patch.tsx").PierrePatch;

let pierrePatchRenderer: PierrePatchRenderer | undefined;
let pierrePatchRequest: Promise<PierrePatchRenderer | undefined> | undefined;
const renderedDiffs = new Map<string, true>();
const RENDERED_DIFF_LIMIT = 64;

function loadPierrePatch(): Promise<PierrePatchRenderer | undefined> {
  if (pierrePatchRenderer !== undefined) return Promise.resolve(pierrePatchRenderer);
  if (pierrePatchRequest !== undefined) return pierrePatchRequest;
  pierrePatchRequest = import("./pierre-patch.tsx").then(
    (module) => {
      pierrePatchRenderer = module.PierrePatch;
      return pierrePatchRenderer;
    },
    () => undefined,
  );
  return pierrePatchRequest;
}

function diffIdentity(path: string, patch: string): string {
  return `${String(path.length)}:${path}${patch}`;
}

function rememberDiff(identity: string): void {
  renderedDiffs.delete(identity);
  renderedDiffs.set(identity, true);
  if (renderedDiffs.size > RENDERED_DIFF_LIMIT) {
    const oldest = renderedDiffs.keys().next().value;
    if (oldest !== undefined) renderedDiffs.delete(oldest);
  }
}

export const DiffCard = memo(function DiffCard({
  path,
  diff,
  fill = false,
}: {
  readonly path: string;
  readonly diff: ParsedDiff;
  readonly fill?: boolean;
}): ReactElement {
  const identity = diffIdentity(path, diff.patch);
  const card = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(() => renderedDiffs.has(identity));
  const [loadedRenderer, setLoadedRenderer] = useState<PierrePatchRenderer | undefined>(() =>
    renderedDiffs.has(identity) ? pierrePatchRenderer : undefined,
  );
  const Renderer = loadedRenderer ?? (nearViewport ? pierrePatchRenderer : undefined);

  useEffect(() => {
    if (nearViewport) return;
    const element = card.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [nearViewport]);

  useEffect(() => {
    if (!nearViewport || Renderer !== undefined) return;
    let cancelled = false;
    const idle = window.requestIdleCallback(
      () => {
        void loadPierrePatch().then((next) => {
          if (!cancelled && next !== undefined) setLoadedRenderer(() => next);
        });
      },
      { timeout: 500 },
    );
    return () => {
      cancelled = true;
      window.cancelIdleCallback(idle);
    };
  }, [nearViewport, Renderer]);

  useEffect(() => {
    if (nearViewport && Renderer !== undefined) rememberDiff(identity);
  }, [identity, nearViewport, Renderer]);

  const reservedHeight = Math.min(320, Math.max(80, diff.displayLines * 20));

  return (
    <div ref={card} {...stylex.props(diffStyles.card, fill && diffStyles.cardFill)}>
      <div {...stylex.props(diffStyles.header)}>
        <span title={path} {...stylex.props(diffStyles.path)}>
          {path}
        </span>
        <span
          aria-label={`${String(diff.added)} added, ${String(diff.removed)} removed`}
          {...stylex.props(diffStyles.stats)}
        >
          {diff.added > 0 && <span {...stylex.props(diffStyles.added)}>+{diff.added}</span>}
          {diff.removed > 0 && <span {...stylex.props(diffStyles.removed)}>-{diff.removed}</span>}
        </span>
      </div>
      <div
        data-uji-scrollport="balanced"
        {...stylex.props(diffStyles.body, fill && diffStyles.bodyFill)}
        style={{ minHeight: reservedHeight }}
      >
        {nearViewport && Renderer !== undefined ? (
          <Renderer patch={diff.patch} />
        ) : (
          <pre aria-label={`Diff for ${path}`} {...stylex.props(diffStyles.fallback)}>
            {diff.patch}
          </pre>
        )}
      </div>
    </div>
  );
});
