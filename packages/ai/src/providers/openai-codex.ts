import { openaiCodexOAuth } from "../auth/oauth/openai-codex.ts";
import type { Provider } from "../provider.ts";

/**
 * OpenAI via ChatGPT subscription (codex backend). OAuth-only; model list
 * mirrors what the backend serves signed-in codex clients.
 */
export function openaiCodexProvider(): Provider {
  return {
    id: "openai-codex",
    name: "OpenAI Codex",
    api: "codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    auth: { oauth: openaiCodexOAuth },
    models: [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { id: "gpt-5.5", name: "GPT-5.5" },
    ],
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium",
  };
}
