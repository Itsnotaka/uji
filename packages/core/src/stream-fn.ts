/**
 * Bridges @june/ai's streamed Responses client into the agent loop's StreamFn
 * contract (pi: Models.streamSimple satisfies pi-agent-core's StreamFn). Lives
 * outside agent-loop.ts on purpose — the loop must not know providers.
 */
import { resolveProviderAuth, streamResponses } from "@june/ai";
import type { CredentialStore, ModelAuth, Provider } from "@june/ai";
import type { AssistantTurn, StreamFn } from "./agent-loop.ts";

export interface ProviderStreamFnOptions {
  provider: Provider;
  /**
   * Static request auth, or a credential store to resolve fresh auth from on
   * every call (pi getApiKey pattern — OAuth tokens can rotate mid-session).
   */
  auth: ModelAuth | { store: CredentialStore };
  sessionId?: string;
}

/**
 * Create a StreamFn bound to a provider. Honors the loop contract: never
 * throws — failures come back as stopReason "error"/"aborted".
 */
export function createProviderStreamFn(options: ProviderStreamFnOptions): StreamFn {
  const { provider, auth, sessionId } = options;
  return async (context, streamOptions): Promise<AssistantTurn> => {
    try {
      const resolvedAuth =
        "store" in auth
          ? (await resolveProviderAuth(provider, auth.store, { signal: streamOptions.signal }))
              ?.auth
          : auth;
      if (resolvedAuth === undefined) {
        return {
          items: [],
          stopReason: "error",
          errorMessage: `No credentials for provider ${provider.id} — log in first`,
        };
      }
      const thinking = streamOptions.thinkingLevel ?? provider.defaultEffort;
      const result = await streamResponses({
        auth: resolvedAuth,
        api: provider.api,
        baseUrl: provider.baseUrl,
        model: streamOptions.model ?? provider.defaultModel,
        effort: thinking === "off" ? undefined : thinking,
        instructions: context.systemPrompt,
        input: context.messages,
        tools: context.tools,
        sessionId,
        signal: streamOptions.signal,
        onDelta: streamOptions.onDelta,
      });
      return { items: result.items, stopReason: result.stopReason, usage: result.usage };
    } catch (error) {
      return {
        items: [],
        stopReason: streamOptions.signal?.aborted === true ? "aborted" : "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
