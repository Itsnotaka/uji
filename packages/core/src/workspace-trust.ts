/**
 * Durable workspace trust. Trust is the one gate before a host loads project
 * input or gives the agent unrestricted workspace tools; it is not a sandbox.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/trust-manager.ts
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const trustedWorkspace: unique symbol = Symbol("TrustedWorkspace");

/** A realpath workspace that passed a `WorkspaceTrustStore` decision. */
export interface TrustedWorkspace {
  readonly cwd: string;
  readonly [trustedWorkspace]: true;
}

export type WorkspaceTrustResolution =
  | {
      readonly kind: "trusted";
      readonly workspace: TrustedWorkspace;
      readonly inheritedFrom: string;
    }
  | { readonly kind: "unknown"; readonly cwd: string };

export class WorkspaceTrustRequired extends Error {
  readonly cwd: string;

  constructor(cwd: string) {
    super(`Workspace trust required: ${cwd}`);
    this.name = "WorkspaceTrustRequired";
    this.cwd = cwd;
  }
}

type TrustFile = Record<string, true>;

function parseTrustFile(text: string): TrustFile {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Workspace trust file must be an object");
  }

  const trusted: TrustFile = {};
  for (const [path, decision] of Object.entries(value)) {
    if (!isAbsolute(path) || decision !== true) {
      throw new Error("Workspace trust file must map absolute paths to true");
    }
    trusted[path] = true;
  }
  return trusted;
}

function trusted(cwd: string): TrustedWorkspace {
  return Object.freeze({ cwd, [trustedWorkspace]: true as const });
}

function trustedAncestor(cwd: string, decisions: TrustFile): string | undefined {
  let candidate = cwd;
  while (true) {
    if (decisions[candidate] === true) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

/**
 * Owns realpath decisions and serializes read-modify-write operations.
 * Callers choose the durable file location; hosts commonly use `~/.uji/trust.json`.
 */
export class WorkspaceTrustStore {
  readonly path: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error("Workspace trust path must be absolute");
    this.path = path;
  }

  resolve(cwd: string): Promise<WorkspaceTrustResolution> {
    return this.serialized(async () => {
      const realPath = await realpath(resolve(cwd));
      const inheritedFrom = trustedAncestor(realPath, await this.read());
      return inheritedFrom === undefined
        ? { kind: "unknown", cwd: realPath }
        : { kind: "trusted", workspace: trusted(realPath), inheritedFrom };
    });
  }

  async require(cwd: string): Promise<TrustedWorkspace> {
    const resolution = await this.resolve(cwd);
    if (resolution.kind === "unknown") throw new WorkspaceTrustRequired(resolution.cwd);
    return resolution.workspace;
  }

  trust(cwd: string): Promise<TrustedWorkspace> {
    return this.serialized(async () => {
      const realPath = await realpath(resolve(cwd));
      const decisions = await this.read();
      decisions[realPath] = true;
      await this.write(decisions);
      return trusted(realPath);
    });
  }

  forget(cwd: string): Promise<void> {
    return this.serialized(async () => {
      const realPath = await realpath(resolve(cwd));
      const decisions = await this.read();
      if (decisions[realPath] !== true) return;
      delete decisions[realPath];
      await this.write(decisions);
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async read(): Promise<TrustFile> {
    try {
      return parseTrustFile(await readFile(this.path, "utf8"));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return {};
      }
      throw error;
    }
  }

  private async write(decisions: TrustFile): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${String(process.pid)}.${randomUUID()}.tmp`;
    const ordered = Object.fromEntries(
      Object.keys(decisions)
        .toSorted()
        .map((path) => [path, true] as const),
    );
    try {
      await writeFile(temporary, `${JSON.stringify(ordered, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
