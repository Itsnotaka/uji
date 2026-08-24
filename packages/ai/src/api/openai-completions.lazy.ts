/**
 * Lazy OpenAI-compatible Chat Completions adapter.
 *
 * Based on https://github.com/earendil-works/pi/blob/77f2d1235ee2992c6072b9dcb6e99439a70c6f45/packages/ai/src/api/openai-completions.lazy.ts
 * Synced with pi 77f2d1235.
 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openAICompletionsApi = (): ProviderStreams =>
  lazyApi(() => import("./openai-completions.ts"));
