import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { alignedRows, renderHelp, statusGlyph, updateSeverity } from "../src/cli-style.ts";
import { USAGE } from "../src/flags.ts";

void describe("cli-style", () => {
  const esc = String.fromCharCode(27);

  void test("help renders plain when color is off", () => {
    const help = renderHelp(false);
    assert.match(help, /usage:/u);
    assert.match(help, /commands:/u);
    assert.match(help, /uji login \[provider\]\s+sign in \(default: openai-codex\)/u);
    assert.equal(help.includes(esc), false, "no ANSI escapes without color");
  });

  void test("help wraps command labels in bold escapes when color is on", () => {
    const help = renderHelp(true);
    assert.ok(help.includes(`${esc}[1muji${esc}[0m`));
    assert.ok(help.includes(`${esc}[2msign in (default: openai-codex)${esc}[0m`));
  });

  void test("plain help and stderr usage are the same text", () => {
    assert.equal(USAGE, renderHelp(false));
  });

  void test("commands and flags share one detail column", () => {
    const help = renderHelp(false);
    const probes = [
      "open the full-screen TUI",
      "list stored credentials",
      "print the installed version",
      "override the saved provider",
      "set thinking level",
    ];
    const columns = new Set(
      probes.map((detail) => {
        const at = help.indexOf(detail);
        assert.ok(at > 0, `${detail} missing from help`);
        return at - (help.lastIndexOf("\n", at) + 1);
      }),
    );
    assert.equal(columns.size, 1);
  });

  void test("aligned rows hug the longest label by default", () => {
    assert.deepEqual(
      alignedRows(
        [
          { label: "ab", detail: "x" },
          { label: "abcd", detail: "y" },
        ],
        false,
      ),
      ["  ab    x", "  abcd  y"],
    );
  });

  void test("an explicit width pins the column and a detail-less row is just its label", () => {
    assert.deepEqual(alignedRows([{ label: "ab", detail: "x" }], false, 6), ["  ab      x"]);
    assert.deepEqual(alignedRows([{ label: "uji -p", detail: "" }], false), ["  uji -p"]);
  });

  void test("status glyphs carry the semantic color", () => {
    assert.equal(statusGlyph("ok", false), "✓");
    assert.equal(statusGlyph("warn", false), "●");
    assert.equal(statusGlyph("fail", false), "✗");
    assert.equal(statusGlyph("ok", true), `${esc}[32m✓${esc}[0m`);
  });

  void test("every update outcome has a severity", () => {
    assert.equal(updateSeverity({ kind: "updated", from: "0.0.1", to: "0.0.2", path: "/x" }), "ok");
    assert.equal(updateSeverity({ kind: "current", version: "0.0.2" }), "ok");
    assert.equal(updateSeverity({ kind: "unsupported", reason: "from source" }), "warn");
    assert.equal(updateSeverity({ kind: "failed", message: "boom" }), "fail");
  });
});
