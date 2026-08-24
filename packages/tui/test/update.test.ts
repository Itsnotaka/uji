import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  describeUpdateOutcome,
  installedBinaryPath,
  parseSha256,
  releaseAssetName,
  resolveUpdateTarget,
  selfUpdate,
} from "../src/update.ts";
import { VERSION } from "../src/version.ts";

const execFileAsync = promisify(execFile);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

void describe("update helpers", () => {
  void test("names the release asset the way scripts/package.sh stages it", () => {
    assert.equal(releaseAssetName("0.2.0", "darwin", "arm64"), "uji-v0.2.0-darwin-arm64");
    assert.equal(releaseAssetName("v0.2.0", "linux", "x64"), "uji-v0.2.0-linux-x64");
    assert.equal(releaseAssetName("0.2.0", "win32", "x64"), undefined);
    assert.equal(releaseAssetName("0.2.0", "linux", "ia32"), undefined);
  });

  void test("reads the digest from a shasum line and rejects anything else", () => {
    const digest = "a".repeat(64);
    assert.equal(parseSha256(`${digest}  uji-v0.2.0-darwin-arm64.tar.gz\n`), digest);
    assert.equal(parseSha256(`${digest.toUpperCase()} *file`), digest);
    assert.equal(parseSha256("not a digest"), undefined);
    assert.equal(parseSha256(""), undefined);
  });

  void test("finds the binary only when running as a compiled executable", () => {
    assert.equal(
      installedBinaryPath("file:///$bunfs/root/binary.ts", "/opt/uji/uji"),
      "/opt/uji/uji",
    );
    assert.equal(
      installedBinaryPath("file:///home/me/uji/src/update.ts", "/usr/bin/bun"),
      undefined,
    );
    assert.equal(
      installedBinaryPath("file:///home/me/uji/src/update.ts", "/usr/bin/node"),
      undefined,
    );
    assert.equal(
      installedBinaryPath("file:///home/me/uji/src/update.ts", "/home/me/.local/bin/uji"),
      "/home/me/.local/bin/uji",
    );
  });

  void test("resolves the target: explicit version, newer latest, or already current", async () => {
    assert.deepEqual(await resolveUpdateTarget({ version: "v9.9.9" }, "0.0.1"), {
      kind: "install",
      version: "9.9.9",
      explicit: true,
    });
    assert.deepEqual(await resolveUpdateTarget({ version: "0.0.1" }, "0.0.1"), {
      kind: "current",
      version: "0.0.1",
    });
    assert.equal((await resolveUpdateTarget({ version: "latest" }, "0.0.1")).kind, "failed");

    const newer = async (): Promise<Response> => jsonResponse({ tag_name: "v0.5.0" });
    assert.deepEqual(await resolveUpdateTarget({ fetchFn: newer }, "0.0.1"), {
      kind: "install",
      version: "0.5.0",
      explicit: false,
    });
    const older = async (): Promise<Response> => jsonResponse({ tag_name: "v0.0.1" });
    assert.deepEqual(await resolveUpdateTarget({ fetchFn: older }, "0.0.1"), {
      kind: "current",
      version: "0.0.1",
    });
    const down = async (): Promise<Response> => jsonResponse({}, 503);
    assert.equal((await resolveUpdateTarget({ fetchFn: down }, "0.0.1")).kind, "failed");
  });

  void test("refuses to update a source checkout", async () => {
    // The test runner is node, so there is no compiled binary to replace.
    assert.equal(installedBinaryPath(), undefined);
    const outcome = await selfUpdate({ fetchFn: async () => jsonResponse({ tag_name: "v9.9.9" }) });
    assert.equal(outcome.kind, "unsupported");
    assert.match(describeUpdateOutcome(outcome), /running from source/u);
  });

  void test("describes every outcome on one line", () => {
    assert.match(
      describeUpdateOutcome({ kind: "updated", from: "0.0.1", to: "0.2.0", path: "/x/uji" }),
      /^Updated uji 0\.0\.1 → 0\.2\.0 at \/x\/uji\. Restart uji to use it\.$/u,
    );
    assert.equal(
      describeUpdateOutcome({ kind: "current", version: "0.2.0" }),
      "uji 0.2.0 is the latest release.",
    );
    assert.equal(describeUpdateOutcome({ kind: "unsupported", reason: "no" }), "no");
    assert.equal(describeUpdateOutcome({ kind: "failed", message: "boom" }), "boom");
  });
});

void describe("selfUpdate", () => {
  void test("downloads, verifies, and swaps the binary in place; a bad checksum leaves it alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uji-update-test-"));
    try {
      const binary = join(dir, "uji");
      await writeFile(binary, "#!/bin/sh\necho old\n", { mode: 0o755 });

      const asset = releaseAssetName("9.9.9");
      assert.notEqual(asset, undefined);
      const stage = join(dir, "stage");
      await execFileAsync("mkdir", ["-p", stage]);
      await writeFile(join(stage, "uji"), "#!/bin/sh\necho new\n", { mode: 0o755 });
      const archive = join(dir, `${String(asset)}.tar.gz`);
      await execFileAsync("tar", ["-czf", archive, "-C", stage, "uji"]);
      const bytes = await readFile(archive);
      const digest = createHash("sha256").update(bytes).digest("hex");

      const served = new Map<string, () => Response>([
        [
          `${String(asset)}.tar.gz.sha256`,
          () => new Response(`${digest}  ${String(asset)}.tar.gz\n`),
        ],
        [
          `${String(asset)}.tar.gz`,
          () => new Response(bytes, { headers: { "content-length": String(bytes.length) } }),
        ],
      ]);
      const fetchFn: typeof globalThis.fetch = async (input) => {
        const url = String(input);
        const name = url.slice(url.lastIndexOf("/") + 1);
        const serve = served.get(name);
        return serve === undefined ? new Response("", { status: 404 }) : serve();
      };

      const lines: string[] = [];
      const outcome = await selfUpdate({
        version: "9.9.9",
        binaryPath: binary,
        fetchFn,
        report: (line) => lines.push(line),
      });
      assert.deepEqual(outcome, { kind: "updated", from: VERSION, to: "9.9.9", path: binary });
      assert.equal(await readFile(binary, "utf8"), "#!/bin/sh\necho new\n");
      assert.equal(lines[0], `Downloading ${String(asset)}.tar.gz …`);
      assert.equal(lines.at(-1), "Checksum ok.");

      served.set(`${String(asset)}.tar.gz.sha256`, () => new Response(`${"0".repeat(64)}  x\n`));
      await writeFile(binary, "#!/bin/sh\necho kept\n", { mode: 0o755 });
      const rejected = await selfUpdate({ version: "9.9.9", binaryPath: binary, fetchFn });
      assert.equal(rejected.kind, "failed");
      assert.match(describeUpdateOutcome(rejected), /Checksum mismatch/u);
      assert.equal(await readFile(binary, "utf8"), "#!/bin/sh\necho kept\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
