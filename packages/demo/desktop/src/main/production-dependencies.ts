import { defaultProviderAuthContext } from "@uji-ai/ai/auth/context";
import { lazyOAuth } from "@uji-ai/ai/auth/helpers";
import { FileCredentialStore } from "@uji-ai/ai/auth/store";
import { createModels } from "@uji-ai/ai/models";
import { openaiCodexProvider } from "@uji-ai/ai/providers/openai-codex";

import { demoAgentDrafts } from "../agents.ts";
import type { UjiDesktopEvent } from "../desktop-api.ts";
import type { UjiHostDependencies } from "./uji-host.ts";

export function createProductionDependencies(
  openExternal: (url: string) => Promise<void>,
  credentialPath?: string,
): UjiHostDependencies {
  const credentials = new FileCredentialStore(credentialPath);
  const models = createModels({ credentials, authContext: defaultProviderAuthContext() });
  const providerDefaults = openaiCodexProvider();
  const defaultOAuth = providerDefaults.auth.oauth;
  if (defaultOAuth === undefined) throw new Error("ChatGPT login is unavailable");
  const provider = {
    ...providerDefaults,
    auth: {
      ...providerDefaults.auth,
      oauth: lazyOAuth({
        name: defaultOAuth.name,
        isSubscription: defaultOAuth.isSubscription,
        loginLabel: defaultOAuth.loginLabel,
        load: () =>
          import("@uji-ai/ai/auth/oauth/openai-codex").then((module) => module.openaiCodexOAuth),
      }),
    },
  };
  models.setProvider(provider);
  const model = models.getModel(provider.id, "gpt-5.6-luna");
  if (model === undefined) throw new Error("OpenAI Codex does not expose gpt-5.6-luna");

  return {
    model,
    models: models.getModels(provider.id),
    initialAgents: demoAgentDrafts,
    thinkingLevel: "medium",
    createStreamFn: () => (requestedModel, context, options) =>
      models.streamSimple(requestedModel, context, options),
    async authStatus() {
      try {
        const auth = await models.getAuth(provider.id);
        return auth === undefined
          ? { signedIn: false, label: "ChatGPT not connected" }
          : { signedIn: true, label: `ChatGPT connected · ${auth.source ?? "OAuth"}` };
      } catch {
        return { signedIn: false, label: "ChatGPT login expired" };
      }
    },
    async login(emit: (event: UjiDesktopEvent) => void) {
      const oauth = provider.auth.oauth;
      if (oauth === undefined) throw new Error("ChatGPT login is unavailable");

      const controller = new AbortController();
      emit({ type: "status", message: "Opening ChatGPT login…" });
      await models.login(provider.id, "oauth", {
        signal: controller.signal,
        prompt: (prompt) => {
          if (prompt.type === "select") return Promise.resolve("browser");
          if (prompt.type === "manual_code") {
            return new Promise<string>((_resolve, reject) => {
              const cancel = (): void => reject(new Error("Browser login finished"));
              if (prompt.signal?.aborted === true) cancel();
              else prompt.signal?.addEventListener("abort", cancel, { once: true });
            });
          }
          return Promise.reject(new Error("This login step is not supported in the desktop app"));
        },
        notify: (event) => {
          if (event.type === "auth_url") void openExternal(event.url);
          if (event.type === "progress" || event.type === "info") {
            emit({ type: "status", message: event.message });
          }
        },
      });
    },
    async logout() {
      await models.logout(provider.id);
    },
  };
}
