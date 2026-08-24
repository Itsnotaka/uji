/*
 * The page's fifteen column lines, drawn once behind everything and stretched
 * to the full height of the document so they run unbroken from the first
 * statement to the last card. Only six of the fifteen carry a hairline: the
 * lines that content is actually placed against. Ruling all fifteen would turn
 * a measured page into graph paper.
 *
 * Line 0 is the left gutter, 3 closes the nav rail, 4 opens the column the
 * section numbers sit in, 11 closes the reading measure, 12 and 14 carry the
 * panel, and 15 is the right gutter.
 */
const RULED_LINES = new Set([0, 3, 4, 11, 12, 14]);
const EDGE_LINES = new Set([0, 14]);

export function GridLines() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      <div className="cog-container h-full">
        <div className="cog-grid h-full">
          {Array.from({ length: 15 }, (_, column) => (
            <span
              key={column}
              className={[
                "h-full",
                RULED_LINES.has(column) ? "cog-line" : "",
                EDGE_LINES.has(column) ? "cog-line-edge" : "",
                column === 14 ? "cog-line-end" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
