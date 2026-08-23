/**
 * Mermaid flowcharts drawn with box characters. Models emit them constantly
 * and a terminal turns them into unreadable source, so the common subset —
 * declarations and arrows in a tree — becomes a picture and everything else
 * stays the code block it already was.
 *
 * Layout is always top-down. `LR` costs terminal columns, which are the one
 * thing a transcript cannot spare, and a vertical tree carries the same edges.
 */
import { displayWidth, padDisplay } from "./width.ts";

export interface DiagramNode {
  readonly id: string;
  readonly label: string;
}

export interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export interface DiagramGraph {
  readonly nodes: ReadonlyMap<string, DiagramNode>;
  readonly edges: readonly DiagramEdge[];
}

/** Columns between sibling subtrees. */
const GAP = 2;

const HEADER = /^(?:graph|flowchart)(?:\s+(?:TB|TD|BT|LR|RL))?\s*$/;
const EDGE = /^(.*?)\s*(?:-{2,}|-\.-*|={2,})>?\s*(?:\|([^|]*)\|)?\s*(.*)$/;
const ARROW = /(?:-{2,}|-\.-*|={2,})>?/;
const NODE = /^([A-Za-z0-9_-]+)(?:(\[\[|\[|\(\(|\(|\{|>)(.*?)(?:\]\]|\]|\)\)|\)|\}))?$/;

function cleanLabel(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replaceAll(/<br\s*\/?>/gi, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

/**
 * Parse the flowchart subset: a header, node declarations, and arrows that may
 * chain. Styling, subgraphs, and click handlers mean this is not a shape we
 * can draw, so the whole fence is refused rather than half rendered.
 */
export function parseDiagram(source: string): DiagramGraph | undefined {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const header = lines.shift();
  if (header === undefined || !HEADER.test(header)) return undefined;

  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  const declare = (token: string): string | undefined => {
    const match = NODE.exec(token.trim());
    if (match === null) return undefined;
    const [, id, , rawLabel] = match;
    if (id === undefined) return undefined;
    const label = rawLabel === undefined ? id : cleanLabel(rawLabel);
    const existing = nodes.get(id);
    if (existing === undefined || (existing.label === id && label !== id)) {
      nodes.set(id, { id, label: label === "" ? id : label });
    }
    return id;
  };

  for (const statement of lines.flatMap((line) => line.split(";"))) {
    const line = statement.trim();
    if (line === "" || line.startsWith("%%")) continue;
    if (!ARROW.test(line)) {
      if (declare(line) === undefined) return undefined;
      continue;
    }
    let rest = line;
    let from: string | undefined;
    while (ARROW.test(rest)) {
      const match = EDGE.exec(rest);
      if (match === null) return undefined;
      const [, left, label = "", right] = match;
      if (left === undefined || right === undefined) return undefined;
      const source_ = from ?? declare(left);
      if (source_ === undefined) return undefined;
      const nextArrow = ARROW.exec(right);
      const targetToken = nextArrow === null ? right : right.slice(0, nextArrow.index);
      const target = declare(targetToken);
      if (target === undefined) return undefined;
      edges.push({ from: source_, to: target, label: cleanLabel(label) });
      if (nextArrow === null) break;
      from = target;
      rest = right.slice(nextArrow.index);
    }
  }
  if (nodes.size === 0) return undefined;
  return { nodes, edges };
}

interface Block {
  readonly lines: readonly string[];
  readonly width: number;
  /** Column the parent's arrow points at. */
  readonly center: number;
}

function boxBlock(label: string): Block {
  const inner = displayWidth(label) + 2;
  return {
    lines: [`┌${"─".repeat(inner)}┐`, `│ ${label} │`, `└${"─".repeat(inner)}┘`],
    width: inner + 2,
    center: Math.floor((inner + 2) / 2),
  };
}

function padLeft(block: Block, amount: number): Block {
  if (amount <= 0) return block;
  const pad = " ".repeat(amount);
  return {
    lines: block.lines.map((line) => pad + line),
    width: block.width + amount,
    center: block.center + amount,
  };
}

function padRight(block: Block, amount: number): Block {
  if (amount <= 0) return block;
  return { ...block, width: block.width + amount };
}

function stack(blocks: readonly Block[], gap: number): { lines: string[]; centers: number[] } {
  const height = Math.max(...blocks.map((block) => block.lines.length));
  const lines: string[] = [];
  const centers: number[] = [];
  let offset = 0;
  for (const [index, block] of blocks.entries()) {
    centers.push(offset + block.center);
    offset += block.width + (index === blocks.length - 1 ? 0 : gap);
  }
  for (let row = 0; row < height; row++) {
    let line = "";
    for (const [index, block] of blocks.entries()) {
      line = padDisplay(line, index === 0 ? 0 : displayWidth(line) + gap);
      const cell = block.lines[row] ?? "";
      line += padDisplay(cell, block.width);
    }
    lines.push(line.trimEnd());
  }
  return { lines, centers };
}

function place(marks: ReadonlyMap<number, string>, width: number): string {
  let line = "";
  for (let column = 0; column < width; column++) {
    const mark = marks.get(column);
    if (mark === undefined) {
      line += " ";
      continue;
    }
    line += mark;
    column += displayWidth(mark) - 1;
  }
  return line.trimEnd();
}

/** The rows joining one box to the boxes under it. */
function connectors(
  parentCenter: number,
  children: readonly { center: number; label: string }[],
  width: number,
): string[] {
  const rows = [place(new Map([[parentCenter, "│"]]), width)];
  const first = children[0];
  const last = children[children.length - 1];
  if (first === undefined || last === undefined) return rows;
  if (children.length > 1 || first.center !== parentCenter) {
    const bar = new Map<number, string>();
    for (let column = first.center; column <= last.center; column++) {
      const onChild = children.some((child) => child.center === column);
      const onParent = column === parentCenter;
      if (onChild && onParent) bar.set(column, "┼");
      else if (column === first.center) bar.set(column, onParent ? "├" : "┌");
      else if (column === last.center) bar.set(column, onParent ? "┤" : "┐");
      else if (onChild) bar.set(column, "┬");
      else if (onParent) bar.set(column, "┴");
      else bar.set(column, "─");
    }
    rows.push(place(bar, width));
  }
  const arrows = new Map<number, string>();
  for (const child of children) {
    arrows.set(child.center, child.label === "" ? "▼" : `▼ ${child.label}`);
  }
  rows.push(place(arrows, width));
  return rows;
}

function subtree(
  graph: DiagramGraph,
  id: string,
  childrenOf: ReadonlyMap<string, readonly DiagramEdge[]>,
): Block {
  const node = graph.nodes.get(id);
  const box = boxBlock(node?.label ?? id);
  const edges = childrenOf.get(id) ?? [];
  if (edges.length === 0) return box;

  const blocks = edges.map((edge) => {
    const child = subtree(graph, edge.to, childrenOf);
    // The arrow's label lives beside the arrowhead, so the child's subtree
    // owns the columns it needs.
    return edge.label === "" ? child : padRight(child, displayWidth(edge.label) + 1);
  });
  const below = stack(blocks, GAP);
  const first = below.centers[0] ?? 0;
  const last = below.centers[below.centers.length - 1] ?? first;
  const desired = Math.floor((first + last) / 2);
  const shift = Math.max(0, box.center - desired);
  const centered = padLeft(box, desired - box.center + shift);
  const childLines = below.lines.map((line) => " ".repeat(shift) + line);
  const centers = below.centers.map((center) => center + shift);
  const width = Math.max(
    centered.width,
    ...childLines.map((line) => displayWidth(line)),
    (centers[centers.length - 1] ?? 0) + 1,
  );
  const joins = connectors(
    centered.center,
    centers.map((center, index) => ({ center, label: edges[index]?.label ?? "" })),
    width,
  );
  return {
    lines: [...centered.lines, ...joins, ...childLines],
    width: Math.max(width, ...joins.map((line) => displayWidth(line))),
    center: centered.center,
  };
}

/**
 * Draw a parsed flowchart, or refuse. A node with two parents is a graph, not
 * a tree, and routing that in text costs more than it returns; a cycle has no
 * top; an oversized drawing wraps into noise. Each of those keeps its source.
 */
export function renderDiagram(graph: DiagramGraph, maxWidth: number): string | undefined {
  const childrenOf = new Map<string, DiagramEdge[]>();
  const parents = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) return undefined;
    const siblings = childrenOf.get(edge.from) ?? [];
    siblings.push(edge);
    childrenOf.set(edge.from, siblings);
    const count = (parents.get(edge.to) ?? 0) + 1;
    if (count > 1) return undefined;
    parents.set(edge.to, count);
  }
  const roots = [...graph.nodes.keys()].filter((id) => !parents.has(id));
  if (roots.length === 0) return undefined;

  const reached = new Set<string>();
  const walk = (id: string): boolean => {
    if (reached.has(id)) return false;
    reached.add(id);
    return (childrenOf.get(id) ?? []).every((edge) => walk(edge.to));
  };
  if (!roots.every((id) => walk(id))) return undefined;
  if (reached.size !== graph.nodes.size) return undefined;

  const { lines } = stack(
    roots.map((id) => subtree(graph, id, childrenOf)),
    GAP,
  );
  if (lines.some((line) => displayWidth(line) > maxWidth)) return undefined;
  return lines.join("\n");
}

const MERMAID_FENCE = /^(?<indent>[ \t]*)```[ \t]*mermaid[ \t]*$/;

/**
 * Swap every mermaid fence a drawing can be made from for the drawing, in a
 * plain fence so no grammar recolors the box characters. Fences that parse to
 * something undrawable are left exactly as the model wrote them.
 */
export function renderDiagramFences(markdown: string, maxWidth: number): string {
  if (!markdown.includes("```")) return markdown;
  const lines = markdown.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const open = MERMAID_FENCE.exec(line);
    if (open === null) {
      output.push(line);
      continue;
    }
    const indent = open.groups?.indent ?? "";
    const close = lines.findIndex(
      (candidate, position) => position > index && candidate.trim() === "```",
    );
    if (close === -1) {
      output.push(line);
      continue;
    }
    const source = lines.slice(index + 1, close).join("\n");
    const graph = parseDiagram(source);
    const drawing = graph === undefined ? undefined : renderDiagram(graph, maxWidth);
    if (drawing === undefined) {
      output.push(...lines.slice(index, close + 1));
    } else {
      output.push(`${indent}\`\`\``);
      output.push(...drawing.split("\n").map((row) => `${indent}${row}`));
      output.push(`${indent}\`\`\``);
    }
    index = close;
  }
  return output.join("\n");
}
