import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand, USAGE, UsageError } from "../src/flags.ts";

void test("parses print, resume, and the prompt", () => {
  const command = parseCommand(["-p", "--resume", "list", "files"], true);
  assert.deepEqual(command, { kind: "print", resume: true, prompt: "list files" });
});

void test("opens chat when stdout is a TTY", () => {
  assert.deepEqual(parseCommand([], true), { kind: "chat", resume: false });
  assert.deepEqual(parseCommand(["-c"], true), { kind: "chat", resume: true });
});

void test("help is a command, not a prompt", () => {
  assert.deepEqual(parseCommand(["--help"], true), { kind: "help" });
  assert.deepEqual(parseCommand(["-h"], false), { kind: "help" });
});

void test("usage names the two modes and no add-on flags", () => {
  assert.match(USAGE, /uji\s+open the TUI/);
  assert.match(USAGE, /-p "<prompt>"/);
  assert.doesNotMatch(
    USAGE,
    /--provider|--model|--effort|successfully|Unable to|Something went wrong/,
  );
});

void test("rejects add-on flags", () => {
  assert.throws(() => parseCommand(["--provider", "openai"], true), /Couldn't use --provider/);
  assert.throws(() => parseCommand(["--model", "x"], true), /Couldn't use --model/);
  assert.throws(() => parseCommand(["--effort", "low"], true), /Couldn't use --effort/);
});

void test("login and logout are commands, with an optional provider", () => {
  assert.deepEqual(parseCommand(["login"], true), { kind: "login" });
  assert.deepEqual(parseCommand(["login", "anthropic"], true), {
    kind: "login",
    provider: "anthropic",
  });
  assert.deepEqual(parseCommand(["logout"], true), { kind: "logout" });
  assert.deepEqual(parseCommand(["logout", "openai"], true), {
    kind: "logout",
    provider: "openai",
  });
  assert.throws(
    () => parseCommand(["login", "a", "b"], true),
    (error: unknown) => error instanceof UsageError,
  );
});

void test("print without a prompt is usage", () => {
  assert.throws(
    () => parseCommand(["-p"], true),
    (error: unknown) => error instanceof UsageError,
  );
  assert.throws(
    () => parseCommand([], false),
    (error: unknown) => error instanceof UsageError,
  );
});
