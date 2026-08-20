import {
  createModels,
  defaultProviderAuthContext,
  FileCredentialStore,
  openaiCodexProvider,
  openaiProvider,
} from "@june/ai";
import type { Api, Model, Models, MutableModels, Provider } from "@june/ai";
import type { ThinkingLevel } from "@june/core";

export const DEFAULT_PROVIDER_ID = "openai-codex";
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

const DEFAULT_MODEL_IDS: Readonly<Record<string, string>> = {
  "openai-codex": "gpt-5.6-luna",
  openai: "gpt-5.6-luna",
};

/** The demo owns which explicit, side-effect-free provider factories it exposes. */
export function createCliModels(): MutableModels {
  const models = createModels({
    credentials: new FileCredentialStore(),
    authContext: defaultProviderAuthContext(),
  });
  models.setProvider(openaiCodexProvider());
  models.setProvider(openaiProvider());
  return models;
}

export function requireProvider(models: Models, providerId: string): Provider {
  const provider = models.getProvider(providerId);
  if (provider === undefined) throw new Error(`Unknown provider: ${providerId}`);
  return provider;
}

/** Default choice is client policy; model capabilities still come from @june/ai. */
export function defaultModel(models: Models, providerId: string): Model<Api> {
  const providerModels = models.getModels(providerId);
  const preferredId = DEFAULT_MODEL_IDS[providerId];
  const model =
    providerModels.find((candidate) => candidate.id === preferredId) ?? providerModels.at(0);
  if (model === undefined) throw new Error(`${providerId} does not expose any models`);
  return model;
}

export function requireModel(models: Models, providerId: string, modelId?: string): Model<Api> {
  if (modelId === undefined) return defaultModel(models, providerId);
  const model = models.getModel(providerId, modelId);
  if (model === undefined) throw new Error(`Unknown ${providerId} model: ${modelId}`);
  return model;
}
