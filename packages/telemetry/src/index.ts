/**
 * Telemetry carried on a Context. Uji has no telemetry exporter yet; this is
 * the smallest contract the harness needs so every call site can already
 * thread a telemetry parent through `Context`. An OpenTelemetry-backed
 * implementation replaces NOOP_TELEMETRY_CONTEXT later without touching call
 * sites (blueprint: OTel is the export standard).
 *
 * Stands in for pi's `@earendil-works/pi-telemetry` package; same role, same place in the dependency graph.
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/telemetry.ts
 * Synced with pi 7ebf9087e.
 */

export type AttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, AttributeValue | undefined>;

export interface SpanOptions {
  name: string;
  attributes?: SpanAttributes;
}

/** A live span. It is also a TelemetryContext so children can parent on it. */
export interface TelemetrySpan extends TelemetryContext {
  readonly name: string;
  setAttributes(attributes: SpanAttributes): void;
  addEvent(name: string, attributes?: SpanAttributes): void;
}

/** The telemetry parent a Context carries. */
export interface TelemetryContext {
  /** Run `fn` inside a child span. The span ends when `fn` settles. */
  startSpan<T>(options: SpanOptions, fn: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}

class NoopSpan implements TelemetrySpan {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  setAttributes(): void {}
  addEvent(): void {}
  startSpan<T>(options: SpanOptions, fn: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    return Promise.resolve(fn(new NoopSpan(options.name)));
  }
}

/** Telemetry context that records nothing. The default on every root Context. */
export const NOOP_TELEMETRY_CONTEXT: TelemetryContext = new NoopSpan("noop");
