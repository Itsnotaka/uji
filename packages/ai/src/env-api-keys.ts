/**
 * API-key discovery from environment variables, per provider. Reports which
 * variables are set (`findEnvKeys`) and resolves the key a request may use
 * (`getEnvApiKey`); ANTHROPIC_AUTH_TOKEN is reported but never returned as an
 * API key because requests must send it as a bearer token.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/src/env-api-keys.ts
 * Synced with pi 7ebf9087e.
 */
import type { KnownProvider, ProviderEnv } from "./types.ts";
import { getProviderEnvValue } from "./utils/provider-env.ts";

export const ANTHROPIC_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
export const ANTHROPIC_OAUTH_TOKEN_ENV = "ANTHROPIC_OAUTH_TOKEN";
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

function getApiKeyEnvVars(provider: string): readonly string[] | undefined {
  // ANTHROPIC_AUTH_TOKEN participates in env discovery/status, but
  // getEnvApiKey() skips it because requests must pass it as Authorization: Bearer.
  if (provider === "anthropic") {
    return [ANTHROPIC_AUTH_TOKEN_ENV, ANTHROPIC_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV];
  }

  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
  };

  const envVar = envMap[provider];
  return envVar ? [envVar] : undefined;
}

/**
 * Find configured environment variables that can provide an API key for a provider.
 *
 * This only reports actual API key variables. It intentionally excludes ambient
 * credential sources such as AWS profiles, AWS IAM credentials, and Google
 * Application Default Credentials.
 */
export function findEnvKeys(provider: KnownProvider, env?: ProviderEnv): string[] | undefined;
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined;
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined {
  const envVars = getApiKeyEnvVars(provider);
  if (!envVars) return undefined;

  const found = envVars.filter((envVar) => !!getProviderEnvValue(envVar, env));
  return found.length > 0 ? found : undefined;
}

/**
 * Get API key for provider from known environment variables, e.g. OPENAI_API_KEY.
 *
 * Will not return API keys for providers that require OAuth tokens.
 */
export function getEnvApiKey(provider: KnownProvider, env?: ProviderEnv): string | undefined;
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined;
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined {
  const envKeys = findEnvKeys(provider, env);
  if (envKeys?.[0]) {
    const apiKeyEnv =
      provider === "anthropic"
        ? envKeys.find((key) => key !== ANTHROPIC_AUTH_TOKEN_ENV)
        : envKeys[0];
    if (apiKeyEnv) return getProviderEnvValue(apiKeyEnv, env);
  }

  return undefined;
}
