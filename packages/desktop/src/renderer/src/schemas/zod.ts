/**
 * The renderer's one Zod binding. The page's CSP has no `unsafe-eval`, and
 * Zod 4 decides at schema construction whether an object parser may JIT via
 * `new Function`, so `jitless` must be set before any schema exists. Every
 * renderer schema imports `z` from here and never from "zod" directly; a
 * source test holds that line. `zod/compile` and `z.compile` stay in main.
 */
import { z } from "zod";

z.config({ jitless: true });

export { z };

/** Parse a value that crossed IPC, naming what it was supposed to be. */
export function decode<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new Error(`Malformed ${what} from the host:\n${z.prettifyError(result.error)}`);
}
