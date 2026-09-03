import { compactOpenAICodexContext } from "@uji-ai/ai";
import type { Model, Models } from "@uji-ai/ai";
import { definePlugin } from "@uji-ai/plugin";

const OPENAI_CODEX_PLUGIN_ID = "openai/openai-codex";

/** Route matching Codex checkpoints through OpenAI's native compact endpoint. */
export function openAICodexPlugin(models: Models) {
  return definePlugin({
    id: OPENAI_CODEX_PLUGIN_ID,
    session(api) {
      api.hook("before_compaction", async (event, signal) => {
        if (event.model.provider !== "openai-codex" || event.customInstructions !== undefined) {
          return undefined;
        }
        const model = models.getModel(event.model.provider, event.model.modelId);
        if (model?.api !== "openai-codex-responses") return undefined;

        const auth = await models.getAuth(model, { signal });
        if (auth?.auth.apiKey === undefined) return undefined;
        const requestModel: Model<"openai-codex-responses"> = {
          ...model,
          ...(auth.auth.baseUrl === undefined ? {} : { baseUrl: auth.auth.baseUrl }),
          api: "openai-codex-responses",
        };
        const compacted = await compactOpenAICodexContext(requestModel, event.context, {
          apiKey: auth.auth.apiKey,
          headers: auth.auth.headers,
          signal,
        }).catch(() => undefined);
        if (compacted === undefined) return undefined;
        return {
          material: {
            type: "provider",
            provider: requestModel.provider,
            api: requestModel.api,
            model: requestModel.id,
            data: compacted.data,
          },
        };
      });
    },
  });
}
