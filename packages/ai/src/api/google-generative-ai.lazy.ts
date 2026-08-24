/**
 * Lazy Google Generative AI adapter.
 *
 * Based on https://github.com/earendil-works/pi/blob/77f2d1235ee2992c6072b9dcb6e99439a70c6f45/packages/ai/src/api/google-generative-ai.lazy.ts
 * Synced with pi 77f2d1235.
 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleGenerativeAIApi = (): ProviderStreams =>
  lazyApi(() => import("./google-generative-ai.ts"));
