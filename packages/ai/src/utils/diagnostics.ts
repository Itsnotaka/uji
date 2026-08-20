/**
 * Redacted diagnostics attached to an AssistantMessage for failures and recoveries (retries, transport errors).
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/src/utils/diagnostics.ts
 * Synced with pi 7ebf9087e.
 */
import type { AssistantMessageDiagnostic, DiagnosticErrorInfo } from "@june/schema";

// June divergence: the diagnostic shapes live in @june/schema because AssistantMessage (wire type) carries them; re-exported here so callers that follow pi's layout keep working.
export type { AssistantMessageDiagnostic, DiagnosticErrorInfo };

export function formatThrownValue(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === "string") return value;
  return String(value);
}

export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
  if (!(error instanceof Error)) return { name: "ThrownValue", message: formatThrownValue(error) };
  const code = (error as Error & { code?: unknown }).code;
  return {
    name: error.name || undefined,
    message: error.message || error.name,
    stack: error.stack,
    code: typeof code === "string" || typeof code === "number" ? code : undefined,
  };
}

export function createAssistantMessageDiagnostic(
  type: string,
  error: unknown,
  details?: Record<string, unknown>,
): AssistantMessageDiagnostic {
  return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

export function appendAssistantMessageDiagnostic<
  T extends { diagnostics?: AssistantMessageDiagnostic[] },
>(message: T, diagnostic: AssistantMessageDiagnostic): void {
  message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}
