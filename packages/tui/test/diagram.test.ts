import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseDiagram, renderDiagram, renderDiagramFences } from "../src/diagram.ts";
import { displayWidth, truncateDisplay } from "../src/width.ts";

const fence = (body: string): string => `\`\`\`mermaid\n${body}\n\`\`\``;

function drawn(body: string): string {
  const graph = parseDiagram(body);
  assert.ok(graph !== undefined, body);
  const drawing = renderDiagram(graph, 100);
  assert.ok(drawing !== undefined, body);
  return drawing;
}

void describe("display width", () => {
  void test("counts a CJK cell as two columns and a combining mark as none", () => {
    assert.equal(displayWidth("abc"), 3);
    assert.equal(displayWidth("日本語"), 6);
    assert.equal(displayWidth("ﾊﾝｶｸ"), 4);
    assert.equal(displayWidth("e\u0301"), 1);
  });

  void test("never cuts a wide grapheme in half", () => {
    assert.equal(truncateDisplay("日本語", 5), "日本");
    assert.equal(truncateDisplay("日本語", 6), "日本語");
    assert.equal(truncateDisplay("日本語", 5, "…"), "日本…");
  });
});

void describe("mermaid diagrams", () => {
  void test("draws a chain top-down with even box widths", () => {
    const drawing = drawn("graph TD\nA[One] --> B[Two]");
    assert.deepEqual(drawing.split("\n"), [
      "┌─────┐",
      "│ One │",
      "└─────┘",
      "   │",
      "   ▼",
      "┌─────┐",
      "│ Two │",
      "└─────┘",
    ]);
  });

  void test("branches into a labelled fork", () => {
    const lines = drawn("graph TD\nB{Choice} -->|yes| C[Ship]\nB -->|no| D[Stop]").split("\n");
    assert.ok(
      lines.some((line) => line.includes("┴")),
      lines.join("\n"),
    );
    assert.ok(
      lines.some((line) => line.includes("▼ yes") && line.includes("▼ no")),
      lines.join("\n"),
    );
    assert.ok(lines.every((line) => displayWidth(line) <= displayWidth(lines[3] ?? "") + 40));
  });

  void test("keeps a box square around CJK labels", () => {
    const lines = drawn("graph TD\nA[日本語] --> B[ok]").split("\n");
    const [top, middle, bottom] = lines;
    assert.equal(displayWidth(top ?? ""), displayWidth(middle ?? ""));
    assert.equal(displayWidth(middle ?? ""), displayWidth(bottom ?? ""));
    assert.equal(displayWidth(middle ?? ""), 10);
  });

  void test("lays LR out top-down because columns are the scarce axis", () => {
    assert.equal(drawn("flowchart LR\nA[One] --> B[Two]"), drawn("graph TD\nA[One] --> B[Two]"));
  });

  void test("refuses shapes a tree cannot carry", () => {
    const refused = (body: string): string | undefined => {
      const graph = parseDiagram(body);
      assert.ok(graph !== undefined, body);
      return renderDiagram(graph, 100);
    };
    // Two parents for one node, and a cycle.
    assert.equal(refused("graph TD\nA-->C\nB-->C"), undefined);
    assert.equal(refused("graph TD\nA-->B\nB-->A"), undefined);
    // Not a flowchart at all.
    assert.equal(parseDiagram("sequenceDiagram\nA->>B: hi"), undefined);
    assert.equal(parseDiagram("graph TD\nsubgraph one\nA-->B\nend"), undefined);
  });

  void test("replaces only the fences it can draw", () => {
    const source = `intro\n\n${fence("graph TD\nA[One] --> B[Two]")}\n\nmid\n\n${fence("sequenceDiagram\nA->>B: hi")}\n`;
    const rendered = renderDiagramFences(source, 100);
    assert.match(rendered, /│ One │/);
    assert.doesNotMatch(rendered, /A\[One\]/);
    // The undrawable fence keeps its language tag and its source.
    assert.match(rendered, /```mermaid\nsequenceDiagram/);
    assert.match(rendered, /^intro$/m);
    assert.match(rendered, /^mid$/m);
  });

  void test("leaves an unterminated fence alone", () => {
    const source = "```mermaid\ngraph TD\nA --> B";
    assert.equal(renderDiagramFences(source, 100), source);
  });
});
