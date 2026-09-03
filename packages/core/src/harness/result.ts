/**
 * Result, ported from pi-agent-core.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/result.ts
 */

export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

export const Result = {
  ok<TValue>(value: TValue): { ok: true; value: TValue } {
    return { ok: true, value };
  },
  err<TError>(error: TError): { ok: false; error: TError } {
    return { ok: false, error };
  },
};
