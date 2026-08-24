/**
 * File-backed `CredentialStore` (auth.json, one credential per provider id).
 * Uji-owned persistent store; the queueing and cancellation semantics follow
 * pi's InMemoryCredentialStore so `resolveProviderAuth` behaves identically
 * against either.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/src/auth/credential-store.ts
 * Synced with pi 7ebf9087e.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "./types.ts";

export function defaultAuthPath(): string {
  const home = process.env["UJI_HOME"] ?? join(homedir(), ".uji");
  return join(home, "auth.json");
}

/**
 * File-backed credential store. Writes are serialized per provider through a
 * promise chain; the file is created 0600 under a 0700 directory.
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
  private enqueue<T>(
    providerId: string,
    task: () => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    const signal = operationSignal(options?.signal);
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const queued = (async () => {
      await previous.catch(() => {});
      signal.throwIfAborted();
      return task();
    })();
    const tail = queued.catch(() => {});
    this.chains.set(providerId, tail);
    void tail.then(() => {
      if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
    });
    return raceWithAbortSignal(queued, signal);
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.load()[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(this.load()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(
      providerId,
      async () => {
        const all = this.load();
        const current = all[providerId];
        const next = await fn(current);
        options?.signal?.throwIfAborted();
        if (next !== undefined) {
          all[providerId] = next;
          this.save(all);
        }
        return next ?? current;
      },
      options,
    );
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(
      providerId,
      async () => {
        const all = this.load();
        if (providerId in all) {
          delete all[providerId];
          this.save(all);
        }
      },
      options,
    );
  }
}
