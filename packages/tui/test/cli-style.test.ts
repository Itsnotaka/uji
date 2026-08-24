import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { columnWidth, fieldRow, isPercentLine, renderHelp, statusGlyph } from "../src/cli-style.ts";
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

  void test("every help row aligns descriptions to one column", () => {
    const help = renderHelp(false);
    const probes = [
      "open the full-screen TUI",
      "sign in (default: openai-codex)",
      "list stored credentials",
      "print the installed version",
    ];
    const columns = new Set(
      probes.map((description) => {
        const at = help.indexOf(description);
        assert.ok(at > 0, `${description} missing from help`);
        return at - (help.lastIndexOf("\n", at) + 1);
      }),
    );
    assert.equal(columns.size, 1);
  });

  void test("fieldRow pads the label column and prefixes the glyph", () => {
    assert.equal(fieldRow("ab", "x", 4, false), "  ab    x");
    assert.equal(fieldRow("ab", "x", 4, false, "✓"), "✓ ab    x");
    assert.equal(fieldRow("abcd", "x", 2, false), "  abcd  x");
  });

  void test("columnWidth takes the longest label", () => {
    assert.equal(columnWidth(["a", "abc", "ab"]), 3);
    assert.equal(columnWidth([]), 0);
  });

  void test("percent progress lines are recognized exactly", () => {
    assert.equal(isPercentLine("45%"), true);
    assert.equal(isPercentLine("  0%"), true);
    assert.equal(isPercentLine("100%"), true);
    assert.equal(isPercentLine("45"), false);
    assert.equal(isPercentLine("45% done"), false);
    assert.equal(isPercentLine("Downloading x.tar.gz …"), false);
  });

  void test("status glyphs carry the semantic color", () => {
    assert.equal(statusGlyph("ok", false), "✓");
    assert.equal(statusGlyph("warn", false), "●");
    assert.equal(statusGlyph("fail", false), "✗");
    assert.equal(statusGlyph("ok", true), `${esc}[32m✓${esc}[0m`);
  });
});
