/**
 * Self-update for the compiled `uji` binary. Downloads the release tarball
 * for this platform, verifies its sha256, and swaps the binary in place with
 * one rename. A build running from source has no binary to replace and is
 * told so.
 *
 * Release assets are the ones `scripts/package.sh` stages:
 * `uji-v<version>-<os>-<arch>.tar.gz` plus a `.sha256` beside it.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { valid } from "semver";
import { fetchLatestRelease, isNewerVersion, REPO, VERSION } from "./version.ts";

const execFileAsync = promisify(execFile);

export type UpdateOutcome =
  | { kind: "updated"; from: string; to: string; path: string }
  | { kind: "current"; version: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "failed"; message: string };

/**
 * What the update is doing, as data. Clients word it: the CLI paints a
 * rewritten percent row, the TUI keeps one transcript note. Reporting prose
 * from here forced both to parse strings back into intent.
 */
export type UpdateProgress =
  | { kind: "downloading"; asset: string }
  | { kind: "percent"; percent: number }
  | { kind: "verified" };

export interface UpdateOptions {
  /** Install this release instead of the newest one. A leading `v` is fine. */
  version?: string;
  /** Progress events, one at a time, in the order they happen. */
  report?: (event: UpdateProgress) => void;
  fetchFn?: typeof globalThis.fetch;
  /** The binary to replace. Defaults to the running compiled binary. */
  binaryPath?: string;
}

/** `uji-v0.2.0-darwin-arm64`, or `undefined` when no release is built for the platform. */
export function releaseAssetName(
  version: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  const os = platform === "darwin" || platform === "linux" ? platform : undefined;
  const cpu = arch === "arm64" || arch === "x64" ? arch : undefined;
  if (os === undefined || cpu === undefined) return undefined;
  return `uji-v${version.replace(/^v/u, "")}-${os}-${cpu}`;
}

/** The hex digest from a `sha256sum`/`shasum` line: `<hex>  <file>`. */
export function parseSha256(text: string): string | undefined {
  const digest = text.trim().split(/\s+/u)[0]?.toLowerCase();
  return digest !== undefined && /^[0-9a-f]{64}$/u.test(digest) ? digest : undefined;
}

/**
 * The compiled binary's path, or `undefined` when running from source. A Bun
 * standalone executable serves its modules from the `/$bunfs/` virtual
 * filesystem and reports itself as `process.execPath`; under `bun src/...` or
 * `node`, `execPath` is the runtime, not us.
 */
export function installedBinaryPath(
  moduleUrl: string = import.meta.url,
  execPath: string = process.execPath,
): string | undefined {
  const runtime = basename(execPath).toLowerCase();
  if (moduleUrl.includes("/$bunfs/")) return execPath;
  if (runtime === "bun" || runtime === "node" || runtime === "bun.exe" || runtime === "node.exe") {
    return undefined;
  }
  return execPath;
}

/** Decide what to install: an explicit version wins; otherwise the latest when it is newer. */
export async function resolveUpdateTarget(
  options: Pick<UpdateOptions, "version" | "fetchFn">,
  current: string = VERSION,
): Promise<
  | { kind: "install"; version: string; explicit: boolean }
  | { kind: "current"; version: string }
  | { kind: "failed"; message: string }
> {
  if (options.version !== undefined) {
    const version = valid(options.version.trim().replace(/^v/u, ""));
    if (version === null) {
      return { kind: "failed", message: `"${options.version}" isn't a version like 0.2.0.` };
    }
    if (version === current) return { kind: "current", version };
    return { kind: "install", version, explicit: true };
  }
  const latest = await fetchLatestRelease(options.fetchFn);
  if (latest === undefined) {
    return {
      kind: "failed",
      message: `Couldn't read the latest release from https://github.com/${REPO}/releases.`,
    };
  }
  if (!isNewerVersion(latest.version, current)) return { kind: "current", version: current };
  return { kind: "install", version: latest.version, explicit: false };
}

async function downloadTo(
  fetchFn: typeof globalThis.fetch,
  url: string,
  path: string,
  onProgress: (received: number, total: number | undefined) => void,
): Promise<string> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || response.body === null) {
    throw new Error(`Failed to download ${url} (HTTP ${String(response.status)}).`);
  }
  const length = response.headers.get("content-length");
  const total = length === null ? undefined : Number(length);
  const hash = createHash("sha256");
  let received = 0;
  // SAFETY: fetch's body is a WHATWG ReadableStream; node:stream's fromWeb wants its own alias of the same type.
  const body = Readable.fromWeb(response.body as unknown as WebReadableStream);
  body.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
    onProgress(received, total);
  });
  await pipeline(body, createWriteStream(path));
  return hash.digest("hex");
}

async function fetchText(fetchFn: typeof globalThis.fetch, url: string): Promise<string> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Failed to download ${url} (HTTP ${String(response.status)}).`);
  return response.text();
}

export async function selfUpdate(options: UpdateOptions = {}): Promise<UpdateOutcome> {
  const report = options.report ?? (() => undefined);
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const binaryPath = options.binaryPath ?? installedBinaryPath();
  if (binaryPath === undefined) {
    return {
      kind: "unsupported",
      reason: "uji is running from source. Update with git pull, not uji update.",
    };
  }

  const target = await resolveUpdateTarget({ version: options.version, fetchFn });
  if (target.kind !== "install") return target;
  const asset = releaseAssetName(target.version);
  if (asset === undefined) {
    return {
      kind: "unsupported",
      reason: `No release is built for ${process.platform}/${process.arch}.`,
    };
  }

  const base = `https://github.com/${REPO}/releases/download/v${target.version}`;
  const workDir = await mkdtemp(join(tmpdir(), "uji-update-"));
  const staged = join(dirname(binaryPath), `.uji-update-${String(process.pid)}`);
  try {
    report({ kind: "downloading", asset: `${asset}.tar.gz` });
    const expected = parseSha256(await fetchText(fetchFn, `${base}/${asset}.tar.gz.sha256`));
    if (expected === undefined) {
      return { kind: "failed", message: `The checksum file for ${asset} is malformed.` };
    }
    const archive = join(workDir, `${asset}.tar.gz`);
    let lastPercent = -1;
    const actual = await downloadTo(fetchFn, `${base}/${asset}.tar.gz`, archive, (got, total) => {
      if (total === undefined || total <= 0) return;
      const percent = Math.floor((got / total) * 10) * 10;
      if (percent > lastPercent && percent < 100) {
        lastPercent = percent;
        report({ kind: "percent", percent });
      }
    });
    if (actual !== expected) {
      return {
        kind: "failed",
        message: `Checksum mismatch for ${asset}.tar.gz: expected ${expected}, got ${actual}.`,
      };
    }
    report({ kind: "verified" });

    await execFileAsync("tar", ["-xzf", archive, "-C", workDir]);
    const extracted = join(workDir, "uji");
    if (!(await stat(extracted).catch(() => undefined))?.isFile()) {
      return { kind: "failed", message: `${asset}.tar.gz does not contain a uji binary.` };
    }
    await copyFile(extracted, staged);
    await chmod(staged, 0o755);
    // Same directory, so the rename is atomic. The running process keeps its
    // old inode mapped; the next launch gets the new file.
    await rename(staged, binaryPath);
    return { kind: "updated", from: VERSION, to: target.version, path: binaryPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
    const hint =
      code === "EACCES" || code === "EPERM"
        ? ` Can't write ${binaryPath}; rerun with permission to that directory.`
        : "";
    return { kind: "failed", message: `${message}${hint}` };
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(staged, { force: true });
  }
}

/** One line per outcome, shared by `uji update` and `/update`. */
export function describeUpdateOutcome(outcome: UpdateOutcome): string {
  switch (outcome.kind) {
    case "updated":
      return `Updated uji ${outcome.from} → ${outcome.to} at ${outcome.path}. Restart uji to use it.`;
    case "current":
      return `uji ${outcome.version} is the latest release.`;
    case "unsupported":
      return outcome.reason;
    case "failed":
      return outcome.message;
  }
}
