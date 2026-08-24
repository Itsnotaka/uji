import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";

const command = new URL("../bin/uji.js", import.meta.url);

test("help describes the planned runner without claiming it exists", () => {
  const output = execFileSync(process.execPath, [command.pathname, "--help"], {
    encoding: "utf8",
  });

  assert.match(output, /uji serve    Run the standalone headless server/);
  assert.match(output, /The runner is not released yet/);
});

test("bare invocation fails clearly on stderr", () => {
  const result = spawnSync(process.execPath, [command.pathname], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Uji is not available yet/);
  assert.doesNotMatch(result.stderr, /successfully|Unable to|Something went wrong/);
});

test("version is machine-readable", () => {
  const output = execFileSync(process.execPath, [command.pathname, "--version"], {
    encoding: "utf8",
  });

  assert.equal(output, "0.0.1\n");
});
