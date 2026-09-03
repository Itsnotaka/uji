import { renderMermaidASCII } from "beautiful-mermaid";
import { displayWidth } from "./width.ts";

const MERMAID_FENCE = /^(?<indent>[ \t]*)```[ \t]*mermaid[ \t]*$/;

function renderDiagram(source: string, maxWidth: number): string | undefined {
  try {
    const lines = renderMermaidASCII(source, {
      boxBorderPadding: 1,
      colorMode: "none",
      paddingX: 2,
      paddingY: 1,
      useAscii: false,
    })
      .split("\n")
      .map((line) => line.trimEnd());
    if (lines.every((line) => line === "")) return undefined;
    if (lines.some((line) => displayWidth(line) > maxWidth)) return undefined;
    return lines.join("\n").trimEnd();
  } catch {
    return undefined;
  }
}

/**
 * Replace complete Mermaid fences with Unicode drawings. If beautiful-mermaid
 * cannot render a fence inside the available columns, preserve its source.
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
    const drawing = renderDiagram(source, Math.max(1, maxWidth - displayWidth(indent)));
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
