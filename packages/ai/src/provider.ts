import type { ProviderAuth } from "./auth/types.ts";

/** Which Responses wire dialect a provider speaks. */
export type ResponsesApi = "responses" | "codex-responses";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelInfo {
  id: string;
  name?: string;
}

/**
 * A provider block: auth modes + transport + models. The credential decides
 * the transport (Arctic-style) — OAuth ChatGPT tokens route to the codex
 * backend, api keys to the platform API — so baseUrl and wire quirks live
 * here, next to the auth.
 */
export interface Provider {
  id: string;
  name: string;
  api: ResponsesApi;
  baseUrl: string;
  auth: ProviderAuth;
  models: ModelInfo[];
  defaultModel: string;
  defaultEffort: ReasoningEffort;
}
