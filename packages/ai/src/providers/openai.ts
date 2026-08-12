import type { Provider } from "../provider.ts";

/** OpenAI platform API: api-key auth (stored key or OPENAI_API_KEY). */
export function openaiProvider(): Provider {
  return {
    id: "openai",
    name: "OpenAI",
    api: "responses",
    baseUrl: "https://api.openai.com/v1",
    auth: {
      apiKey: {
        name: "OpenAI API key",
        async login(interaction) {
          const key = await interaction.prompt({
            type: "secret",
            message: "Paste your OpenAI API key:",
            placeholder: "sk-...",
          });
          return { type: "api_key", key: key.trim() };
        },
        resolve: ({ env, credential }) => {
          const stored = credential?.key;
          if (stored !== undefined && stored !== "") {
            return Promise.resolve({ auth: { apiKey: stored }, source: "stored key" });
          }
          const ambient = env("OPENAI_API_KEY");
          if (ambient !== undefined && ambient !== "") {
            return Promise.resolve({ auth: { apiKey: ambient }, source: "OPENAI_API_KEY" });
          }
          return Promise.resolve(undefined);
        },
      },
    },
    models: [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
      { id: "gpt-5.6", name: "GPT-5.6" },
      { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
    ],
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium",
  };
}
