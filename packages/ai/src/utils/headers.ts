/**
 * Header helpers: flatten a fetch Headers object, and drop null entries from caller-supplied ProviderHeaders (null suppresses a default header).
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/src/utils/headers.ts
 * Synced with pi 7ebf9087e.
 */
import type { ProviderHeaders } from "../types.ts";

export function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  return result;
}

export function providerHeadersToRecord(
  headers: ProviderHeaders | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== null) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
