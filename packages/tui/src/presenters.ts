import { createPresenter } from "@uji-ai/core";
import type { CustomRefiner, ToolRefiner } from "@uji-ai/core";

const WEB_SEARCH_PROVIDERS: Readonly<Record<string, string>> = {
  exa: "Exa",
  parallel: "Parallel",
  firecrawl: "Firecrawl",
};

const webSearchSummary: ToolRefiner = (view, base) => {
  const details = view.result?.details;
  if (typeof details !== "object" || details === null) return base;
  const provider = "provider" in details ? details.provider : undefined;
  const results = "results" in details ? details.results : undefined;
  if (typeof provider !== "string" || !Array.isArray(results)) return base;
  const name = WEB_SEARCH_PROVIDERS[provider] ?? provider;
  const count = results.length;
  return { ...base, summary: `${name} · ${String(count)} ${count === 1 ? "result" : "results"}` };
};

/** `task` settles TaskDetails; one line names the delegate and how its run ended. */
const taskSummary: ToolRefiner = (view, base) => {
  const details = view.result?.details;
  if (typeof details !== "object" || details === null) return base;
  const agent = "agent" in details ? details.agent : undefined;
  const state = "state" in details ? details.state : undefined;
  if (typeof agent !== "string" || typeof state !== "string") return base;
  return { ...base, summary: `${agent} · ${state}` };
};

const providerChangeNote: CustomRefiner = (entry, base) => {
  const data = entry.data;
  if (typeof data !== "object" || data === null || !("providerId" in data)) return base;
  return typeof data.providerId === "string" ? { text: `Provider → ${data.providerId}` } : base;
};

const cwdChangeNote: CustomRefiner = (entry, base) => {
  const data = entry.data;
  if (typeof data !== "object" || data === null || !("cwd" in data)) return base;
  return typeof data.cwd === "string" ? { text: `Directory → ${data.cwd}` } : base;
};

export const presenter = createPresenter({
  tools: { websearch: webSearchSummary, task: taskSummary },
  custom: { provider_change: providerChangeNote, cwd_change: cwdChangeNote },
});
