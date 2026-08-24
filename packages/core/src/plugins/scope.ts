/**
 * Everything a plugin registers is tracked here so disposing the scope undoes
 * the plugin completely. Dispose runs in reverse order with a budget per
 * disposer; a slow or throwing disposer is reported and skipped, never raised.
 */
import type { Disposer } from "./types.ts";

type AsyncDisposer = () => void | Promise<void>;

export interface ScopeReporter {
  (error: Error): void;
}

export class PluginScope {
  readonly id: string;
  readonly controller = new AbortController();
  private disposers: AsyncDisposer[] = [];
  private disposed = false;
  private readonly budgetMs: number;
  private readonly report: ScopeReporter;

  constructor(id: string, report: ScopeReporter, budgetMs = 5_000) {
    this.id = id;
    this.report = report;
    this.budgetMs = budgetMs;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  track<T extends Disposer | AsyncDisposer>(disposer: T): T {
    if (this.disposed) {
      void Promise.resolve(disposer()).catch((error: unknown) => this.report(normalize(error)));
      return disposer;
    }
    this.disposers.push(disposer);
    return disposer;
  }

  /** Run `setup` with the scope's signal; a returned disposer is tracked; a throw is reported. */
  effect(setup: (signal: AbortSignal) => void | Disposer | Promise<void | Disposer>): void {
    void Promise.resolve()
      .then(() => setup(this.signal))
      .then((disposer) => {
        if (disposer) this.track(disposer);
      })
      .catch((error: unknown) => this.report(normalize(error)));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    const disposers = this.disposers.reverse();
    this.disposers = [];
    for (const disposer of disposers) {
      try {
        await withBudget(Promise.resolve(disposer()), this.budgetMs);
      } catch (error) {
        this.report(normalize(error));
      }
    }
  }
}

function normalize(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function withBudget(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`disposer exceeded ${ms}ms`)), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
