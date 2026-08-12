/**
 * Provider auth blocks, copied from pi-ai's shapes (dist/auth/types.d.ts).
 * Core owns resolution and storage; clients own rendering the interaction.
 */

/**
 * Request auth for a single model request. If a value cannot be expressed as
 * `apiKey`, `headers`, or `baseUrl`, it is provider config, not auth.
 */
export interface ModelAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
}

/** Stored api-key credential. */
export interface ApiKeyCredential {
  type: "api_key";
  key?: string;
}

/** Stored canonical OAuth credential. */
export interface OAuthCredential {
  type: "oauth";
  refresh: string;
  access: string;
  /** Epoch ms when `access` expires. */
  expires: number;
  [key: string]: unknown;
}

/** One type-tagged credential per provider — the shape of auth.json. */
export type Credential = ApiKeyCredential | OAuthCredential;

/** Non-secret credential metadata for account/status enumeration. */
export interface CredentialInfo {
  providerId: string;
  type: Credential["type"];
}

/**
 * App-owned credential storage, keyed by provider id, one credential per
 * provider. `modify` is the only write path, so every mutation is a
 * serialized read-modify-write; auth resolution runs OAuth refresh inside
 * `modify` so concurrent requests cannot double-refresh a rotated token.
 */
export interface CredentialStore {
  /** Read the stored credential, possibly expired. */
  read(providerId: string): Promise<Credential | undefined>;
  /** List stored credential metadata without exposing secrets. */
  list(): Promise<readonly CredentialInfo[]>;
  /**
   * Serialized write — the only write path. `fn` sees the current credential;
   * return the new credential, or undefined to leave the entry unchanged.
   * Resolves with the post-write credential.
   */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined>;
  /** Remove a credential (logout). */
  delete(providerId: string): Promise<void>;
}

/** Result of resolving auth for a provider. */
export interface AuthResult {
  auth: ModelAuth;
  /** Human-readable label for status UI: "OPENAI_API_KEY", "OAuth". */
  source?: string;
}

/**
 * Prompt shown to the user during login. `signal` lets the flow cancel a
 * pending prompt when an out-of-band event resolves the step, e.g. a
 * `manual_code` prompt raced against a callback server, aborted when the
 * callback wins.
 */
export type AuthPrompt = { signal?: AbortSignal } & (
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    }
  | { type: "manual_code"; message: string; placeholder?: string }
);

export type AuthEvent =
  | { type: "info"; message: string }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

/**
 * Login interaction callbacks serving both api-key and OAuth flows. This is
 * the whole login funnel contract: core flows call `prompt`/`notify`; a CLI
 * prints and reads lines, a GUI opens windows and forms — same flow code.
 *
 * `prompt()` returns the entered/selected string (`select` returns the option
 * id). Rejects on cancel/abort. `signal` aborts the whole login flow;
 * per-prompt cancellation uses `AuthPrompt.signal`.
 */
export interface AuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

/** Normalized interaction passed to provider login implementations. */
export type ProviderAuthInteraction = AuthInteraction & { signal: AbortSignal };

/** Api-key auth: stored key plus ambient env sources. */
export interface ApiKeyAuth {
  /** Display name, e.g. "OpenAI API key". */
  name: string;
  /** Interactive setup (prompt for key). Absent = ambient-only. */
  login?(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential>;
  /**
   * Resolve auth from the stored credential and/or ambient sources.
   * undefined = not configured.
   */
  resolve(input: {
    env: (name: string) => string | undefined;
    credential?: ApiKeyCredential;
  }): Promise<AuthResult | undefined>;
}

/**
 * OAuth auth. The `refresh`/`toAuth` split lets resolution own the locked
 * refresh pattern: `refresh` produces a credential, `toAuth` derives request
 * auth from whatever credential ends up stored.
 */
export interface OAuthAuth {
  /** Display name, e.g. "OpenAI (ChatGPT Plus/Pro)". */
  name: string;
  /** Whether access through this auth method is backed by a provider subscription. */
  isSubscription?: boolean;
  login(interaction: ProviderAuthInteraction): Promise<OAuthCredential>;
  /**
   * Exchange the refresh token. Network call; throws on failure. Resolution
   * runs this under the store lock.
   */
  refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>;
  /** Side-effect-free derivation of request auth from a valid credential. */
  toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

/**
 * Provider auth. At least one of `apiKey`/`oauth` must be present; `resolve()`
 * reporting undefined means the provider is not configured.
 */
export interface ProviderAuth {
  apiKey?: ApiKeyAuth;
  oauth?: OAuthAuth;
}
