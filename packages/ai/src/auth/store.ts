import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import type { Credential, CredentialInfo, CredentialStore } from "./types.ts";

export function defaultAuthPath(): string {
  const home = process.env["JUNE_HOME"] ?? join(homedir(), ".june");
  return join(home, "auth.json");
}

/**
 * File-backed credential store (auth.json, one credential per provider id).
 * Writes are serialized per provider through a promise chain; the file is
 * created 0600 under a 0700 directory.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly path: string;
  private chains = new Map<string, Promise<unknown>>();

  constructor(path: string = defaultAuthPath()) {
    this.path = path;
  }

  private load(): Record<string, Credential> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Credential>;
    } catch {
      return {};
    }
  }

  private save(all: Record<string, Credential>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  }

  /** Serialize tasks per provider id without releasing the chain before active work settles. */
  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.chains.set(
      providerId,
      next.catch(() => undefined),
    );
    return next;
  }

  read(providerId: string): Promise<Credential | undefined> {
    return Promise.resolve(this.load()[providerId]);
  }

  list(): Promise<readonly CredentialInfo[]> {
    return Promise.resolve(
      Object.entries(this.load()).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      })),
    );
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const all = this.load();
      const next = await fn(all[providerId]);
      if (next !== undefined) {
        all[providerId] = next;
        this.save(all);
      }
      return all[providerId];
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      const all = this.load();
      if (providerId in all) {
        delete all[providerId];
        this.save(all);
      }
    });
  }
}
