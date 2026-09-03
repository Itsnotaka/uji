import {
  anthropicProvider,
  createModels,
  defaultProviderAuthContext,
  FileCredentialStore,
  FileModelsStore,
  opencodeGoProvider,
  opencodeProvider,
  openaiCodexProvider,
  openaiProvider,
} from "@uji-ai/ai";
import type {
  Api,
  AuthCheck,
  FetchFunction,
  Model,
  Models,
  MutableModels,
  Provider,
} from "@uji-ai/ai";
import type { ThinkingLevel } from "@uji-ai/core";

export const DEFAULT_PROVIDER_ID = "openai-codex";
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

function preferredModelId(providerId: Provider["id"]): Model<Api>["id"] | undefined {
  if (providerId === "anthropic") return "claude-opus-5";
  if (providerId === "opencode") return "x-preview-f-free";
  if (providerId === "opencode-go") return "ox-alpha-free";
  if (providerId === "openai-codex" || providerId === "openai") return "gpt-5.6-luna";
  return undefined;
}

/** The terminal client owns which explicit, side-effect-free provider factories it exposes. */
export function createCliModels(options: { fetch?: FetchFunction } = {}): MutableModels {
  const models = createModels({
    credentials: new FileCredentialStore(),
    authContext: defaultProviderAuthContext(),
    modelsStore: new FileModelsStore(),
  });
  models.setProvider(openaiCodexProvider());
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(opencodeProvider({ fetch: options.fetch }));
  models.setProvider(opencodeGoProvider({ fetch: options.fetch }));
  return models;
}

/**
 * Restore the provider's persisted catalog on top of its baked models. Local
 * disk only: the boot path must work on a plane, so the network freshen is
 * the background `loadAuthenticatedModels` warm, never this call.
 */
export async function loadProviderCatalog(models: Models, providerId: string): Promise<void> {
  await models.refresh({ providers: [providerId], allowNetwork: false });
}

export type ProviderAuthStatus =
  | { kind: "authenticated"; provider: Provider; auth: AuthCheck }
  | { kind: "unauthenticated"; provider: Provider };

/** Resolve provider status concurrently so pickers can mark and filter logged-in providers. */
export async function providerAuthStatuses(models: Models): Promise<ProviderAuthStatus[]> {
  return Promise.all(
    models.getProviders().map(async (provider): Promise<ProviderAuthStatus> => {
      const auth = await models.checkAuth(provider.id);
      return auth === undefined
        ? { kind: "unauthenticated", provider }
        : { kind: "authenticated", provider, auth };
    }),
  );
}

async function fetchAuthenticatedModels(
  models: Models,
  options: { force?: boolean },
): Promise<readonly Model<Api>[]> {
  const statuses = await providerAuthStatuses(models);
  const providers = statuses.flatMap((status) =>
    status.kind === "authenticated" ? [status.provider] : [],
  );
  await models.refresh({
    providers: providers.map((provider) => provider.id),
    force: options.force,
  });
  const available = await Promise.all(
    providers.map((provider) => models.getAvailable(provider.id)),
  );
  return available.flat();
}

interface CatalogCache {
  loaded: readonly Model<Api>[] | undefined;
  loading: Promise<readonly Model<Api>[]> | undefined;
}

const catalogCache = new WeakMap<Models, CatalogCache>();

function cacheFor(models: Models): CatalogCache {
  const existing = catalogCache.get(models);
  if (existing !== undefined) return existing;
  const created: CatalogCache = { loaded: undefined, loading: undefined };
  catalogCache.set(models, created);
  return created;
}

/**
 * The last catalog this process loaded. A menu paints from it and asks for a
 * reload behind the frame, so opening one never waits on the network.
 */
export function cachedAuthenticatedModels(models: Models): readonly Model<Api>[] | undefined {
  return cacheFor(models).loaded;
}

/**
 * Load one model catalog spanning every provider with configured auth.
 * Concurrent callers share one refresh; `force` starts a fresh one.
 */
export function loadAuthenticatedModels(
  models: Models,
  options: { force?: boolean } = {},
): Promise<readonly Model<Api>[]> {
  const cache = cacheFor(models);
  const pending = cache.loading;
  if (pending !== undefined && options.force !== true) return pending;
  const load = fetchAuthenticatedModels(models, options)
    .then((available) => {
      cache.loaded = available;
      return available;
    })
    .finally(() => {
      if (cache.loading === load) cache.loading = undefined;
    });
  cache.loading = load;
  return load;
}

export function requireProvider(models: Models, providerId: string): Provider {
  const provider = models.getProvider(providerId);
  if (provider === undefined) throw new Error(`Unknown provider: ${providerId}`);
  return provider;
}

/** Default choice is client policy; model capabilities still come from @uji-ai/ai. */
export function defaultModel(models: Models, providerId: string): Model<Api> {
  const providerModels = models.getModels(providerId);
  const preferredId = preferredModelId(providerId);
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
