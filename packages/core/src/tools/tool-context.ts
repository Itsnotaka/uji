/**
 * The context every built-in tool receives. A host extends it by choosing a
 * wider type for its harness; the built-ins only ever read `env`.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/tools/tool-context.ts
 * Synced with pi 7ebf9087e.
 */
import type { ExecutionEnv } from "../harness/env/types.ts";

export interface ExecutionToolContext {
  env: ExecutionEnv;
}
