import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFlags, resolveTuiResume, wantsPrint } from "../src/flags.ts";
import { encodePrintJson } from "../src/print.ts";
import { checkForUpdate, isNewerVersion, VERSION } from "../src/version.ts";
import packageMetadata from "../package.json" with { type: "json" };

void describe("run flags", () => {
  void test("parses supported switches, values, aliases, and positionals", () => {
    const cases = [
      {
        args: ["-p", "--json", "-q", "-c", "list files"],
        expected: {
          resume: { kind: "latest" },
          print: true,
          json: true,
          quiet: true,
          rest: ["list files"],
        },
      },
      {
        args: ["--provider", "openai", "--model", "gpt-5", "--effort", "high", "prompt"],
        expected: {
          resume: { kind: "new" },
          print: false,
          json: false,
          quiet: false,
          provider: "openai",
          model: "gpt-5",
          effort: "high",
          rest: ["prompt"],
        },
      },
      {
        args: ["--", "--prompt-that-starts-with-a-dash"],
        expected: {
          resume: { kind: "new" },
          print: false,
          json: false,
          quiet: false,
          rest: ["--prompt-that-starts-with-a-dash"],
        },
      },
    ];

    for (const { args, expected } of cases) assert.deepEqual(parseFlags(args), expected);
  });

  void test("rejects unknown options and missing option values", () => {
    const cases = [
      { args: ["--unknown"], message: /Unknown option '--unknown'/ },
      { args: ["-x"], message: /Unknown option '-x'/ },
      { args: ["--provider"], message: /--provider <value>.*missing/ },
      { args: ["--model"], message: /--model <value>.*missing/ },
      { args: ["--effort"], message: /--effort <value>.*missing/ },
    ];

    for (const { args, message } of cases) assert.throws(() => parseFlags(args), message);
  });

  void test("resolves a TUI resume ID after mode selection", () => {
    const parsed = parseFlags(["--resume", "session-123"]);
    assert.deepEqual(resolveTuiResume(parsed), {
      resume: { kind: "session", id: "session-123" },
      print: false,
      json: false,
      quiet: false,
      rest: [],
    });
  });

  void test("keeps positional text as the print prompt after resume", () => {
    assert.deepEqual(parseFlags(["-p", "--resume", "continue the work"]), {
      resume: { kind: "latest" },
      print: true,
      json: false,
      quiet: false,
      rest: ["continue the work"],
    });
  });

  void test("treats json or quiet as a print run", () => {
    assert.equal(wantsPrint(parseFlags(["--json", "go"]), true, true), true);
    assert.equal(wantsPrint(parseFlags(["--quiet", "go"]), true, true), true);
    assert.equal(wantsPrint(parseFlags(["hello"]), true, true), false);
    assert.equal(wantsPrint(parseFlags(["hello"]), false, true), true);
    assert.equal(wantsPrint(parseFlags([]), false, false), true);
  });
});

void describe("version", () => {
  void test("prints the package version", () => {
    assert.equal(VERSION, packageMetadata.version);
    const output = execFileSync(
      "bun",
      [fileURLToPath(new URL("../src/index.ts", import.meta.url)), "--version"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(output, `${packageMetadata.version}\n`);
  });

  void test("checks the latest GitHub release", async () => {
    const previousSkip = process.env.UJI_SKIP_VERSION_CHECK;
    delete process.env.UJI_SKIP_VERSION_CHECK;
    // One patch above the compiled version, so the test stays valid after
    // every release instead of pinning a tag that catches up.
    const [major = "0", minor = "0", patch = "0"] = VERSION.split(".");
    const newer = `v${major}.${minor}.${Number(patch) + 1}`;
    let userAgent: string | null = null;
    try {
      const update = await checkForUpdate(async (_input, init) => {
        userAgent = new Headers(init?.headers).get("User-Agent");
        return Response.json({
          tag_name: newer,
          html_url: `https://github.com/Itsnotaka/uji/releases/tag/${newer}`,
        });
      });
      assert.deepEqual(update, {
        version: newer.replace(/^v/u, ""),
        url: `https://github.com/Itsnotaka/uji/releases/tag/${newer}`,
      });
      assert.equal(userAgent, `uji/${VERSION}`);
      assert.equal(isNewerVersion(newer, VERSION), true);
      assert.equal(isNewerVersion(VERSION, VERSION), false);
      assert.equal(isNewerVersion("invalid", VERSION), false);
    } finally {
      if (previousSkip === undefined) delete process.env.UJI_SKIP_VERSION_CHECK;
      else process.env.UJI_SKIP_VERSION_CHECK = previousSkip;
    }
  });
});

void describe("print json", () => {
  void test("encodes one NDJSON object per event", () => {
    assert.equal(
      encodePrintJson({ type: "text", text: "hi\n" }),
      '{"type":"text","text":"hi\\n"}\n',
    );
    assert.equal(
      encodePrintJson({ type: "tool", name: "read", title: "Read a.ts" }),
      '{"type":"tool","name":"read","title":"Read a.ts"}\n',
    );
    assert.equal(
      encodePrintJson({
        type: "result",
        session: "abc",
        provider: "openai-codex",
        kind: "completed",
      }),
      '{"type":"result","session":"abc","provider":"openai-codex","kind":"completed"}\n',
    );
  });
});
