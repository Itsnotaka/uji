/**
 * The desktop's provider catalog: the same explicit factories and the same
 * `~/.uji` credential and model stores the TUI uses, so a login made in either
 * client is a login in both. Browser-first OAuth: the desktop opens the URL
 * and refuses flows that would need a terminal prompt.
 */
import {
  anthropicProvider,
  createModels,
  defaultProviderAuthContext,
  FileCredentialStore,
  FileModelsStore,
  getSupportedThinkingLevels,
  opencodeGoProvider,
  opencodeProvider,
  openaiCodexProvider,
  openaiProvider,
} from "@uji-ai/ai";
import type { Api, Model, Models, MutableModels } from "@uji-ai/ai";
import type { DesktopModelOption, ProviderStatus } from "../shared/ipc.ts";

export const DEFAULT_PROVIDER_ID = "openai-codex";

const PREFERRED_MODEL_IDS: Readonly<Record<string, string>> = {
  anthropic: "claude-opus-5",
  opencode: "x-preview-f-free",
  "opencode-go": "ox-alpha-free",
  "openai-codex": "gpt-5.6-luna",
  openai: "gpt-5.6-luna",
};

export function createDesktopModels(): MutableModels {
  const models = createModels({
    credentials: new FileCredentialStore(),
    authContext: defaultProviderAuthContext(),
    modelsStore: new FileModelsStore(),
  });
  models.setProvider(openaiCodexProvider());
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(opencodeProvider());
  models.setProvider(opencodeGoProvider());
  return models;
}

/** Restore persisted catalogs from disk. Boot must work offline. */
export async function loadPersistedCatalog(models: Models): Promise<void> {
  await models.refresh({
    providers: models.getProviders().map((provider) => provider.id),
    allowNetwork: false,
  });
}

/**
 * The composition fallback for `createUji`: the preferred model of the first
 * authenticated provider, in catalog preference order, else the default
 * provider's preferred model so the app composes before any login.
 */
export async function resolveFallbackModel(models: Models): Promise<Model<Api>> {
  const order = [
    DEFAULT_PROVIDER_ID,
    ...models
      .getProviders()
      .map((provider) => provider.id)
      .filter((id) => id !== DEFAULT_PROVIDER_ID),
  ];
  for (const providerId of order) {
    const auth = await models.checkAuth(providerId).catch(() => undefined);
    if (auth === undefined) continue;
    const preferred = preferredModel(models, providerId);
    if (preferred !== undefined) return preferred;
  }
  const fallback = preferredModel(models, DEFAULT_PROVIDER_ID) ?? models.getModels()[0];
  if (fallback === undefined) throw new Error("No models in the provider catalog");
  return fallback;
}

function preferredModel(models: Models, providerId: string): Model<Api> | undefined {
  const preferredId = PREFERRED_MODEL_IDS[providerId];
  const preferred =
    preferredId === undefined ? undefined : models.getModel(providerId, preferredId);
  return preferred ?? models.getModels(providerId)[0];
}

export async function providerStatuses(models: Models): Promise<ProviderStatus[]> {
  return Promise.all(
    models.getProviders().map(async (provider): Promise<ProviderStatus> => {
      const auth = await models.checkAuth(provider.id).catch(() => undefined);
      const oauth = provider.auth.oauth;
      return {
        id: provider.id,
        name: provider.name,
        authenticated: auth !== undefined,
        ...(auth === undefined ? {} : { detail: authDetail(auth.type) }),
        ...(oauth === undefined ? {} : { loginLabel: oauth.loginLabel ?? `Sign in` }),
      };
    }),
  );
}

function authDetail(type: string): string {
  if (type === "oauth") return "OAuth";
  if (type === "api_key") return "API key";
  return type;
}

export function modelOptions(models: Models): DesktopModelOption[] {
  return models.getModels().map((model) => ({
    key: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    thinkingLevels: getSupportedThinkingLevels(model),
  }));
}

/**
 * Run a provider's browser login. Selection prompts answer "browser"; a flow
 * that needs typed input is refused, because the desktop has no terminal.
 */
export async function browserLogin(
  models: Models,
  providerId: string,
  openExternal: (url: string) => void,
  notifyStatus: (message: string) => void,
): Promise<void> {
  await models.login(providerId, "oauth", {
    prompt: (prompt) => {
      if (prompt.type === "select") return Promise.resolve("browser");
      if (prompt.type === "manual_code") {
        // The browser callback completes the flow; hold the manual path open
        // without resolving so a cancelled browser flow rejects upstream.
        return new Promise<string>((_resolve, reject) => {
          const cancel = (): void => reject(new Error("Browser login finished"));
          if (prompt.signal?.aborted === true) cancel();
          else prompt.signal?.addEventListener("abort", cancel, { once: true });
        });
      }
      return Promise.reject(new Error("This login step needs the CLI: run `uji login`"));
    },
    notify: (event) => {
      if (event.type === "auth_url") openExternal(event.url);
      if (event.type === "progress" || event.type === "info") notifyStatus(event.message);
    },
  });
}
